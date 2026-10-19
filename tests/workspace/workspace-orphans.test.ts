import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace, planDisposableWorkspaces, sweepDisposableWorkspaces } from "../../src/lib/slipjay.ts";
import type { PlannedWorkspace } from "../../src/lib/slipjay.ts";
import { landedHome, machineConfigPath, stateHome, workspaceHome } from "../../src/lib/workspace/workspace-paths.ts";
import { findOrphanedCheckouts, ORPHAN_MIN_AGE_MS } from "../../src/lib/workspace/workspace-orphans.ts";
import { pruneWorkspaceState } from "../../src/lib/workspace/workspace-state-prune.ts";
import { lockPath, metadataPath } from "../../src/lib/workspace/workspace-state.ts";
import { EMPTY_IDLE_MS } from "../../src/lib/workspace/workspace-sweep.ts";

/** Late enough that idle workspaces and old orphans both qualify. */
const later = () => Date.now() + Math.max(EMPTY_IDLE_MS, ORPHAN_MIN_AGE_MS) + 60_000;
const byName = (plan: PlannedWorkspace[]) => Object.fromEntries(plan.map((entry) => [entry.name, entry]));
const registered = (repo: string) => jj(repo, ["workspace", "list", "-T", 'name ++ "\\n"']).split("\n");

test("machine state and workspace storage live under the disposable HOME", () => {
  assert.notEqual(homedir(), userInfo().homedir);
  for (const path of [stateHome(), workspaceHome(), machineConfigPath()]) assert.ok(path.startsWith(`${homedir()}/`), path);
});

test("a broken working copy is kept with what to do, and a missing checkout is forgotten only when it holds no work", async () => {
  const f = await project();
  try {
    const broken = await createWorkspace("broken", f.repo);
    const vanished = await createWorkspace("vanished", f.repo);
    const vanishedWithWork = await createWorkspace("vanished with work", f.repo);
    const vanishedOwing = await createWorkspace("vanished owing", f.repo);
    await writeFile(metadataPath(vanishedOwing.current.name), JSON.stringify({ ...JSON.parse(await readFile(metadataPath(vanishedOwing.current.name), "utf8")), pendingRunnerFacts: [{ id: "pending" }] }));
    await rm(vanishedOwing.workspacePath, { recursive: true, force: true });
    const vanishedOwned = await createWorkspace("vanished owned", f.repo);
    await mkdir(join(lockPath(vanishedOwned.current.name), ".."), { recursive: true });
    await writeFile(lockPath(vanishedOwned.current.name), JSON.stringify({ version: 1, pid: process.pid }));
    await rm(vanishedOwned.workspacePath, { recursive: true, force: true });
    await writeFile(join(broken.workspacePath, ".jj", "working_copy", "checkout"), "garbage");
    await writeFile(join(vanishedWithWork.workspacePath, "work.txt"), "unlanded\n");
    jj(vanishedWithWork.workspacePath, ["status"]);
    await rm(vanished.workspacePath, { recursive: true, force: true });
    await rm(vanishedWithWork.workspacePath, { recursive: true, force: true });

    const options = { now: later() };
    const entries = byName(await planDisposableWorkspaces(f.repo, options));
    const brokenEntry = entries[broken.current.name];
    assert.equal(brokenEntry?.state, "broken");
    assert.equal(brokenEntry?.action, "keep");
    assert.match(brokenEntry?.reason ?? "", /working copy unreadable \(.*checkout state.*\): run `jj workspace update-stale`/);
    assert.equal(entries[vanished.current.name]?.state, "missing");
    assert.equal(entries[vanished.current.name]?.action, "remove");
    assert.equal(entries[vanishedWithWork.current.name]?.state, "missing");
    assert.equal(entries[vanishedWithWork.current.name]?.action, "keep");
    assert.match(entries[vanishedWithWork.current.name]?.reason ?? "", /unintegrated work/);
    assert.equal(entries[vanishedOwing.current.name]?.action, "keep");
    assert.match(entries[vanishedOwing.current.name]?.reason ?? "", /pending runner facts/);
    assert.equal(entries[vanishedOwned.current.name]?.action, "keep");
    assert.match(entries[vanishedOwned.current.name]?.reason ?? "", /owned by a live process/);

    const swept = await sweepDisposableWorkspaces(f.repo, options);
    assert.ok(swept.removed.includes(vanished.current.name));
    assert.ok(!registered(f.repo).includes(vanished.current.name), "the missing checkout is forgotten");
    assert.ok(!existsSync(metadataPath(vanished.current.name)), "with its state");
    assert.ok(registered(f.repo).includes(vanishedWithWork.current.name), "a missing checkout with work stays registered");
    assert.ok(registered(f.repo).includes(vanishedOwing.current.name), "one that owes the runner facts stays registered");
    assert.ok(registered(f.repo).includes(vanishedOwned.current.name), "one a live process owns stays registered");
    assert.ok(existsSync(metadataPath(vanishedOwing.current.name)), "with the facts it owes");
    assert.ok(registered(f.repo).includes(broken.current.name));
    assert.ok(existsSync(broken.workspacePath), "a broken checkout is never deleted");
    assert.match(swept.skipped.find((skip) => skip.name === broken.current.name)?.reason ?? "", /working copy unreadable/);
  } finally {
    await f.dispose();
  }
});

