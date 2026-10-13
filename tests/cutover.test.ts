import { jj, landThroughTestRunner, project } from "./support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { beforeEach, test } from "vite-plus/test";
import { assertHermeticHome } from "../scripts/hermetic-home-guard.ts";
import { cutover } from "../src/lib/cutover.ts";
import { cleanupLandedWorkspace, createWorkspace, readWorkspaceMode } from "../src/lib/slipjay.ts";
import { CUTOVER_REQUIRED_CODE, cutoverMarkerPath, legacyModePath, legacyStateHome, legacyWorkspaceHome, slipjayHome } from "../src/lib/workspace-paths.ts";

// Every case builds pre-v1.0.0 state in this file's disposable HOME and cuts it
// over; the guard below makes sure that HOME is never the developer's own.
assertHermeticHome();

const cli = fileURLToPath(new URL("../src/launcher/workspace.ts", import.meta.url));
type Run = { code: number; stdout: string; stderr: string };
const run = (executable: string, args: string[], cwd = homedir()) => new Promise<Run>((resolveRun) => {
  execFile(executable, args, { cwd, env: process.env, timeout: 120_000 }, (error, stdout, stderr) => {
    resolveRun({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
  });
});
const slipjay = (args: string[], cwd?: string) => run("bun", [cli, ...args], cwd);

const legacy = (...parts: string[]) => join(legacyStateHome(), ...parts);
const writeJson = async (file: string, value: unknown) => {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(value));
};

/** A machine as Slipway left it: state and mode file under ~/.slipway. */
async function legacyMachine() {
  await writeJson(legacyModePath(), { version: 1, mode: "direct" });
  await writeJson(legacy("workspaces", "spare.json"), { version: 1, workspaceName: "spare" });
  await writeJson(legacy("post-land", "abc.json"), { version: 1, commit: "abc", status: "passed", log: legacy("post-land", "abc.log"), finishedAt: "2026-10-01T00:00:00.000Z" });
  await writeFile(legacy("post-land", "abc.log"), "ok\n");
}

beforeEach(async () => {
  await rm(join(homedir(), ".slipway"), { recursive: true, force: true });
  await rm(slipjayHome(), { recursive: true, force: true });
});

test("before the cutover only status and cutover run, and the library refuses", async () => {
  await legacyMachine();
  const start = await slipjay(["start", "task"]);
  assert.equal(start.code, 1);
  assert.match(start.stderr, /slipjay start refused: .*slipjay state.*Run `slipjay cutover`/);
  const status = await slipjay(["status"]);
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).cutover, { required: true, legacyState: legacyStateHome(), command: "slipjay cutover" });
  await assert.rejects(readWorkspaceMode(), (error: NodeJS.ErrnoException) => error.code === CUTOVER_REQUIRED_CODE && /slipjay cutover/.test(error.message));
  assert.equal(existsSync(slipjayHome()), false, "nothing was written to the new store");
});

