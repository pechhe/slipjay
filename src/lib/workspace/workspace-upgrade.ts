/**
 * The machine's installed code and the two slots that run it. An upgrade takes this machine's
 * integration head (the checkout `upgradeSource` names, after a fetch), builds its tree into
 * `~/.slipjay/installs/<commit>` with its dependencies, verifies it by running the launcher it
 * built, and only then swaps a slot: `~/.slipjay/current` for the `slipjay` command and
 * `~/.slipjay/runner-install` for the runner service. The target a slot replaced stays beside it as
 * `previous`, which `--rollback` swaps back. A client upgrade also adopts the machine by linking
 * `~/.bun/bin/slipjay` to the current slot, so everything on `PATH` follows the slot. See README,
 * Install.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkspaceCommand } from "../infra/workspace-command.ts";
import { withWorkspaceTransaction } from "../infra/workspace-transaction.ts";
import { revisionFacts, workspaceContext } from "../infra/workspace-jj.ts";
import { fetchIntegration, publicationRemote } from "../landing/landing-steps.ts";
import { checkoutIdentity, configuredUpgradeSource } from "../policy/machine-config.ts";
import { spawnDetached } from "./workspace-background.ts";
import {
  commandLinkPath, currentSlotPath, currentSlotPreviousPath, installsHome, runnerSlotPath, runnerSlotPreviousPath,
  slipjayHome, stateHome, upgradeLogPath, upgradeTriggerStampPath,
} from "./workspace-paths.ts";

export type UpgradeSlot = "client" | "runner";
/** `busy` is a pass that must not wait finding another upgrade building the same commit. */
export type UpgradeAction = "upgraded" | "current" | "rolled-back" | "busy" | "failed";

/** What one upgrade did: the slot, the installs it moved between (commit ids), and why it failed. */
export interface UpgradeOutcome {
  slot: UpgradeSlot;
  from: string | null;
  to: string | null;
  action: UpgradeAction;
  reason: string | null;
  /** The launcher the `slipjay` command runs afterwards; a client upgrade adopts it, a runner one leaves it. */
  command: string | null;
}

/** One slot's movement, before the command link and the runner's unit are brought into line with it. */
type UpgradeResult = { action: UpgradeAction; from: string | null; to: string | null; reason: string | null };

/** The refusal of a machine that has never been told which checkout to upgrade from. */
export const NO_UPGRADE_SOURCE = "No upgrade source on this machine: name the integration checkout to upgrade from with "
  + "`slipjay config set upgradeSource <path>` (or \"upgradeSource\" in ~/.slipjay/config.json).";

/** The launcher inside an install: the CLI entry, and what the slots and the `slipjay` command run. */
const LAUNCHER = "src/launcher/workspace.ts";
/** Installs no slot refers to are kept this long, so a rollback or a hand-made install survives a while. */
const INSTALL_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Reading the source, archiving it and unpacking it: an unreachable remote or a stuck git fails the attempt. */
const SOURCE_TIMEOUT_MS = 10 * 60_000;
/** A dependency install has no business taking longer than this, and a pass that must not wait does not. */
const DEPENDENCY_INSTALL_TIMEOUT_MS = 5 * 60_000;
const VERIFY_TIMEOUT_MS = 2 * 60_000;
/** A slot swap is two renames, so waiting for one is short; a build is what takes time, and it has its own lock. */
const SLOT_LOCK_WAIT_MS = 30_000;
/** A start triggers at most one automatic client upgrade in this window. */
const UPGRADE_TRIGGER_INTERVAL_MS = 10 * 60_000;
/** A build a killed upgrade left behind is removed after this long, not kept for the install retention. */
const LEFTOVER_RETENTION_MS = 24 * 60 * 60_000;