test("a workspace whose metadata is missing is judged from its checkout: retired when unused and empty, kept with work", async () => {
  const f = await project();
  try {
    const unused = await createWorkspace("no metadata", f.repo);
    const working = await createWorkspace("no metadata with work", f.repo);
    await writeFile(join(working.workspacePath, "work.txt"), "unlanded\n");
    jj(working.workspacePath, ["status"]);
    for (const workspace of [unused, working]) await rm(metadataPath(workspace.current.name));

    const options = { now: later() };
    const entries = byName(await planDisposableWorkspaces(f.repo, options));
    assert.equal(entries[unused.current.name]?.action, "remove");
    assert.equal(entries[unused.current.name]?.reason, "unused and empty");
    assert.equal(entries[working.current.name]?.action, "keep");
    assert.equal(entries[working.current.name]?.reason, "unlanded work");

    const swept = await sweepDisposableWorkspaces(f.repo, options);
    assert.ok(swept.removed.includes(unused.current.name));
    assert.ok(!existsSync(unused.workspacePath));
    assert.ok(existsSync(join(working.workspacePath, "work.txt")));
  } finally {
    await f.dispose();
  }
});

test("an orphan converges only when it is old, unused and holds nothing but reproducible output", async () => {
  const f = await project();
  const orphan = async (name: string, files: Record<string, string>) => {
    const root = join(workspaceHome(), name);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
    return root;
  };
  try {
    const dependencies = await orphan("orphan-dependencies", { "node_modules/pkg/index.js": "x\n" });
    // History of its own is never reproducible output.
    await orphan("orphan-git", { ".git/HEAD": "ref: refs/heads/main\n" });
    await orphan("orphan-store", { ".jj/repo/store/type": "git\n" });
    await orphan("orphan-nested-git", { "vendor/lib/.git/HEAD": "ref: refs/heads/main\n" });
    const notes = await orphan("orphan-notes", { "node_modules/pkg/index.js": "x\n", "notes.txt": "mine\n" });
    const forgotten = await createWorkspace("forgotten", f.repo);
    jj(f.repo, ["workspace", "forget", forgotten.current.name]);

    const orphans = async (now: number) => Object.fromEntries((await findOrphanedCheckouts({ now })).map((entry) => [entry.name, entry]));
    const young = await orphans(Date.now());
    assert.equal(young["orphan-dependencies"]?.action, "keep", "a young orphan may be a checkout being added");
    assert.match(young["orphan-dependencies"]?.reason ?? "", /created recently/);

    const found = await orphans(later());
    assert.equal(found["orphan-dependencies"]?.kind, "no-identity");
    assert.equal(found["orphan-dependencies"]?.action, "remove");
    assert.equal(found["orphan-notes"]?.action, "keep");
    assert.equal(found["orphan-git"]?.action, "keep");
    assert.match(found["orphan-git"]?.reason ?? "", /\.git/);
    assert.equal(found["orphan-store"]?.action, "keep");
    assert.equal(found["orphan-nested-git"]?.action, "keep");
    assert.match(found["orphan-nested-git"]?.reason ?? "", /vendor\/lib\/\.git/);

    assert.match(found["orphan-notes"]?.reason ?? "", /notes\.txt.*copy out anything needed/);
    const forgottenEntry = Object.values(found).find((entry) => entry.root.endsWith(forgotten.workspacePath.split("/").pop()!));
    assert.equal(forgottenEntry?.kind, "unregistered");
    assert.equal(forgottenEntry?.action, "keep", "a forgotten checkout's files cannot be checked against history");

    const plan = await planDisposableWorkspaces(f.repo, { now: later() });
    const mine = new Set([forgottenEntry!.name, "orphan-dependencies", "orphan-notes"]);
    assert.deepEqual(Object.fromEntries(plan.filter((entry) => entry.state === "orphan" && mine.has(entry.name)).map((entry) => [entry.name, entry.action])),
      { [forgottenEntry!.name]: "keep", "orphan-dependencies": "remove", "orphan-notes": "keep" });

    const swept = await sweepDisposableWorkspaces(f.repo, { now: later() });
    assert.deepEqual(swept.orphans, [found["orphan-dependencies"]!.root]);
    assert.ok(!existsSync(dependencies));
    assert.ok(existsSync(notes));
    assert.ok(existsSync(forgotten.workspacePath));
  } finally {
    await f.dispose();
    for (const name of ["orphan-notes", "orphan-git", "orphan-store", "orphan-nested-git"]) await rm(join(workspaceHome(), name), { recursive: true, force: true });
  }
});