test("the cutover refuses, naming each holder, while locks, slots, writers or runs are live", async () => {
  await legacyMachine();
  const transaction = legacy("transactions", "0123abcd");
  await mkdir(join(transaction, ".."), { recursive: true });
  const releaseTransaction = await lockfile.lock(transaction, { realpath: false, stale: 120_000, update: 10_000 });
  const slot = legacy("verification-slot-feedface");
  const releaseSlot = await lockfile.lock(slot, { realpath: false, stale: 60_000, update: 15_000 });
  await writeJson(`${slot}.holder.json`, { id: "x", pid: process.pid, since: Date.now(), label: "jj:busy" });
  await writeJson(legacy("locks", "default@0123456789abcdef.json"), { version: 1, kind: "primary-checkout", pid: process.pid, surface: "local", owner: "thread:a", workspacePath: "/repo" });
  await writeJson(legacy("post-land", "def.json"), { version: 1, commit: "def", status: "running", log: legacy("post-land", "def.log") });
  await writeFile(legacy("post-land", "def.pid"), String(process.pid));
  // Stale evidence never blocks: a dead holder's lock and a finished run.
  const dead = legacy("transactions", "dead");
  await mkdir(`${dead}.lock`, { recursive: true });
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(`${dead}.lock`, old, old);
  await writeJson(legacy("locks", "default@dead.json"), { version: 1, pid: 2_147_483_646 });
  try {
    const refused = await slipjay(["cutover"]);
    assert.equal(refused.code, 1);
    const result = JSON.parse(refused.stdout);
    assert.equal(result.status, "refused");
    const holders = result.holders.join("\n");
    assert.match(holders, /landing transaction transactions\/0123abcd/);
    assert.match(holders, /verification slot verification-slot-feedface held by jj:busy/);
    assert.match(holders, /primary-checkout writer \/repo \(local thread:a/);
    assert.match(holders, /post-land run def \(running/);
    assert.doesNotMatch(holders, /dead/);
    assert.equal(result.holders.length, 4);
    for (const holder of result.holders) assert.ok(refused.stderr.includes(holder), holder);
    assert.equal(existsSync(legacyStateHome()), true, "nothing moved");
    assert.equal(existsSync(cutoverMarkerPath()), false);
    assert.equal((await cutover({ check: true })).status, "refused");
  } finally {
    await releaseTransaction();
    await releaseSlot();
  }
});

test("the cutover moves state, keeps an existing workspace usable through landing, and is idempotent", async () => {
  const f = await project();
  try {
    await legacyMachine();
    // A workspace created before v1.0.0 at its recorded path under ~/.slipway/workspaces, bound to Issue 41.
    const name = "repo-41";
    const workspacePath = join(legacyWorkspaceHome(), name);
    await mkdir(legacyWorkspaceHome(), { recursive: true });
    jj(f.repo, ["workspace", "add", "--name", name, "-r", "main", workspacePath]);
    await writeJson(legacy("workspaces", `${name}.json`), {
      version: 1, workspaceName: name, workspacePath, integrationRoot: f.repo, issueNumber: 41, task: "Issue #41",
    });

    const check = await slipjay(["cutover", "--check"]);
    assert.equal(check.code, 0, check.stderr);
    assert.equal(JSON.parse(check.stdout).status, "ready");
    assert.equal(existsSync(legacyStateHome()), true, "--check changes nothing");

    const moved = await slipjay(["cutover"]);
    assert.equal(moved.code, 0, moved.stderr);
    const result = JSON.parse(moved.stdout);
    assert.equal(result.status, "cut-over");
    assert.equal(result.state, "rename");
    const state = join(slipjayHome(), "state");
    assert.equal(existsSync(legacyStateHome()), false);
    assert.equal(existsSync(legacyModePath()), false);
    assert.deepEqual(JSON.parse(await readFile(join(slipjayHome(), "mode.json"), "utf8")), { version: 1, mode: "direct" });
    assert.equal(JSON.parse(await readFile(join(state, "post-land", "abc.json"), "utf8")).log, join(state, "post-land", "abc.log"));

    // The Issue's existing workspace resumes at its recorded path, lands and is cleaned up.
    const resumed = await slipjay(["start", "--integration", "--issue", "41", "--json"], f.repo);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.deepEqual({ path: JSON.parse(resumed.stdout).workspacePath, reused: JSON.parse(resumed.stdout).reused }, { path: workspacePath, reused: true });
    await writeFile(join(workspacePath, "legacy.txt"), "landed after cutover\n");
    jj(workspacePath, ["describe", "-m", "Land from a pre-cutover workspace"]);
    const landed = await landThroughTestRunner(f, workspacePath, { keep: true });
    assert.equal(landed.ok, true, landed.lines.join("\n"));
    assert.equal(f.remoteFile("legacy.txt"), "landed after cutover\n");
    assert.equal(existsSync(join(state, `${name}.json`)), true, "the landing record lives in the new state");
    const cleaned = await cleanupLandedWorkspace(workspacePath);
    assert.equal(cleaned.cleaned, true, JSON.stringify(cleaned));
    assert.equal(existsSync(workspacePath), false);

    // New workspaces go under ~/.slipjay/workspaces.
    const fresh = await createWorkspace("after cutover", f.repo);
    assert.ok(fresh.workspacePath.startsWith(join(slipjayHome(), "workspaces") + "/"), fresh.workspacePath);

    // Running it again changes nothing.
    const marker = await readFile(cutoverMarkerPath(), "utf8");
    const again = await slipjay(["cutover"]);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).status, "already-cut-over");
    assert.equal(await readFile(cutoverMarkerPath(), "utf8"), marker);
    assert.equal(existsSync(legacyStateHome()), false);
  } finally {
    await f.dispose();
  }
}, 180_000);

test("across devices the cutover copies, verifies, then deletes the Slipway state", async () => {
  await legacyMachine();
  const legacyRoot = legacyStateHome();
  const result = await cutover({
    io: {
      rename: async (from, to) => {
        if (from === legacyRoot || from === legacyModePath()) throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
        await rename(from, to);
      },
    },
  });
  assert.equal(result.status, "cut-over");
  assert.deepEqual(result.status === "cut-over" && [result.state, result.mode], ["copy", "copy"]);
  assert.equal(existsSync(legacyRoot), false);
  const state = join(slipjayHome(), "state");
  assert.deepEqual(JSON.parse(await readFile(join(state, "workspaces", "spare.json"), "utf8")), { version: 1, workspaceName: "spare" });
  assert.equal(await readFile(join(state, "post-land", "abc.log"), "utf8"), "ok\n");
  assert.equal(existsSync(cutoverMarkerPath()), true);
});

test("an interrupted copy that left identical state at both locations finishes; differing state refuses", async () => {
  await legacyMachine();
  const state = join(slipjayHome(), "state");
  await mkdir(slipjayHome(), { recursive: true });
  await run("cp", ["-Rp", legacyStateHome(), state]);
  assert.equal((await cutover()).status, "cut-over");
  assert.equal(existsSync(legacyStateHome()), false);

  await rm(join(homedir(), ".slipway"), { recursive: true, force: true });
  await rm(slipjayHome(), { recursive: true, force: true });
  await legacyMachine();
  await mkdir(state, { recursive: true });
  await writeJson(join(state, "workspaces", "other.json"), { version: 1 });
  await assert.rejects(cutover(), /exist and differ/);
  assert.equal(existsSync(legacyStateHome()), true);
  assert.equal(existsSync(cutoverMarkerPath()), false);
});
