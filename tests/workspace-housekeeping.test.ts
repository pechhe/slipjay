import { jj, project } from "./support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, readlinkSync } from "node:fs";
import { chmod, mkdir, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { cleanupLandedWorkspace, createWorkspace, landWorkspace } from "../src/lib/slipjay.mjs";
import { pruneWorkspaceState } from "../src/lib/workspace-state-prune.mjs";
import { landedHome, lockHome, metadataHome, stateHome, workspaceHome } from "../src/lib/workspace-paths.mjs";
import { EMPTY_IDLE_MS, sweepDisposableWorkspaces } from "../src/lib/workspace-sweep.mjs";

const cli = fileURLToPath(new URL("../src/launcher/workspace.mjs", import.meta.url));
const later = () => Date.now() + EMPTY_IDLE_MS + 60_000;
const names = (repo: string) => jj(repo, ["workspace", "list", "-T", 'name ++ "\\n"']).split("\n").filter(Boolean);

function occupy(cwd: string) {
  // Its own process group, like a process another session or terminal started: the caller's group counts as the caller.
  const child = spawn("sleep", ["60"], { cwd, stdio: "ignore", detached: true });
  return { pid: child.pid, dispose: () => child.kill() };
}

async function landedWorkspace(repo: string, task: string, file = `${task}.txt`) {
  const workspace = await createWorkspace(task, repo);
  await writeFile(join(workspace.workspacePath, file), `${file}\n`);
  jj(workspace.workspacePath, ["describe", "-m", `Add ${file}`]);
  const landed = await landWorkspace(workspace.workspacePath, { onProgress: () => {}, releaseLandedWorkspace: false });
  assert.equal(landed.ok, true, JSON.stringify(landed.publication));
  return workspace;
}

/** A pid that has exited. */
async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolveExit) => child.once("exit", resolveExit));
  return child.pid!;
}

test("an edit made after cleanup's checks is kept, not orphaned by the forget", async () => {
  const f = await project();
  try {
    const workspace = await landedWorkspace(f.repo, "race");
    const raced = await cleanupLandedWorkspace(workspace.workspacePath, {
      afterChecks: () => writeFile(join(workspace.workspacePath, "late.txt"), "late\n"),
    });
    assert.deepEqual(raced, { cleaned: false, reason: "working-copy-changed" });
    assert.ok(names(f.repo).includes(workspace.current.name), "the workspace is still registered");
    assert.equal(jj(workspace.workspacePath, ["diff", "-r", "@", "--summary"]), "A late.txt", "the edit sits in the workspace's own commit");
    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: false, reason: "new-unlanded-work" });
  } finally {
    await f.dispose();
  }
}, 120_000);

test("landing removes its own workspace, naming any other process that holds it", async () => {
  const f = await project();
  const holder = { dispose: () => {}, pid: 0 };
  try {
    const gone = await createWorkspace("alone", f.repo);
    await writeFile(join(gone.workspacePath, "alone.txt"), "alone\n");
    jj(gone.workspacePath, ["describe", "-m", "Add alone"]);
    const alone = await landWorkspace(gone.workspacePath, { onProgress: () => {} });
    assert.deepEqual(alone.released, { cleaned: true });
    assert.equal(existsSync(gone.workspacePath), false);
    assert.ok(!names(f.repo).includes(gone.current.name));

    const held = await createWorkspace("held", f.repo);
    Object.assign(holder, occupy(held.workspacePath));
    await writeFile(join(held.workspacePath, "held.txt"), "held\n");
    jj(held.workspacePath, ["describe", "-m", "Add held"]);
    const kept = await landWorkspace(held.workspacePath, { onProgress: () => {} });
    assert.equal(kept.released?.cleaned, false);
    assert.match(kept.released?.reason ?? "", new RegExp(`pid ${holder.pid} \\(sleep\\)`));
    assert.ok(existsSync(held.workspacePath));
    holder.dispose();
    assert.equal((await cleanupLandedWorkspace(held.workspacePath)).cleaned, true, "slipjay cleanup still works as before");
  } finally {
    holder.dispose();
    await f.dispose();
  }
}, 180_000);