/** A commit-named install directory, or the archive or temporary tree a build leaves behind. */
const INSTALL_NAME = /^[0-9a-f]{8,64}$/;
const LEFTOVER_NAME = /^[0-9a-f]{8,64}\.(tmp|tar)-/;
/** This module's own marker for the install lock being held by another build. */
const INSTALL_BUSY_CODE = "SLIPJAY_INSTALL_BUSY";

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
/** The last line of a command's output, which is the one that says what went wrong. */
const lastLine = (result: { stdout: string; stderr: string }): string => (result.stderr || result.stdout).trim().split(/\r?\n/).at(-1) ?? "";
const short = (commit: string | null): string => commit ? commit.slice(0, 12) : "none";

/** The Bun a built install runs under: this process's, or `bun` from `PATH` when the host process is not Bun (tests). */
const bunRuntime = (): string => (process.versions as Record<string, string | undefined>).bun ? process.execPath : "bun";

/** How a built tree gets its dependencies; tests inject a no-op so a fixture stays fast. */
export type DependencyInstall = (installPath: string) => Promise<void>;

/** `bun install --frozen-lockfile` in a built tree: a tree without its dependencies cannot run. */
const installDependencies: DependencyInstall = async (path) => {
  const installed = await runWorkspaceCommand("bun", ["install", "--frozen-lockfile"], { cwd: path, timeoutMs: DEPENDENCY_INSTALL_TIMEOUT_MS });
  if (installed.code !== 0) throw new Error(`bun install --frozen-lockfile failed: ${lastLine(installed)}`);
};

/** The slot paths of one slot: the symlink and the rollback beside it. */
const slotPaths = (slot: UpgradeSlot) => slot === "runner"
  ? { slot: runnerSlotPath(), previous: runnerSlotPreviousPath() }
  : { slot: currentSlotPath(), previous: currentSlotPreviousPath() };

/** Where a commit's install lives. */
export const installPath = (commit: string): string => join(installsHome(), commit);

/** A symlink's target, or null when nothing is linked there. */
async function linkTarget(path: string): Promise<string | null> {
  try { return await readlink(path); } catch { return null; }
}

/** The commit a slot points at, or null when the slot is unset. */
async function linkedCommit(path: string): Promise<string | null> {
  const target = await linkTarget(path);
  return target ? basename(target) : null;
}

