import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { readAttempt, releaseAttempt } from "../../src/lib/workspace/workspace-attempts.ts";
import { removeWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { pruneWorkspaceState } from "../../src/lib/workspace/workspace-state-prune.ts";
import { attemptHome } from "../../src/lib/workspace/workspace-paths.ts";
import { metadataPath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { withWorkspaceTransaction } from "../../src/lib/infra/workspace-transaction.ts";

const BUN_VERSION = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
const failingPrepare = { prepare: async (): Promise<never> => { throw new Error("install failed"); } };
const names = (repo: string) => jj(repo, ["workspace", "list", "-T", 'name ++ "\\n"']).split("\n").filter(Boolean);

function runCli(cwd: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    execFile("bun", [cli, ...args], { cwd }, (error, stdout, stderr) =>
      resolveRun({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

/** A process id that no longer runs, as a start's would after the process died. */
function deadPid() {
  return spawnSync("true").pid!;
}

test("a start that fails after allocating leaves an attempt naming its checkout, and releasing it removes only that", async () => {
  const f = await project();
  try {
    // First, on fresh machine state: nothing has made the metadata directory yet.
    await assert.rejects(createWorkspace("broken", f.repo, { attemptId: "a-1", hooks: failingPrepare }), /install failed/);
    const other = await createWorkspace("other", f.repo);
    const attempt = await readAttempt("a-1");
    assert.equal(attempt?.status, "failed");
    assert.equal(attempt?.owned, true);
    assert.equal(attempt?.error, "install failed");
    assert.ok(attempt?.workspacePath && existsSync(attempt.workspacePath), "the checkout the failed start allocated is named");
    await assert.rejects(createWorkspace("again", f.repo, { attemptId: "a-1" }), /already exists/, "an attempt id names one start");

    assert.deepEqual(await releaseAttempt("a-1"), { released: true, removed: attempt.workspaceName });
    assert.equal(existsSync(attempt.workspacePath), false);
    assert.equal(await readAttempt("a-1"), null, "a released attempt is forgotten");
    assert.ok(existsSync(other.workspacePath), "another workspace is untouched");
    assert.deepEqual(await releaseAttempt("a-1"), { released: false, reason: "unknown attempt" });
  } finally {
    await f.dispose();
  }
}, 120_000);

test("an interrupted start is recoverable after a restart, but a running one is not released", async () => {
  const f = await project();
  let finish = () => {};
  try {
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const running = createWorkspace("slow", f.repo, { attemptId: "a-2", hooks: { prepare: async () => { await held; return {}; } } });
    let attempt = await readAttempt("a-2");
    for (const deadline = Date.now() + 30_000; attempt?.status !== "preparing"; attempt = await readAttempt("a-2")) {
      assert.ok(Date.now() < deadline, `the start reached preparation: ${JSON.stringify(attempt)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(attempt.interrupted, false);
    assert.deepEqual(await releaseAttempt("a-2"), { released: false, reason: "the start is still running" });

    // As if the starting process had died before printing its receipt: only the record survives the restart.
    const path = join(attemptHome(), "a-2.json");
    const record = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...record, pid: deadPid() }));
    const recovered = await readAttempt("a-2");
    assert.equal(recovered?.interrupted, true);
    assert.equal(recovered?.workspacePath, attempt.workspacePath);
    assert.deepEqual(await releaseAttempt("a-2"), { released: true, removed: attempt.workspaceName });
    assert.equal(existsSync(attempt.workspacePath!), false);
    finish();
    await running.catch(() => undefined);
  } finally {
    finish();
    await f.dispose();
  }
}, 120_000);

test("release never removes a resumed Issue's checkout, a checkout in use, or one that acquired work", async () => {
  const f = await project({ ignore: "notes/\n" });
  const stops: Array<() => void> = [];
  try {
    // Attempt b-1 created Issue #41's checkout and failed; b-2 then resumed it.
    await assert.rejects(createWorkspace("Issue #41", f.repo, { issueNumber: 41, attemptId: "b-1", hooks: failingPrepare }));
    const resumed = await createWorkspace("Issue #41", f.repo, { issueNumber: 41, attemptId: "b-2" });
    assert.equal(resumed.reused, true);
    assert.equal((await readAttempt("b-2"))?.owned, false);
    assert.deepEqual(await releaseAttempt("b-1"), { released: true, removed: null, reason: "the checkout is no longer this attempt's" });
    assert.deepEqual(await releaseAttempt("b-2"), { released: true, removed: null, reason: "the checkout was bound or resumed, not created by this attempt" });
    assert.ok(names(f.repo).includes(resumed.current.name), "the resumed Issue checkout is kept");

    await assert.rejects(createWorkspace("busy", f.repo, { attemptId: "b-3", hooks: failingPrepare }));
    const busy = (await readAttempt("b-3"))!;
    const child = spawn("sleep", ["60"], { cwd: busy.workspacePath, stdio: "ignore" });
    stops.push(() => child.kill());
    assert.match((await releaseAttempt("b-3") as { reason: string }).reason, /live process/);
    assert.ok(await readAttempt("b-3"), "a refused release keeps the attempt for a retry");

    await assert.rejects(createWorkspace("worked", f.repo, { attemptId: "b-4", hooks: failingPrepare }));
    const worked = (await readAttempt("b-4"))!;
    await writeFile(join(worked.workspacePath!, "work.txt"), "work\n");
    jj(worked.workspacePath!, ["commit", "-m", "Work"]);
    assert.match((await releaseAttempt("b-4") as { reason: string }).reason, /unlanded work/);
    assert.ok(existsSync(join(worked.workspacePath!, "work.txt")));
  } finally {
    for (const stop of stops) stop();
    await f.dispose();
  }
}, 180_000);

test("a caller that lost the receipt finds the checkout by its attempt id", async () => {
  const f = await project();
  try {
    const started = await runCli(f.repo, ["start", "--json", "--attempt", "c-1", "lost receipt"]);
    assert.equal(started.code, 0, started.stderr);
    const receipt = JSON.parse(started.stdout);
    assert.equal(receipt.attemptId, "c-1");
    const shown = await runCli(f.repo, ["attempt", "show", "c-1"]);
    assert.equal(shown.code, 0, shown.stderr);
    const attempt = JSON.parse(shown.stdout);
    assert.equal(attempt.status, "ready");
    assert.equal(attempt.workspacePath, receipt.workspacePath, "the attempt names the checkout the receipt would have");
    const released = await runCli(f.repo, ["attempt", "release", "c-1"]);
    assert.equal(released.code, 0, released.stderr);
    assert.deepEqual(JSON.parse(released.stdout), { released: true, removed: receipt.workspaceName });
    assert.notEqual((await runCli(f.repo, ["start", "--attempt", "../escape", "task"])).code, 0, "an attempt id is a plain token");

    // An attempt outlives its checkout only until housekeeping sees the checkout gone.
    const kept = await createWorkspace("kept", f.repo, { attemptId: "c-2" });
    await removeWorkspace(f.repo, kept.current.name);
    assert.ok(await readAttempt("c-2"));
    await pruneWorkspaceState();
    assert.equal(await readAttempt("c-2"), null);
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a start killed while installing leaves an interrupted attempt that releases its checkout", async () => {
  const f = await project({ ignore: "node_modules\n" });
  const hold = join(f.root, "hold-install");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    // The install's postinstall waits while `hold` exists, so the start is caught mid-preparation.
    await writeFile(join(f.repo, "package.json"), JSON.stringify({ name: "fixture", private: true, packageManager: `bun@${BUN_VERSION}`, scripts: { postinstall: "node hold.mjs" } }));
    await writeFile(join(f.repo, "hold.mjs"), `import { existsSync } from "node:fs";\nwhile (existsSync(${JSON.stringify(hold)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);\n`);
    execFileSync("bun", ["install"], { cwd: f.repo, stdio: "pipe" });
    jj(f.repo, ["commit", "-m", "Add an install"]);
    jj(f.repo, ["bookmark", "set", "main", "-r", "@-"]);
    await writeFile(hold, "");
    child = spawn("bun", [cli, "start", "--attempt", "d-1", "killed"], { cwd: f.repo, stdio: "ignore", detached: true });
    let attempt = await readAttempt("d-1");
    for (const deadline = Date.now() + 60_000; attempt?.status !== "preparing"; attempt = await readAttempt("d-1")) {
      assert.ok(Date.now() < deadline, `the start reached preparation: ${JSON.stringify(attempt)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    process.kill(-child.pid!, "SIGKILL");
    for (const deadline = Date.now() + 30_000; !(await readAttempt("d-1"))?.interrupted;) {
      assert.ok(Date.now() < deadline, "the killed start reads as interrupted");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await rm(hold, { force: true });
    const released = await releaseAttempt("d-1");
    assert.deepEqual(released, { released: true, removed: attempt.workspaceName });
    assert.equal(existsSync(attempt.workspacePath!), false);
  } finally {
    await rm(hold, { force: true });
    if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
    await f.dispose();
  }
}, 180_000);

test("an attempt id is taken once even by concurrent starts, and release waits out a concurrent allocation", async () => {
  const f = await project();
  try {
    const outcomes = await Promise.allSettled([
      createWorkspace("first", f.repo, { attemptId: "e-1", hooks: failingPrepare }),
      createWorkspace("second", f.repo, { attemptId: "e-1", hooks: failingPrepare }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected" && /already exists/.test(String(outcome.reason))).length, 1, "exactly one start was refused the id");
    const attempt = (await readAttempt("e-1"))!;

    // A start that binds or resumes the checkout holds the allocation lock; a release arriving meanwhile waits
    // for it, then sees the checkout is no longer this attempt's.
    let release: Promise<unknown> | undefined;
    await withWorkspaceTransaction(`allocate:${attempt.integrationRoot}`, async () => {
      release = releaseAttempt("e-1");
      await new Promise((resolve) => setTimeout(resolve, 500));
      await writeFile(metadataPath(attempt.workspaceName!), JSON.stringify({ ...await workspaceMetadata(attempt.workspaceName!), allocationAttempt: null }));
    });
    assert.deepEqual(await release, { released: true, removed: null, reason: "the checkout is no longer this attempt's" });
    assert.ok(existsSync(attempt.workspacePath!), "the resumed checkout is kept");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a checkout whose creator died before marking it is still that attempt's", async () => {
  const f = await project();
  try {
    await assert.rejects(createWorkspace("unmarked", f.repo, { attemptId: "g-1", hooks: failingPrepare }));
    const attempt = (await readAttempt("g-1"))!;
    const { allocationAttempt: _marker, ...metadata } = (await workspaceMetadata(attempt.workspaceName!))!;
    await writeFile(metadataPath(attempt.workspaceName!), JSON.stringify(metadata));
    const path = join(attemptHome(), "g-1.json");
    const record = JSON.parse(await readFile(path, "utf8"));
    // Failed, the start ended normally: it would have marked anything it created, so an unmarked checkout is not its.
    assert.deepEqual(await releaseAttempt("g-1"), { released: true, removed: null, reason: "the checkout is no longer this attempt's" });
    assert.ok(existsSync(attempt.workspacePath!));
    // Died mid-allocation instead: the unmarked checkout it named is its own.
    await mkdir(attemptHome(), { recursive: true });
    await writeFile(path, JSON.stringify({ ...record, status: "allocating", pid: deadPid() }));
    assert.deepEqual(await releaseAttempt("g-1"), { released: true, removed: attempt.workspaceName });
    assert.equal(existsSync(attempt.workspacePath!), false);
  } finally {
    await f.dispose();
  }
}, 120_000);