test("the CLI's own working directory inside the workspace does not keep it after `slipjay land`, nor does its post-land run", async () => {
  // A declared post-land check starts a detached run during the landing; it must not hold the workspace.
  const f = await project({ policy: { postLandVerification: [{ executable: "node", args: ["-e", "setTimeout(() => {}, 20000)"] }] } });
  try {
    const workspace = await createWorkspace("cli", f.repo);
    await writeFile(join(workspace.workspacePath, "cli.txt"), "cli\n");
    jj(workspace.workspacePath, ["describe", "-m", "Add cli"]);
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolveRun, reject) => {
      execFile(process.execPath, [cli, "land"], { cwd: workspace.workspacePath }, (error, out, err) => (error ? reject(Object.assign(error, { stderr: err })) : resolveRun({ stdout: out, stderr: err })));
    });
    assert.deepEqual(JSON.parse(stdout.slice(stdout.lastIndexOf("\n{\n") + 1)).released, { cleaned: true }, "the JSON result follows the verification progress");
    assert.match(stderr, /Removed landed workspace/);
    assert.equal(existsSync(workspace.workspacePath), false);
  } finally {
    await f.dispose();
  }
}, 180_000);

test("an empty workspace attached to a closed Issue is swept; open, unknown and worked-on ones are kept", async () => {
  const f = await project();
  const path = process.env.PATH;
  try {
    const bin = join(f.root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "gh"), '#!/bin/sh\ncase "$3" in 41|44|45) echo CLOSED;; 42) echo OPEN;; *) echo "gh: unavailable" >&2; exit 1;; esac\n');
    await chmod(join(bin, "gh"), 0o755);
    process.env.PATH = `${bin}:${path}`;
    const closed = await createWorkspace("Issue #41", f.repo, { issueNumber: 41 });
    const open = await createWorkspace("Issue #42", f.repo, { issueNumber: 42 });
    const unknown = await createWorkspace("Issue #43", f.repo, { issueNumber: 43 });
    const worked = await createWorkspace("Issue #44", f.repo, { issueNumber: 44 });
    await writeFile(join(worked.workspacePath, "work.txt"), "work\n");

    const held = await createWorkspace("Issue #45", f.repo, { issueNumber: 45 });
    const holder = occupy(held.workspacePath);
    const swept = await sweepDisposableWorkspaces(f.repo);
    holder.dispose();
    assert.deepEqual(swept.removed, [closed.current.name], "a closed Issue's empty workspace goes at once, without the idle wait");
    assert.equal(existsSync(closed.workspacePath), false);
    assert.match(swept.skipped.find(({ name }) => name === held.current.name)?.reason ?? "", /live process/, "a closed Issue's workspace in use is kept");
    for (const kept of [open, unknown, worked, held]) assert.ok(existsSync(kept.workspacePath), kept.current.name);

    await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
    const offline = await sweepDisposableWorkspaces(f.repo, { now: later() });
    assert.deepEqual(offline.removed, [], "gh failing keeps everything");
  } finally {
    process.env.PATH = path;
    await f.dispose();
  }
}, 120_000);

