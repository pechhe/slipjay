import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { planDisposableWorkspaces, sweepDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { landedHome } from "../../src/lib/workspace/workspace-paths.ts";
import { readLandingState } from "../../src/lib/workspace/workspace-state.ts";
import { removeWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { workspaceCoverage } from "../../src/lib/workspace/workspace-coverage.ts";
import { workspaceContext } from "../../src/lib/infra/workspace-jj.ts";
import { byName, landed, later } from "./fixtures/workspace-retention-plan-fixture.ts";
import { seedWorkspace } from "./fixtures/workspace-generation.ts";

// A landing that runs on a remote runner archives its evidence in the runner's state home, so the
// machine holding the checkout never sees an `artifact-*` record. Without one, `workspaceCoverage`
// read every landed checkout as uncovered, and the sweep pinned it as "unlanded work" for ever.

// One landed record naming a commit this repository does not hold (a delivery recorded on another
// machine) failed the whole covering revset, so `remove` and housekeeping failed for every checkout
// in the repository with "Revision ... doesn't exist", not just for that record's.
test("a landed record naming a revision this repository lacks proves nothing and stops nothing", async () => {
  const f = await project();
  const elsewhere = "c68fc4694318fa8bcd9e5ea7ab4c57f425ff5bc4";
  const record = join(landedHome(), `artifact-${"a".repeat(64)}.json`);
  const said: unknown[][] = [];
  const note = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { said.push(args); });
  try {
    // A checkout based on a published source: its own work is covered only through that record.
    const delivered = await landed(f, "delivered.txt");
    const published = (await readLandingState(delivered.current.name, { readOnly: true }))?.publishedSource;
    const source = typeof published === "string" ? published : "";
    assert.match(source, /^[a-f0-9]{40}$/, "the landed fixture names the source it published");
    const covered = await seedWorkspace("covered", f.repo, { base: source });
    await writeFile(record, JSON.stringify({
      version: 1, phase: "landed", workspaceName: "elsewhere", integrationBranch: "main",
      integrationRoot: f.repo, artifactCommitId: elsewhere,
      coverageRepository: await realpath(jj(f.repo, ["git", "root"])), publishedSource: elsewhere,
    }));
    // Before the fix this threw the unresolvable record's jj error instead of judging the checkout.
    const context = await workspaceContext(covered.workspacePath);
    assert.ok(context);
    assert.equal(await workspaceCoverage(context, covered.current.name, "@", covered.workspacePath), "source-covered");
    await removeWorkspace(f.repo, covered.current.name);
    assert.ok(!existsSync(covered.workspacePath));
    // The unresolvable record is named once for the whole run, not once per checkout it cannot vouch for.
    const notes = said.filter((args) => String(args[0]).includes(elsewhere));
    assert.equal(notes.length, 1, `the skipped record is named once: ${JSON.stringify(said)}`);
  } finally {
    note.mockRestore();
    await rm(record, { force: true });
    await f.dispose();
  }
}, 120_000);

test("a workspace whose landing evidence stayed on the runner is still releasable here", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "delivered.txt");
    await rm(landedHome(), { recursive: true, force: true });
    const planned = byName(await planDisposableWorkspaces(f.repo, { now: later() }))[workspace.current.name];
    assert.equal(planned?.action, "remove", planned?.reason ?? "");
    const swept = await sweepDisposableWorkspaces(f.repo, { now: later() });
    assert.ok(swept.removed.includes(workspace.current.name), JSON.stringify(swept.skipped));
    assert.ok(!existsSync(workspace.workspacePath));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("work the landing never delivered keeps the workspace, without an archive to say otherwise", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "delivered.txt");
    await rm(landedHome(), { recursive: true, force: true });
    await writeFile(join(workspace.workspacePath, "later.txt"), "work after the landing\n");
    const planned = byName(await planDisposableWorkspaces(f.repo, { now: later() }))[workspace.current.name];
    assert.equal(planned?.action, "keep");
    const swept = await sweepDisposableWorkspaces(f.repo, { now: later() });
    assert.ok(!swept.removed.includes(workspace.current.name));
    assert.ok(existsSync(join(workspace.workspacePath, "later.txt")));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a path the integration branch already holds is not work the landing missed", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "delivered.txt");
    await rm(landedHome(), { recursive: true, force: true });
    // The branch moves on with content this checkout holds too, so the checkout's copy of it is not its work.
    await writeFile(join(f.repo, "shared.txt"), "shared.txt\n");
    jj(f.repo, ["bookmark", "set", "main", "-r", "@"]);
    await writeFile(join(workspace.workspacePath, "shared.txt"), "shared.txt\n");
    // The plan cannot snapshot, so the unwritten edit keeps it there; the sweep snapshots and judges it.
    const planned = byName(await planDisposableWorkspaces(f.repo, { now: later() }))[workspace.current.name];
    assert.equal(planned?.action, "keep");
    const swept = await sweepDisposableWorkspaces(f.repo, { now: later() });
    assert.ok(swept.removed.includes(workspace.current.name), JSON.stringify(swept.skipped));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a landed file the checkout deleted is work, even though the range's net diff hides it", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "delivered.txt");
    await rm(landedHome(), { recursive: true, force: true });
    // The deletion cancels the commit's own addition, so no diff of the range or of that commit names the path.
    await rm(join(workspace.workspacePath, "delivered.txt"));
    const swept = await sweepDisposableWorkspaces(f.repo, { now: later() });
    assert.ok(!swept.removed.includes(workspace.current.name), "a deleted delivered file must keep the workspace");
    assert.ok(existsSync(workspace.workspacePath));
    assert.ok(!existsSync(join(workspace.workspacePath, "delivered.txt")));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("an executable bit the landing never delivered is work, though the bytes match", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "delivered.script");
    await rm(landedHome(), { recursive: true, force: true });
    await chmod(join(workspace.workspacePath, "delivered.script"), 0o755);
    const swept = await sweepDisposableWorkspaces(f.repo, { now: later() });
    assert.ok(!swept.removed.includes(workspace.current.name), "a mode change must keep the workspace");
    assert.ok(existsSync(workspace.workspacePath));
  } finally {
    await f.dispose();
  }
}, 120_000);