test("state for a repository that no longer exists, and a vanished fixture's artifact evidence, converge", async () => {
  const f = await project();
  try {
    const gone = join(tmpdir(), `slipjay-gone-${process.pid}`);
    await writeFile(metadataPath("ghost"), JSON.stringify({ version: 1, integrationRoot: gone, workspacePath: join(workspaceHome(), "ghost") }));
    // A repository whose parent is missing too may sit on an unmounted volume: unknown, so kept.
    const unmounted = join(tmpdir(), `slipjay-volume-${process.pid}`, "repo");
    await writeFile(metadataPath("unmounted"), JSON.stringify({ version: 1, integrationRoot: unmounted, workspacePath: join(workspaceHome(), "unmounted") }));
    await mkdir(landedHome(), { recursive: true });
    const fixture = join(landedHome(), "artifact-fixture.json");
    const kept = join(landedHome(), "artifact-kept.json");
    const realGone = join(landedHome(), "artifact-real.json");
    await writeFile(fixture, JSON.stringify({ integrationRoot: join(tmpdir(), `peach-rollover-${process.pid}`, "repo") }));
    await writeFile(kept, JSON.stringify({ integrationRoot: f.repo }));
    await writeFile(realGone, JSON.stringify({ integrationRoot: gone }));

    const pruned = await pruneWorkspaceState();
    assert.ok(pruned.some((path) => path.endsWith("ghost.json")), pruned.join(", "));
    assert.ok(!existsSync(metadataPath("ghost")));
    assert.ok(existsSync(metadataPath("unmounted")), "a repository that may be on an unmounted volume keeps its records");
    assert.ok(!existsSync(fixture), "evidence of a fixture repository gone from the temporary directory is removed");
    assert.equal(JSON.parse(await readFile(kept, "utf8")).integrationRoot, f.repo, "evidence of a repository that exists is kept");
    assert.ok(existsSync(realGone), "evidence of a real repository that lived in the temporary directory is kept");
  } finally {
    await f.dispose();
  }
});

test("checkouts of a repository whose workspaces cannot be listed are unknown, never orphans", async () => {
  const f = await project();
  try {
    const workspace = await createWorkspace("listed", f.repo);
    await rm(join(workspace.workspacePath, "README.md"));
    await writeFile(join(f.repo, ".jj", "repo", "store", "type"), "broken\n");
    const found = (await findOrphanedCheckouts({ now: later() })).find((entry) => entry.root.endsWith(workspace.workspacePath.split("/").pop()!));
    assert.equal(found?.action, "keep");
    assert.match(found?.reason ?? "", /cannot be listed/);
  } finally {
    await f.dispose();
  }
});