test("state of vanished workspaces and dead slot owners is pruned; everything undeterminable or in flight is kept", async () => {
  const f = await project();
  const holder = occupy(f.root);
  try {
    const live = await createWorkspace("live", f.repo);
    const dead = await deadPid();
    const integrated = jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]);
    const write = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
    for (const dir of [metadataHome(), lockHome(), landedHome()]) await mkdir(dir, { recursive: true });
    const record = (name: string, extra = {}) => ({ version: 1, workspaceName: name, workspacePath: join(workspaceHome(), name), integrationRoot: f.repo, ...extra });
    const landing = (name: string, extra = {}) => ({ ...record(name), integrationBranch: "main", artifactCommitId: integrated, artifactChangeId: "x", ...extra });

    await write(join(metadataHome(), "ghost.json"), record("ghost", { issueNumber: 9 }));
    await write(join(lockHome(), "ghost.json"), { version: 1, workspaceName: "ghost", pid: dead });
    await write(join(stateHome(), "ghost.json"), landing("ghost", { phase: "landed" }));
    // Kept: in flight, undeterminable or evidence.
    await write(join(metadataHome(), "ghost-spare.json"), record("ghost-spare", { spare: true, prepared: false, preparingPid: process.pid }));
    await write(join(stateHome(), "ghost-prepared.json"), landing("ghost-prepared", { phase: "prepared" }));
    await write(join(stateHome(), "ghost-unproven.json"), landing("ghost-unproven", { phase: "landed", artifactCommitId: "f".repeat(40) }));
    await write(join(metadataHome(), "elsewhere.json"), record("elsewhere", { integrationRoot: join(f.root, "no-such-repo") }));
    await write(join(lockHome(), "ghost-live.json"), { version: 1, workspaceName: "ghost-live", pid: process.pid });
    await write(join(landedHome(), "artifact-abc.json"), landing("ghost", { phase: "landed" }));
    // Verification slots: a dead waiter, a live one, an idle empty directory and a fresh one.
    const slot = (name: string) => join(stateHome(), `verification-slot-${name}.waiting`);
    for (const name of ["a", "b", "c", "d"]) await mkdir(slot(name), { recursive: true });
    await write(join(slot("a"), "x.json"), { id: "x", pid: dead });
    await write(join(slot("b"), "y.json"), { id: "y", pid: holder.pid });
    const old = new Date(Date.now() - 3_600_000);
    await utimes(slot("c"), old, old);

    const removed = await pruneWorkspaceState();
    assert.ok(removed.includes("workspaces/ghost.json") || removed.some((path) => path.endsWith("ghost.json")), JSON.stringify(removed));
    for (const gone of [join(metadataHome(), "ghost.json"), join(lockHome(), "ghost.json"), join(stateHome(), "ghost.json"), join(slot("a"), "x.json"), slot("c")]) {
      assert.equal(existsSync(gone), false, gone);
    }
    for (const kept of [join(metadataHome(), "ghost-spare.json"), join(stateHome(), "ghost-prepared.json"), join(stateHome(), "ghost-unproven.json"),
      join(metadataHome(), "elsewhere.json"), join(lockHome(), "ghost-live.json"), join(landedHome(), "artifact-abc.json"),
      join(metadataHome(), `${live.current.name}.json`), join(slot("b"), "y.json"), slot("d")]) {
      assert.equal(existsSync(kept), true, kept);
    }
    assert.ok((await readdir(landedHome())).some((file) => file.startsWith("artifact-") && file !== "artifact-abc.json"), "the ghost's integrated delivery was archived before its sidecar went");
  } finally {
    holder.dispose();
    await f.dispose();
  }
}, 120_000);

test("a workspace linked to a shared path in the primary checkout is still released by cleanup", async () => {
  const f = await project({ ignore: "artifacts/\n", policy: { sharedPaths: ["artifacts"] } });
  try {
    const workspace = await createWorkspace("shared", f.repo);
    const link = join(workspace.workspacePath, "artifacts");
    assert.equal(readlinkSync(link), join(f.repo, "artifacts"));
    await writeFile(join(link, "report.json"), "{}\n");
    await writeFile(join(workspace.workspacePath, "shared.txt"), "shared\n");
    jj(workspace.workspacePath, ["describe", "-m", "Add shared"]);
    const landed = await landWorkspace(workspace.workspacePath, { onProgress: () => {}, releaseLandedWorkspace: false });
    assert.equal(landed.ok, true);
    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: true });
    assert.equal(existsSync(join(f.repo, "artifacts", "report.json")), true, "the primary's artifacts outlive the workspace");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("shared paths are linked once, replace an empty directory and never clobber content", async () => {
  const f = await project({ ignore: "artifacts/\ncache/\n", policy: { sharedPaths: ["artifacts", "out/reports", "cache"] } });
  try {
    const workspace = await createWorkspace("links", f.repo);
    for (const path of ["artifacts", "out/reports", "cache"]) assert.equal(readlinkSync(join(workspace.workspacePath, path)), join(f.repo, path), path);
    assert.ok(existsSync(join(f.repo, "out", "reports")), "the target directory is created in the primary");
    const { linkSharedPaths } = await import("../src/lib/workspace-shared-paths.mjs");
    assert.deepEqual((await linkSharedPaths(f.repo, workspace.workspacePath)).map(({ status }) => status), ["linked", "linked", "linked"], "idempotent");
    // A real directory: empty is replaced, with content it is left alone.
    const other = join(f.root, "other");
    await mkdir(join(other, "artifacts"), { recursive: true });
    await mkdir(join(other, "cache"), { recursive: true });
    await writeFile(join(other, "cache", "keep.txt"), "mine\n");
    const results = await linkSharedPaths(f.repo, other);
    assert.deepEqual(Object.fromEntries(results.map(({ path, status }) => [path, status])), { artifacts: "linked", "out/reports": "linked", cache: "kept" });
    assert.equal(existsSync(join(other, "cache", "keep.txt")), true);
  } finally {
    await f.dispose();
  }
}, 120_000);