/** Point `path` at `target` atomically: a reader sees the old link or the new one, never neither. */
async function writeLink(path: string, target: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await symlink(target, temporary);
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

/** The installs the two slots and their rollbacks point at: never removed, never discarded as a failed build. */
async function referencedInstalls(): Promise<Set<string>> {
  const keep = new Set<string>();
  for (const path of [currentSlotPath(), currentSlotPreviousPath(), runnerSlotPath(), runnerSlotPreviousPath()]) {
    const target = await linkTarget(path);
    if (target) keep.add(basename(target));
  }
  return keep;
}

/** The install lock is held by another build: a pass that must not wait reports it and carries on. */
function installBusy(commit: string): Error {
  const error = new Error(`another upgrade is building ${short(commit)}`) as Error & { code: string };
  error.code = INSTALL_BUSY_CODE;
  return error;
}

const isInstallBusy = (error: unknown): boolean => (error as { code?: string }).code === INSTALL_BUSY_CODE;

/**
 * Read-compare-swap a slot onto `target`. The caller holds the slot's lock, so the rollback is only
 * ever the install the slot actually ran: a concurrent upgrade that already moved it there leaves
 * this one reporting `current`, and a target the slot already points at never becomes its own rollback.
 */
async function swapSlotLocked(slot: UpgradeSlot, target: string): Promise<{ changed: boolean; from: string | null }> {
  const paths = slotPaths(slot);
  const current = await linkTarget(paths.slot);
  const from = current ? basename(current) : null;
  if (current === target) return { changed: false, from };
  // Another upgrade can discard a tree it built after this one verified it and before this swap; a slot
  // is never moved onto an install that is no longer there.
  if (!existsSync(join(target, LAUNCHER))) throw new Error(`the install ${basename(target)} was removed before the slot could move to it`);
  // Only an install that exists can be rolled back to; a dangling slot leaves no rollback behind it.
  if (current && existsSync(join(current, LAUNCHER))) await writeLink(paths.previous, current);
  else await rm(paths.previous, { force: true });
  await writeLink(paths.slot, target);
  return { changed: true, from };
}

/** Run `work` under one slot's lock, so two upgrades never interleave a read-compare-swap of it. */
async function withSlotLock<T>(slot: UpgradeSlot, work: () => Promise<T>): Promise<T> {
  return withWorkspaceTransaction(`slot:${slotPaths(slot).slot}`, work, { waitMs: SLOT_LOCK_WAIT_MS });
}

/** The integration checkout this machine upgrades from; throws the refusal that names the setting when it has none. */
export function upgradeSource(): string {
  const source = configuredUpgradeSource();
  if (!source) throw new Error(NO_UPGRADE_SOURCE);
  if (!isAbsolute(source)) throw new Error(`upgradeSource must be an absolute path: ${source} (set it with \`slipjay config set upgradeSource <path>\`)`);
  return source;
}

/**
 * The commit an upgrade installs: the source's integration branch as its remote publishes it, so a
 * machine installs what landed rather than what its checkout happens to have. The fetch is what makes
 * the remote-tracking revision current; without a declared remote the local branch is the head.
 */
async function integrationHead(source: string): Promise<string> {
  const context = await workspaceContext(source);
  if (!context) throw new Error(`upgradeSource ${source} is not a JJ checkout: set it to this machine's integration checkout`);
  const remote = publicationRemote(context);
  if (remote) {
    const fetched = await fetchIntegration(source, remote, context.integrationBranch, { timeoutMs: SOURCE_TIMEOUT_MS });
    if (fetched.code !== 0) throw new Error(`could not fetch ${context.integrationBranch} from ${remote} in ${source}: ${lastLine(fetched)}`);
    const tracked = await revisionFacts(source, `${context.integrationBranch}@${remote}`).catch(() => null);
    if (tracked) return tracked.commitId;
  }
  return (await revisionFacts(source, context.integrationBranch)).commitId;
}

/**
 * The built tree of `commit`: the source checkout's tree from `git archive`, its dependencies, and an
 * executable launcher (an archive carries no modes). It is built beside the installs and renamed into
 * place complete, so no reader ever sees a partial install, and one builder per install means a second
 * upgrade either waits for it (`wait`) or reports the build busy. `built` says whether this call made
 * the tree, which is the only tree a failure here may remove.
 */
async function buildInstall(source: string, commit: string, install: DependencyInstall, options: { wait: boolean }): Promise<{ path: string; built: boolean }> {
  const target = installPath(commit);
  if (existsSync(join(target, LAUNCHER))) return { path: target, built: false };
  try {
    return await withWorkspaceTransaction(`install:${target}`, async () => {
      if (existsSync(join(target, LAUNCHER))) return { path: target, built: false };
      await mkdir(installsHome(), { recursive: true, mode: 0o700 });
      const building = `${target}.tmp-${randomUUID()}`;
      const archive = `${building}.tar`;
      let built = false;
      await mkdir(building, { recursive: true, mode: 0o700 });
      try {
        const archived = await runWorkspaceCommand("git", ["archive", "--format=tar", `--output=${archive}`, commit], { cwd: source, timeoutMs: SOURCE_TIMEOUT_MS });
        if (archived.code !== 0) throw new Error(`git archive ${short(commit)} failed in ${source}: ${lastLine(archived)}`);
        const extracted = await runWorkspaceCommand("tar", ["--extract", "--file", archive, "--directory", building], { timeoutMs: SOURCE_TIMEOUT_MS });
        if (extracted.code !== 0) throw new Error(`unpacking ${short(commit)} failed: ${lastLine(extracted)}`);
        await chmod(join(building, LAUNCHER), 0o755);
        await install(building);
        try { await rename(building, target); built = true; }
        catch (error) {
          // Another upgrade completed this install while this one built: keep theirs.
          if (!existsSync(join(target, LAUNCHER))) throw error;
        }
        return { path: target, built };
      } finally {
        await rm(building, { recursive: true, force: true });
        await rm(archive, { force: true });
      }
    }, options.wait ? { waitMs: DEPENDENCY_INSTALL_TIMEOUT_MS } : { wait: false });
  } catch (error) {
    if (!options.wait && (error as { code?: string }).code === "ELOCKED") throw installBusy(commit);
    throw error;
  }
}

/**
 * Remove a tree this upgrade built when no slot points at it: a tree that did not verify is not an
 * install, but one another slot or rollback runs is never removed, whatever this upgrade thinks of it.
 */
async function discardBuiltInstall(commit: string): Promise<void> {
  if ((await referencedInstalls()).has(commit)) return;
  await rm(installPath(commit), { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Prove the built tree runs before anything points at it: its launcher answers `--version`, and one
 * read-only command (`status --json`) completes in a temporary directory that is no repository. A
 * tree whose dependencies are missing, or whose source does not load, fails here.
 */
async function verifyInstall(target: string): Promise<void> {
  const launcher = join(target, LAUNCHER);
  const probe = await mkdtemp(join(tmpdir(), "slipjay-verify-"));
  try {
    const version = await runWorkspaceCommand(bunRuntime(), [launcher, "--version"], { cwd: probe, timeoutMs: VERIFY_TIMEOUT_MS });
    if (version.code !== 0 || !version.stdout.trim()) throw new Error(`the built launcher did not answer --version: ${lastLine(version) || `exit ${version.code}`}`);
    const status = await runWorkspaceCommand(bunRuntime(), [launcher, "status", "--json"], { cwd: probe, timeoutMs: VERIFY_TIMEOUT_MS });
    if (status.code !== 0) throw new Error(`the built launcher did not answer status --json: ${lastLine(status) || `exit ${status.code}`}`);
  } finally { await rm(probe, { recursive: true, force: true }); }
}

/** What this host's runner unit runs, or that it has none, or that systemd could not say. */
type RunnerUnit = { state: "none" } | { state: "unit"; execStart: string } | { state: "unknown"; reason: string };

/**
 * `systemctl --user` with the caller's environment. The user manager is reached through `XDG_RUNTIME_DIR`,
 * which the sanitized command environment drops: without it every query fails ("Failed to connect to bus"),
 * as it did on peach-live on 6 Nov 2026. The local executor passes it the same way.
 */
const userSystemctl = (args: readonly string[], timeoutMs = 30_000) =>
  runWorkspaceCommand("systemctl", ["--user", ...args], { env: process.env, timeoutMs });

/**
 * The runner unit's effective `ExecStart`, as systemd resolves it (drop-ins included). Only Linux hosts
 * run the runner, so another platform (the Mac) has no unit; a Linux systemd that does not answer is
 * `unknown`, never "no unit", so a guard built on this fails closed.
 */
async function runnerUnit(): Promise<RunnerUnit> {
  if (process.platform !== "linux") return { state: "none" };
  const shown = await userSystemctl(["show", "-p", "LoadState", "-p", "ExecStart", "slipjay-runner.service"]);
  if (shown.code !== 0) return { state: "unknown", reason: lastLine(shown) || `systemctl exited ${shown.code}` };
  const field = (name: string) => shown.stdout.split(/\r?\n/).find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1).trim() ?? "";
  if (field("LoadState") === "not-found") return { state: "none" };
  const execStart = field("ExecStart");
  return execStart ? { state: "unit", execStart } : { state: "unknown", reason: "systemd shows the unit with no ExecStart" };
}

/** Whether the unit's command runs the runner slot's launcher: the only code a runner may run. */
const runsRunnerSlot = (execStart: string): boolean => execStart.includes(join(runnerSlotPath(), LAUNCHER));

/** What to run when a unit does not run the runner slot, and why it must. */
const setupRunnerRefusal = (execStart: string): string => `the slipjay-runner unit runs ${execStart}, not the runner install `
  + `(${join(runnerSlotPath(), LAUNCHER)}): run scripts/setup-runner.sh to point the unit at it, then \`slipjay upgrade --runner\``;

/**
 * The `slipjay` command on `PATH` runs the current slot, replacing the bun global package link it may
 * have been — unless this host's runner unit runs something else, which would make the runner follow
 * the client slot too. That refusal is reported, and the slot upgrade it belongs to still stands.
 */
async function adoptCommand(): Promise<{ command: string | null; refusal: string | null; changed: boolean }> {
  const link = commandLinkPath();
  // A machine with no bun global bin keeps running whatever put `slipjay` on its PATH.
  if (!existsSync(dirname(link))) return { command: null, refusal: null, changed: false };
  const unit = await runnerUnit();
  if (unit.state === "unknown") return { command: null, refusal: `not adopted: systemd could not say what the slipjay-runner unit runs (${unit.reason})`, changed: false };
  if (unit.state === "unit" && !runsRunnerSlot(unit.execStart)) return { command: null, refusal: `not adopted: ${setupRunnerRefusal(unit.execStart)}`, changed: false };
  const target = join(currentSlotPath(), LAUNCHER);
  const before = await linkTarget(link);
  if (before === target) return { command: target, refusal: null, changed: false };
  await writeLink(link, target);
  return { command: target, refusal: null, changed: true };
}

/** Refuse a runner upgrade on a host that has no unit to restart: its slot is only for a runner host. */
async function assertRunnerUnit(): Promise<void> {
  const unit = await runnerUnit();
  if (unit.state === "none") throw new Error("No slipjay-runner unit on this host: a runner install upgrades only where "
    + "scripts/setup-runner.sh installed the unit");
  if (unit.state === "unknown") throw new Error(`systemd could not say whether this host has a slipjay-runner unit: ${unit.reason}`);
}

/** Restart the unit onto the runner slot. It finishes any integration in flight first (see docs/runner.md). */
async function restartRunnerUnit(): Promise<void> {
  const restarted = await userSystemctl(["restart", "slipjay-runner.service"], 120_000);
  if (restarted.code !== 0) throw new Error(`the runner unit did not restart: ${lastLine(restarted) || `exit ${restarted.code}`}`);
}

/** Build, verify and swap a slot onto the integration head; a failure leaves the slot where it was. */
async function upgradeSlot(slot: UpgradeSlot, options: UpgradeOptions): Promise<UpgradeResult> {
  const source = upgradeSource();
  const from = await linkedCommit(slotPaths(slot).slot);
  let commit: string;
  try { commit = await integrationHead(source); }
  catch (error) { return { action: "failed", from, to: null, reason: message(error) }; }
  if (from === commit && existsSync(join(installPath(commit), LAUNCHER))) return { action: "current", from, to: commit, reason: null };
  let built = false;
  try {
    const install = await buildInstall(source, commit, options.install ?? installDependencies, { wait: options.waitForInstallLock !== false });
    built = install.built;
    await verifyInstall(install.path);
  } catch (error) {
    if (isInstallBusy(error)) return { action: "busy", from, to: null, reason: message(error) };
    // Only this upgrade's own tree goes: another slot may run the one it found.
    if (built) await discardBuiltInstall(commit);
    return { action: "failed", from, to: null, reason: message(error) };
  }
  try {
    const swap = await withSlotLock(slot, () => swapSlotLocked(slot, installPath(commit)));
    // A concurrent upgrade already put the slot here: nothing moved, so nothing becomes its rollback.
    return swap.changed ? { action: "upgraded", from: swap.from, to: commit, reason: null }
      : { action: "current", from: swap.from, to: commit, reason: null };
  } catch (error) {
    // The verified install stays: it is not this call's to remove once the slot may be about to use it.
    return { action: "failed", from, to: null, reason: message(error) };
  }
}

/** Swap a slot back onto the install it replaced, which then becomes the rollback in its turn. */
async function rollbackSlot(slot: UpgradeSlot): Promise<UpgradeResult> {
  const paths = slotPaths(slot);
  const from = await linkedCommit(paths.slot);
  try {
    return await withSlotLock(slot, async () => {
      const previous = await linkTarget(paths.previous);
      if (!previous) return { action: "failed", from, to: null, reason: `no previous ${slot} install to roll back to: ${paths.previous} is not set` };
      // A tree without its launcher cannot start: refusing leaves the working slot where it is.
      if (!existsSync(join(previous, LAUNCHER))) {
        return { action: "failed", from, to: null, reason: `the previous ${slot} install has no launcher (${join(previous, LAUNCHER)} is missing); `
          + `upgrade again to install a working tree` };
      }
      const swap = await swapSlotLocked(slot, previous);
      return swap.changed ? { action: "rolled-back", from: swap.from, to: basename(previous), reason: null }
        : { action: "current", from: swap.from, to: basename(previous), reason: `the ${slot} slot already runs the install it replaced` };
    });
  } catch (error) { return { action: "failed", from, to: null, reason: message(error) }; }
}

export interface UpgradeOptions {
  slot?: UpgradeSlot;
  rollback?: boolean;
  /** How a built tree gets its dependencies (tests inject a no-op). */
  install?: DependencyInstall;
  /** How a runner upgrade restarts its unit (tests inject a recorder). */
  restart?: () => Promise<void>;
  /**
   * Whether to wait for another upgrade building the same commit (default true). A pass that must not
   * be held by a build, such as `maintain`, passes false and reports `busy` instead.
   */
  waitForInstallLock?: boolean;
}

/**
 * One `upgrade`: the client slot unless `slot` names the runner's, forward unless `rollback`. It
 * throws only the refusal of a machine with no `upgradeSource`; a build, verification, fetch, link or
 * restart that fails is an outcome the caller reports, with the slot left where it was.
 */
export async function upgradeMachine(options: UpgradeOptions = {}): Promise<UpgradeOutcome> {
  const slot = options.slot ?? "client";
  // Refuse before anything changes: a host without the unit has no runner to upgrade.
  if (slot === "runner") await assertRunnerUnit();
  const result = options.rollback ? await rollbackSlot(slot) : await upgradeSlot(slot, options);
  let { action, reason } = result;
  let command: string | null = null;
  // The command follows the current slot: after any client upgrade or rollback, PATH must run what the
  // slot names rather than the bun global package the machine was installed from. It is attempted on
  // every upgrade, so one whose adoption failed is repaired by the next, including a `current` one.
  if (slot === "client" && existsSync(join(currentSlotPath(), LAUNCHER))) {
    try {
      const adoption = await adoptCommand();
      command = adoption.command;
      if (adoption.refusal) {
        if (action !== "failed") reason = adoption.refusal;
      } else if (adoption.changed && action === "current") {
        reason = `the slot was already at ${short(result.to)}, so the slipjay command was pointed at it`;
      }
    } catch (error) {
      if (action !== "failed") {
        action = "failed";
        reason = `the current slot is at ${short(result.to)} but the slipjay command could not be pointed at it: ${message(error)}`;
      }
    }
  }
  // A runner slot is only in effect once the unit runs it: prove the unit's command is the runner's
  // install before restarting onto it, so a runner never runs the client's slot.
  if (slot === "runner" && (action === "upgraded" || action === "rolled-back" || action === "current")) {
    const unit = await runnerUnit();
    if (unit.state !== "unit") {
      action = "failed";
      reason = `could not read the slipjay-runner unit's ExecStart (${unit.state === "unknown" ? unit.reason : "no unit"}), so what the runner would run is unproven`;
    } else if (!runsRunnerSlot(unit.execStart)) {
      action = "failed";
      reason = setupRunnerRefusal(unit.execStart);
    } else if (action !== "current") {
      try { await (options.restart ?? restartRunnerUnit)(); }
      catch (error) { action = "failed"; reason = message(error); }
    }
  }
  await pruneInstalls().catch(() => []);
  return { slot, from: result.from, to: result.to, action, reason, command };
}

/**
 * Remove installs no slot or rollback points at once they are older than a week, and any archive or
 * temporary tree a killed build left behind after a day. The two slots' targets and their rollbacks
 * are always kept, so a rollback always finds its install.
 */
export async function pruneInstalls(now: number = Date.now()): Promise<string[]> {
  const keep = await referencedInstalls();
  const entries = await readdir(installsHome(), { withFileTypes: true }).catch(() => []);
  const removed: string[] = [];
  for (const entry of entries) {
    const install = INSTALL_NAME.test(entry.name) && entry.isDirectory();
    const leftover = LEFTOVER_NAME.test(entry.name);
    if ((!install && !leftover) || keep.has(entry.name)) continue;
    const path = join(installsHome(), entry.name);
    const info = await stat(path).catch(() => null);
    if (!info || now - info.mtimeMs < (install ? INSTALL_RETENTION_MS : LEFTOVER_RETENTION_MS)) continue;
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    removed.push(entry.name);
  }
  return removed;
}

/**
 * Whether a landing from `cwd` publishes to the repository this machine upgrades from: the landing's
 * integration checkout is the one `upgradeSource` names, so the machine should install what landed.
 */
export async function landingUpgradesThisMachine(cwd: string): Promise<boolean> {
  const source = configuredUpgradeSource();
  if (!source || !isAbsolute(source)) return false;
  const context = await workspaceContext(cwd).catch(() => null);
  return Boolean(context && checkoutIdentity(context.integration.root) === checkoutIdentity(source));
}

/** The launcher a detached upgrade runs: the current slot's once the machine has one, else this package's. */
const upgradeLauncher = (): string => {
  const installed = join(currentSlotPath(), LAUNCHER);
  return existsSync(installed) ? installed : fileURLToPath(new URL("../../launcher/workspace.ts", import.meta.url));
};

/** Start a detached client upgrade. Its outcome is in `state/upgrade.log`, never in the caller. */
export async function startClientUpgrade(): Promise<{ started: boolean; reason?: string }> {
  return spawnDetached([bunRuntime(), upgradeLauncher(), "upgrade"], slipjayHome(), { logPath: upgradeLogPath() });
}

/**
 * `start` triggers an automatic client upgrade at most once per 10 minutes per machine: the stamp is
 * written before the child starts, so a burst of starts spawns one upgrade. Only the spawn is awaited,
 * never the upgrade. A machine with no upgrade source skips it silently.
 */
export async function startClientUpgradeThrottled(): Promise<{ started: boolean; reason?: string }> {
  if (!configuredUpgradeSource()) return { started: false, reason: "no upgrade source" };
  const fresh = async () => {
    const triggeredAt = await stat(upgradeTriggerStampPath()).then((info) => info.mtimeMs, () => 0);
    // A stamp from the future (the clock moved back) proves nothing.
    const age = Date.now() - triggeredAt;
    return age >= 0 && age < UPGRADE_TRIGGER_INTERVAL_MS;
  };
  if (await fresh()) return { started: false, reason: "an upgrade started within the last 10 minutes" };
  try {
    return await withWorkspaceTransaction("upgrade-trigger", async () => {
      if (await fresh()) return { started: false, reason: "an upgrade started within the last 10 minutes" };
      await mkdir(stateHome(), { recursive: true, mode: 0o700 });
      await writeFile(upgradeTriggerStampPath(), "");
      return await startClientUpgrade();
    }, { wait: false });
  } catch (error) { return { started: false, reason: message(error) }; }
}
