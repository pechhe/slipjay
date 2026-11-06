import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, test } from "vite-plus/test";
import { jj, project } from "../support/workspace-project.ts";
import { withWorkspaceTransaction } from "../../src/lib/infra/workspace-transaction.ts";
import { setConfiguredUpgradeSource } from "../../src/lib/policy/machine-config.ts";
import {
  installPath, landingUpgradesThisMachine, pruneInstalls, startClientUpgradeThrottled, upgradeMachine,
} from "../../src/lib/workspace/workspace-upgrade.ts";
import {
  commandLinkPath, currentSlotPath, currentSlotPreviousPath, installsHome, runnerSlotPath, runnerSlotPreviousPath,
  slipjayHome, upgradeTriggerStampPath,
} from "../../src/lib/workspace/workspace-paths.ts";

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
const DAY = 24 * 60 * 60_000;
/** The PATH the file starts with: the hermetic stub below is prepended to it for every test. */
const BASE_PATH = process.env.PATH ?? "";
/** The fixture's trees have no dependencies, so an install needs no fetch: this stands in for `bun install`. */
const noInstall = async () => undefined;

/**
 * A `systemctl` stub for a host that has, or has not, the runner unit: every call is recorded, and
 * `body` is a set of `case "$*"` arms deciding the answer. A runner upgrade is otherwise a host's
 * real unit, which this suite must never consult or touch.
 */
async function stubSystemctl(body: string): Promise<{ bin: string; log: string }> {
  const root = await mkdtemp(join(tmpdir(), "slipjay-systemctl-"));
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  await mkdir(bin);
  await writeFile(join(bin, "systemctl"), `#!/bin/sh\necho "$@" >> ${log}\ncase "$*" in\n${body}\nesac\nexit 0\n`);
  await chmod(join(bin, "systemctl"), 0o755);
  return { bin, log };
}

/**
 * The arms of a host whose runner unit exists and whose effective ExecStart is `execStart`. Like a real
 * user manager, it answers only a caller whose environment names the runtime directory.
 */
const runnerUnitArms = (execStart: string): string => `  *) [ -n "$XDG_RUNTIME_DIR" ] || { echo "Failed to connect to bus: No medium found" >&2; exit 1; };;
esac
case "$*" in
  *" show "*) echo LoadState=loaded; echo 'ExecStart={ path=/usr/bin/bws ; argv[]=${execStart} }'; exit 0;;
  *restart*) exit 0;;`;

/** The arms of a host with systemd and no runner unit. */
const noUnitArms = `  *" show "*) echo LoadState=not-found; exit 0;;
  *) exit 1;;`;

/** What `scripts/setup-runner.sh` writes: the runner slot, never the client's command or slot. */
const runnerSlotCommand = (): string => `/usr/bin/bws run -- ${join(runnerSlotPath(), "src/launcher/workspace.ts")} runner serve`;

/** The old form, which a runner restart would follow into the client slot once the command is adopted. */
const clientCommand = (): string => `/usr/bin/bws run -- ${commandLinkPath()} runner serve`;

let noUnitBin = "";
beforeAll(async () => { noUnitBin = (await stubSystemctl(noUnitArms)).bin; });

// The whole file shares one disposable HOME, and every test here is about the machine's state in it:
// start each from a machine that has never upgraded, and one whose runner unit this suite owns.
beforeEach(async () => {
  await rm(slipjayHome(), { recursive: true, force: true });
  // The adopted command too: it points into the slot that was just removed.
  await rm(dirname(dirname(commandLinkPath())), { recursive: true, force: true });
  process.env.PATH = `${noUnitBin}:${BASE_PATH}`;
  process.env.XDG_RUNTIME_DIR ??= "/run/user/fixture";
});

/** Run `work` with `bin` first on PATH, as a host with that `systemctl` would. */
async function withPath<T>(bin: string, work: () => Promise<T>): Promise<T> {
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before ?? ""}`;
  try { return await work(); }
  finally { process.env.PATH = before; }
}

/** Wait until `condition` holds, rather than sleeping for a guessed time. */
async function until(condition: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((settle) => setTimeout(settle, 10));
  }
}

/**
 * A commit on the fixture's integration branch whose tree is shaped like this package: a launcher
 * that answers `--version` and, unless `broken`, `status --json`. `git archive` of it is an install a
 * fixture can build in a moment.
 */
async function landSlipjayTree(f: Awaited<ReturnType<typeof project>>, version: string, { broken = false } = {}): Promise<string> {
  await writeFile(join(f.repo, "package.json"), JSON.stringify({ name: "@pechhe/slipjay", version, private: true }, null, 2));
  await mkdir(join(f.repo, "src/launcher"), { recursive: true });
  await writeFile(join(f.repo, "src/launcher/workspace.ts"), `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const command = process.argv[2];
if (command === "--version") console.log(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);
else if (command === "status") ${broken ? "process.exit(1);" : 'console.log("{}");'}
else process.exit(2);
`);
  jj(f.repo, ["commit", "-m", `slipjay tree ${version}`]);
  const commit = jj(f.repo, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
  jj(f.repo, ["bookmark", "set", "main", "-r", commit]);
  jj(f.repo, ["git", "push", "--remote", "origin", "--bookmark", "main"]);
  return commit;
}

test("an upgrade builds, verifies and swaps the client slot, and adopts the slipjay command", async () => {
  const f = await project();
  try {
    const commit = await landSlipjayTree(f, "9.9.9");
    await setConfiguredUpgradeSource(f.repo);
    // A machine installed with `bun add -g`: the first upgrade takes the command over.
    await mkdir(dirname(commandLinkPath()), { recursive: true });

    const outcome = await upgradeMachine({ install: noInstall });
    assert.equal(outcome.action, "upgraded", outcome.reason ?? "");
    assert.equal(outcome.slot, "client");
    assert.equal(outcome.from, null);
    assert.equal(outcome.to, commit);
    assert.equal(await readlink(currentSlotPath()), installPath(commit));
    assert.equal((await stat(join(installPath(commit), "src/launcher/workspace.ts"))).mode & 0o777, 0o755,
      "an archive carries no modes, so the install's launcher is made executable");
    assert.equal(outcome.command, join(currentSlotPath(), "src/launcher/workspace.ts"));
    assert.equal(await readlink(commandLinkPath()), join(currentSlotPath(), "src/launcher/workspace.ts"));
    // PATH now runs the slot, and the slot runs the tree that was verified.
    assert.equal(execFileSync(commandLinkPath(), ["--version"], { encoding: "utf8" }).trim(), "9.9.9");
  } finally { await f.dispose(); }
});

test("an upgrade of the install a slot already points at reports current", async () => {
  const f = await project();
  try {
    const commit = await landSlipjayTree(f, "9.9.9");
    await setConfiguredUpgradeSource(f.repo);
    await upgradeMachine({ install: noInstall });

    const again = await upgradeMachine({ install: noInstall });
    assert.equal(again.action, "current");
    assert.equal(again.from, commit);
    assert.equal(again.to, commit);
    assert.equal(await readlink(currentSlotPath()), installPath(commit));
  } finally { await f.dispose(); }
});

test("a build that fails verification leaves the slot and the command where they were", async () => {
  const f = await project();
  try {
    const first = await landSlipjayTree(f, "9.9.9");
    await setConfiguredUpgradeSource(f.repo);
    await mkdir(dirname(commandLinkPath()), { recursive: true });
    await upgradeMachine({ install: noInstall });

    const broken = await landSlipjayTree(f, "9.9.10", { broken: true });
    const outcome = await upgradeMachine({ install: noInstall });
    assert.equal(outcome.action, "failed");
    assert.match(outcome.reason ?? "", /did not answer status --json/);
    assert.equal(outcome.to, null);
    assert.equal(await readlink(currentSlotPath()), installPath(first));
    assert.equal(await readlink(commandLinkPath()), join(currentSlotPath(), "src/launcher/workspace.ts"));
    assert.equal(existsSync(installPath(broken)), false, "a tree that did not verify is not kept as an install");
  } finally { await f.dispose(); }
});

test("a failed verification never removes an install another slot runs", async () => {
  const f = await project();
  try {
    await setConfiguredUpgradeSource(f.repo);
    const shared = await landSlipjayTree(f, "9.9.10", { broken: true });
    // The runner already runs this tree, so the client's upgrade finds it built and cannot verify it.
    await mkdir(join(installPath(shared), "src/launcher"), { recursive: true });
    await writeFile(join(installPath(shared), "src/launcher/workspace.ts"), "#!/usr/bin/env bun\nprocess.exit(1);\n");
    await chmod(join(installPath(shared), "src/launcher/workspace.ts"), 0o755);
    await mkdir(dirname(runnerSlotPath()), { recursive: true });
    await symlink(installPath(shared), runnerSlotPath());

    const outcome = await upgradeMachine({ install: noInstall });
    assert.equal(outcome.action, "failed");
    assert.match(outcome.reason ?? "", /did not answer --version/);
    assert.equal(existsSync(join(installPath(shared), "src/launcher/workspace.ts")), true,
      "an install another slot runs is kept, however this upgrade judges it");
    assert.equal(await readlink(runnerSlotPath()), installPath(shared));
  } finally { await f.dispose(); }
});

test("a failed verification keeps a tree another slot started pointing at during the build", async () => {
  const f = await project();
  try {
    await setConfiguredUpgradeSource(f.repo);
    const broken = await landSlipjayTree(f, "9.9.10", { broken: true });
    await mkdir(dirname(runnerSlotPath()), { recursive: true });
    // The runner starts running this commit while the client is still building it.
    const install = async () => { await symlink(installPath(broken), runnerSlotPath()); };

    const outcome = await upgradeMachine({ install });
    assert.equal(outcome.action, "failed");
    assert.match(outcome.reason ?? "", /did not answer/);
    assert.equal(existsSync(join(installPath(broken), "src/launcher/workspace.ts")), true,
      "a tree a slot now points at is not this upgrade's to remove");
  } finally { await f.dispose(); }
});

test("two concurrent upgrades of one head leave the install the slot ran as the rollback", async () => {
  const f = await project();
  try {
    const first = await landSlipjayTree(f, "9.9.9");
    await setConfiguredUpgradeSource(f.repo);
    await upgradeMachine({ install: noInstall });
    const second = await landSlipjayTree(f, "9.9.10");

    // Hold the first upgrade inside its build, so the second reads the slot before it moves and swaps after it.
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    let building = 0;
    const gatedInstall = async () => { building += 1; await gate; };
    const firstUpgrade = upgradeMachine({ install: gatedInstall });
    await until(() => building === 1, "the first upgrade to take the install lock");
    const secondUpgrade = upgradeMachine({ install: gatedInstall });
    openGate();
    const outcomes = await Promise.all([firstUpgrade, secondUpgrade]);

    assert.deepEqual(outcomes.map((outcome) => outcome.action).sort(), ["current", "upgraded"], JSON.stringify(outcomes));
    assert.equal(await readlink(currentSlotPath()), installPath(second));
    assert.equal(await readlink(currentSlotPreviousPath()), installPath(first), "the rollback is the install the slot ran, never the one it moved to");
  } finally { await f.dispose(); }
});

test("a slot never moves onto an install removed after this upgrade verified it", async () => {
  const f = await project();
  try {
    const first = await landSlipjayTree(f, "9.9.9");
    await setConfiguredUpgradeSource(f.repo);
    await upgradeMachine({ install: noInstall });
    const second = await landSlipjayTree(f, "9.9.10");

    // Hold the slot's lock, so the upgrade verifies and then waits to swap; meanwhile its tree goes, as another
    // upgrade's discard of a tree it built would take it.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holding = false;
    const lock = withWorkspaceTransaction(`slot:${currentSlotPath()}`, async () => { holding = true; await held; });
    await until(() => holding, "the test to hold the slot lock");
    const upgrade = upgradeMachine({ install: noInstall });
    await until(() => existsSync(join(installPath(second), "src/launcher/workspace.ts")), "the upgrade to build its install");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(installPath(second), { recursive: true, force: true });
    release();
    await lock;
    const outcome = await upgrade;

    assert.equal(outcome.action, "failed", JSON.stringify(outcome));
    assert.equal(await readlink(currentSlotPath()), installPath(first), "the slot stays on the install it ran");
  } finally { await f.dispose(); }
});

test("rollback returns the slot to the install it replaced, and can return again", async () => {
  const f = await project();
  try {
    const first = await landSlipjayTree(f, "9.9.9");
    await setConfiguredUpgradeSource(f.repo);
    await upgradeMachine({ install: noInstall });
    const second = await landSlipjayTree(f, "9.9.10");
    await upgradeMachine({ install: noInstall });
    assert.equal(await readlink(currentSlotPath()), installPath(second));
    assert.equal(await readlink(currentSlotPreviousPath()), installPath(first));

    const back = await upgradeMachine({ rollback: true });
    assert.equal(back.action, "rolled-back");
    assert.equal(back.from, second);
    assert.equal(back.to, first);
    assert.equal(await readlink(currentSlotPath()), installPath(first));
    assert.equal(await readlink(currentSlotPreviousPath()), installPath(second));

    // The rollback it left becomes the rollback in its turn, so one command undoes itself.
    const forward = await upgradeMachine({ rollback: true });
    assert.equal(forward.action, "rolled-back");
    assert.equal(await readlink(currentSlotPath()), installPath(second));
  } finally { await f.dispose(); }
});

test("rollback refuses an install that has no launcher, leaving the working slot in place", async () => {
  const f = await project();
  try {
    const first = await landSlipjayTree(f, "9.9.9");
    await setConfiguredUpgradeSource(f.repo);
    await upgradeMachine({ install: noInstall });
    const second = await landSlipjayTree(f, "9.9.10");
    await upgradeMachine({ install: noInstall });
    await rm(join(installPath(first), "src/launcher/workspace.ts"));

    const back = await upgradeMachine({ rollback: true });
    assert.equal(back.action, "failed");
    assert.match(back.reason ?? "", /has no launcher/);
    assert.equal(await readlink(currentSlotPath()), installPath(second), "a slot never moves onto a tree that cannot start");
    assert.equal(await readlink(currentSlotPreviousPath()), installPath(first));
  } finally { await f.dispose(); }
});

test("a client upgrade never changes the runner slot or restarts its unit", async () => {
  const f = await project();
  try {
    const commit = await landSlipjayTree(f, "9.9.9");
    await setConfiguredUpgradeSource(f.repo);
    // A runner install this machine already runs: the client's upgrade must leave it, and its unit, alone.
    const running = join(installsHome(), "a".repeat(40));
    await mkdir(join(running, "src/launcher"), { recursive: true });
    await writeFile(join(running, "src/launcher/workspace.ts"), "#!/usr/bin/env bun\n");
    await mkdir(dirname(runnerSlotPath()), { recursive: true });
    await symlink(running, runnerSlotPath());
    let restarted = false;

    const outcome = await upgradeMachine({ install: noInstall, restart: async () => { restarted = true; } });
    assert.equal(outcome.action, "upgraded");
    assert.equal(outcome.to, commit);
    assert.equal(await readlink(runnerSlotPath()), running);
    assert.equal(existsSync(runnerSlotPreviousPath()), false);
    assert.equal(restarted, false);
  } finally { await f.dispose(); }
});

test("a client upgrade refuses to adopt the command while the runner unit runs something else", async () => {
  const f = await project();
  try {
    const commit = await landSlipjayTree(f, "9.9.9");
    await setConfiguredUpgradeSource(f.repo);
    await mkdir(dirname(commandLinkPath()), { recursive: true });
    const unit = await stubSystemctl(runnerUnitArms(clientCommand()));

    const outcome = await withPath(unit.bin, () => upgradeMachine({ install: noInstall }));
    // The slot is this machine's code and moves; the command would move the runner too, so it does not.
    assert.equal(outcome.action, "upgraded");
    assert.equal(outcome.to, commit);
    assert.equal(outcome.command, null);
    assert.match(outcome.reason ?? "", /scripts\/setup-runner\.sh/);
    assert.match(outcome.reason ?? "", /slipjay upgrade --runner/);
    assert.equal(existsSync(commandLinkPath()), false, "the runner's unit still follows the old command, unchanged");
  } finally { await f.dispose(); }
});

test("a client upgrade leaves the command alone when systemd cannot say what the runner unit runs", async () => {
  const f = await project();
  try {
    const commit = await landSlipjayTree(f, "9.9.9");
    await setConfiguredUpgradeSource(f.repo);
    await mkdir(dirname(commandLinkPath()), { recursive: true });
    // The user manager does not answer, as when the bus is unreachable: that is not a host without a unit.
    const unit = await stubSystemctl(`  *) echo "Failed to connect to bus: No medium found" >&2; exit 1;;`);

    const outcome = await withPath(unit.bin, () => upgradeMachine({ install: noInstall }));
    assert.equal(outcome.action, "upgraded");
    assert.equal(outcome.to, commit);
    assert.equal(outcome.command, null);
    assert.match(outcome.reason ?? "", /systemd could not say what the slipjay-runner unit runs.*Failed to connect to bus/);
    assert.equal(existsSync(commandLinkPath()), false, "a runner that may follow the command is never moved by a client upgrade");
  } finally { await f.dispose(); }
});

test("a client upgrade adopts the command on a host whose runner unit runs the runner install", async () => {
  const f = await project();
  try {
    await landSlipjayTree(f, "9.9.9");
    await setConfiguredUpgradeSource(f.repo);
    await mkdir(dirname(commandLinkPath()), { recursive: true });
    const unit = await stubSystemctl(runnerUnitArms(runnerSlotCommand()));

    const outcome = await withPath(unit.bin, () => upgradeMachine({ install: noInstall }));
    assert.equal(outcome.action, "upgraded", outcome.reason ?? "");
    assert.equal(outcome.command, join(currentSlotPath(), "src/launcher/workspace.ts"));
    assert.equal(await readlink(commandLinkPath()), join(currentSlotPath(), "src/launcher/workspace.ts"));
  } finally { await f.dispose(); }
});

test("a later upgrade re-attempts the adoption an earlier one failed", async () => {
  const f = await project();
  try {
    const commit = await landSlipjayTree(f, "9.9.9");
    await setConfiguredUpgradeSource(f.repo);
    // A directory where the command link goes: the link cannot be renamed over it.
    await mkdir(commandLinkPath(), { recursive: true });

    const failed = await upgradeMachine({ install: noInstall });
    assert.equal(failed.action, "failed");
    assert.match(failed.reason ?? "", /the slipjay command could not be pointed at it/);
    assert.equal(await readlink(currentSlotPath()), installPath(commit), "the slot moved; only the command did not");

    await rm(commandLinkPath(), { recursive: true, force: true });
    const repaired = await upgradeMachine({ install: noInstall });
    assert.equal(repaired.action, "current");
    assert.equal(repaired.to, commit);
    assert.equal(repaired.command, join(currentSlotPath(), "src/launcher/workspace.ts"));
    assert.match(repaired.reason ?? "", /the slipjay command was pointed at it/);
    assert.equal(await readlink(commandLinkPath()), join(currentSlotPath(), "src/launcher/workspace.ts"));
  } finally { await f.dispose(); }
});

test("a runner upgrade refuses on a host with no runner unit", async () => {
  const f = await project();
  try {
    await landSlipjayTree(f, "9.9.9");
    await setConfiguredUpgradeSource(f.repo);
    const unit = await stubSystemctl(noUnitArms);

    await withPath(unit.bin, async () => {
      await assert.rejects(upgradeMachine({ slot: "runner", install: noInstall }), /No slipjay-runner unit/);
    });
    assert.equal(existsSync(runnerSlotPath()), false, "a refused upgrade changes nothing");
  } finally { await f.dispose(); }
});

test("a runner upgrade installs the runner slot and restarts its unit, leaving the client alone", async () => {
  const f = await project();
  try {
    const commit = await landSlipjayTree(f, "9.9.9");
    await setConfiguredUpgradeSource(f.repo);
    const unit = await stubSystemctl(runnerUnitArms(runnerSlotCommand()));

    const outcome = await withPath(unit.bin, () => upgradeMachine({ slot: "runner", install: noInstall }));
    assert.equal(outcome.action, "upgraded", outcome.reason ?? "");
    assert.equal(outcome.slot, "runner");
    assert.equal(outcome.to, commit);
    assert.equal(await readlink(runnerSlotPath()), installPath(commit));
    assert.equal(existsSync(currentSlotPath()), false, "the runner slot is not the client's");
    assert.match(await readFile(unit.log, "utf8"), /^--user restart slipjay-runner\.service$/m);
  } finally { await f.dispose(); }
});

test("a runner upgrade never restarts a unit that runs something else, and says how to fix it", async () => {
  const f = await project();
  try {
    const commit = await landSlipjayTree(f, "9.9.9");
    await setConfiguredUpgradeSource(f.repo);
    const unit = await stubSystemctl(runnerUnitArms(clientCommand()));

    const outcome = await withPath(unit.bin, () => upgradeMachine({ slot: "runner", install: noInstall }));
    assert.equal(outcome.action, "failed");
    assert.match(outcome.reason ?? "", /scripts\/setup-runner\.sh/);
    // The install is built, so setup-runner.sh can point the unit at it; the restart waits for that.
    assert.equal(await readlink(runnerSlotPath()), installPath(commit));
    assert.doesNotMatch(await readFile(unit.log, "utf8"), /restart/, "a runner is never restarted onto a unit that runs other code");
  } finally { await f.dispose(); }
});

test("the hourly pass upgrades the client first and reports it", async () => {
  const f = await project();
  try {
    const commit = await landSlipjayTree(f, "9.9.9");
    await setConfiguredUpgradeSource(f.repo);

    // The pass runs the real upgrade, dependency install included; the fixture tree has nothing to fetch.
    const run = spawnSync("bun", [cli, "maintain", "--json"], { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 120_000 });
    assert.equal(run.status, 0, run.stderr);
    const reported = JSON.parse(run.stdout) as { upgrade: { slot: string; action: string; to: string } };
    assert.equal(reported.upgrade.slot, "client");
    assert.equal(reported.upgrade.action, "upgraded", run.stdout);
    assert.equal(reported.upgrade.to, commit);
    assert.equal(await readlink(currentSlotPath()), installPath(commit));
  } finally { await f.dispose(); }
});

test("the hourly pass reports a busy install lock instead of waiting for another build", async () => {
  const f = await project();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    const commit = await landSlipjayTree(f, "9.9.9");
    await setConfiguredUpgradeSource(f.repo);
    // Another upgrade is building this commit: the pass must not be held by it.
    const key = `install:${installPath(commit)}`;
    const holding = withWorkspaceTransaction(key, async () => { await held; });
    await untilHeld(key);

    const run = spawnSync("bun", [cli, "maintain", "--json"], { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 120_000 });
    assert.equal(run.status, 0, run.stderr);
    const reported = JSON.parse(run.stdout) as { upgrade: { action: string; reason: string }; evictions: unknown };
    assert.equal(reported.upgrade.action, "busy", run.stdout);
    assert.match(reported.upgrade.reason, /another upgrade is building/);
    assert.ok(reported.evictions, "the rest of the pass still runs");
    assert.equal(existsSync(currentSlotPath()), false);
    release();
    await holding;
  } finally { release(); await f.dispose(); }
});

test("a start triggers one client upgrade per ten minutes", async () => {
  const f = await project();
  try {
    // The detached child's own upgrade refuses at once, so this test is about the stamp alone.
    await setConfiguredUpgradeSource(join(f.root, "not-a-checkout"));
    assert.equal((await startClientUpgradeThrottled()).started, true);
    assert.equal((await startClientUpgradeThrottled()).started, false);

    const past = new Date(Date.now() - 11 * 60_000);
    await utimes(upgradeTriggerStampPath(), past, past);
    assert.equal((await startClientUpgradeThrottled()).started, true);
  } finally { await f.dispose(); }
});

test("only a landing of the checkout upgradeSource names triggers an upgrade", async () => {
  const f = await project();
  const other = await project();
  try {
    await setConfiguredUpgradeSource(f.repo);
    assert.equal(await landingUpgradesThisMachine(f.repo), true);
    assert.equal(await landingUpgradesThisMachine(other.repo), false, "another repository's landing is not this machine's code");
  } finally { await f.dispose(); await other.dispose(); }
});

test("an upgrade with no upgrade source refuses, and automatic triggers skip it silently", async () => {
  await assert.rejects(upgradeMachine({ install: noInstall }), /config set upgradeSource/);
  assert.equal((await startClientUpgradeThrottled()).started, false);
  assert.equal(existsSync(upgradeTriggerStampPath()), false);
});

test("config set upgradeSource records the checkout, and unset turns automatic upgrades off", async () => {
  const f = await project();
  try {
    const set = spawnSync("bun", [cli, "config", "set", "upgradeSource", f.repo], { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 60_000 });
    assert.equal(set.status, 0, set.stderr);
    assert.deepEqual(JSON.parse(set.stdout), { upgradeSource: await realpath(f.repo) });
    const shown = JSON.parse(spawnSync("bun", [cli, "config", "--json"], { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 60_000 }).stdout) as { upgradeSource: string | null };
    assert.equal(shown.upgradeSource, await realpath(f.repo));

    assert.equal(spawnSync("bun", [cli, "config", "unset", "upgradeSource"], { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 60_000 }).status, 0);
    assert.equal((await startClientUpgradeThrottled()).started, false, "with no upgrade source the automatic trigger is off");
  } finally { await f.dispose(); }
});

test("cleanup keeps what the slots and their rollbacks point at and removes older installs", async () => {
  const slot = join(installsHome(), "1".repeat(40));
  const previous = join(installsHome(), "2".repeat(40));
  const old = join(installsHome(), "3".repeat(40));
  const recent = join(installsHome(), "4".repeat(40));
  for (const path of [slot, previous, old, recent]) await mkdir(path, { recursive: true });
  await mkdir(dirname(currentSlotPath()), { recursive: true });
  await symlink(slot, currentSlotPath());
  await symlink(previous, currentSlotPreviousPath());
  const aged = new Date(Date.now() - 8 * DAY);
  for (const path of [slot, previous, old]) await utimes(path, aged, aged);

  const removed = await pruneInstalls();
  assert.deepEqual(removed.sort(), ["3".repeat(40)]);
  assert.equal(existsSync(slot), true);
  assert.equal(existsSync(previous), true);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(recent), true, "an install younger than a week is kept");
});

/** Wait until `key`'s lock is held, by failing to take it without waiting. */
async function untilHeld(key: string): Promise<void> {
  for (;;) {
    try { await withWorkspaceTransaction(key, async () => {}, { wait: false }); }
    catch (error) {
      if ((error as { code?: string }).code === "ELOCKED") return;
      throw error;
    }
    await new Promise((settle) => setTimeout(settle, 10));
  }
}
