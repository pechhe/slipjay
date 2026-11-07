import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Every filesystem location the landing tool owns, defined once. Each is read
 * from `HOME` at call time, so a hermetic test home applies to all of them.
 *
 * slipjay keeps its state, mode file and new workspaces under `~/.slipjay`. A
 * machine that still holds Slipway's state under `~/.slipway` must run
 * `slipjay cutover` first: until then every state, mode and workspace accessor
 * refuses, so this release never writes a second lock store beside the old one.
 */

/** An Error that may carry the `code` the cutover refusal is matched by. */
interface CodedError extends Error {
  code?: string;
}

/** slipjay's home: `~/.slipjay`. */
export const slipjayHome = (): string => join(homedir(), ".slipjay");

/** This machine's SlipJay configuration: the runner location and machine-local limits. */
export const machineConfigPath = (): string => join(slipjayHome(), "config.json");

/** Written as the last step of `slipjay cutover`; its presence settles the cutover. */
export const cutoverMarkerPath = (): string => join(slipjayHome(), "cutover.json");

/** Slipway's locations, read only by the cutover (and kept usable for existing workspaces). */
export const legacyHome = (): string => join(homedir(), ".slipway");
export const legacyStateHome = (): string => join(legacyHome(), "state");
export const legacyModePath = (): string => join(legacyHome(), "mode.json");
export const legacyWorkspaceHome = (): string => join(legacyHome(), "workspaces");

export const CUTOVER_REQUIRED_CODE: "SLIPJAY_CUTOVER_REQUIRED" = "SLIPJAY_CUTOVER_REQUIRED";

/** Slipway state exists on this machine and `slipjay cutover` has not run. */
export function cutoverPending(): boolean {
  return !existsSync(cutoverMarkerPath()) && (existsSync(legacyStateHome()) || existsSync(legacyModePath()));
}

/** Refuses while the cutover is pending, naming the command that settles it. */
export function assertCutoverSettled(): void {
  if (!cutoverPending()) return;
  const error: CodedError = new Error(`slipjay state still lives under ${legacyStateHome()} (Slipway's). `
    + "Run `slipjay cutover` once while nothing is landing, then retry.");
  error.code = CUTOVER_REQUIRED_CODE;
  throw error;
}

const settled = (path: string): string => { assertCutoverSettled(); return path; };

/** Where new isolated JJ workspaces are created: `~/.slipjay/workspaces`. */
export const workspaceHome = (): string => settled(join(slipjayHome(), "workspaces"));

/**
 * Every directory workspaces were created in. Both state cutovers left existing
 * checkouts at their recorded paths, including those predating Slipway.
 */
export const workspaceStorageHomes = (): string[] => [workspaceHome(), legacyWorkspaceHome(), join(homedir(), ".pi", "workspaces")];

/** Checkout mode (`isolated`/`direct`) chosen through `slipjay mode`. */
export const modePath = (): string => settled(join(slipjayHome(), "mode.json"));

/** Removed checkouts awaiting background deletion; on the same volume as the workspaces, so moving one here is a rename. */
export const trashHome = (): string => settled(join(slipjayHome(), "trash"));

/** Machine-local landing state: top-level landing sidecars. */
export const stateHome = (): string => settled(join(slipjayHome(), "state"));

/** When `start` last refreshed each integration branch from its remote. */
export const startFetchHome = (): string => join(stateHome(), "start-fetches");

/** Built trees of landed commits, one directory per commit: `~/.slipjay/installs`. */
export const installsHome = (): string => settled(join(slipjayHome(), "installs"));

/** The install the `slipjay` command runs; `upgrade` swaps this symlink. */
export const currentSlotPath = (): string => settled(join(slipjayHome(), "current"));

/** The install the current slot replaced, which `upgrade --rollback` returns to. */
export const currentSlotPreviousPath = (): string => join(slipjayHome(), "current.previous");

/**
 * The install the runner service runs, and the one it replaced. Not `~/.slipjay/runner`: that is the
 * runner's own state home (its `config.json`, `stop-runner.sh` and corepack shims), so the slot
 * holding its code sits beside it and never replaces it.
 */
export const runnerSlotPath = (): string => settled(join(slipjayHome(), "runner-install"));
export const runnerSlotPreviousPath = (): string => join(slipjayHome(), "runner-install.previous");

/** The `slipjay` command on `PATH`, which the first `upgrade` links to the current slot. */
export const commandLinkPath = (): string => join(homedir(), ".bun", "bin", "slipjay");

/** The detached client upgrades' append-only log. */
export const upgradeLogPath = (): string => join(stateHome(), "upgrade.log");

/** When `start` last triggered an automatic client upgrade. */
export const upgradeTriggerStampPath = (): string => join(stateHome(), "upgrade-trigger.stamp");

/** Legacy per-workspace owner records. */
export const lockHome = (): string => join(stateHome(), "locks");

/** Per-workspace metadata (Issue, task, spare readiness). */
export const metadataHome = (): string => join(stateHome(), "workspaces");

/** Allocation attempts (`start --attempt`), one record per attempt id. */
export const attemptHome = (): string => join(stateHome(), "attempts");

/** Legacy landing sidecars and integrated-artifact evidence. */
export const landedHome = (): string => join(stateHome(), "landed");

/** Evidence preserved from retired workspaces, one directory per retirement with its `provenance.json`. */
export const evidenceHome = (): string => join(stateHome(), "evidence");

/** Cross-process transaction locks. */
export const transactionHome = (): string => join(stateHome(), "transactions");

/** Post-integration finalization receipts and locks. */
export const postIntegrationHome = (): string => join(stateHome(), "post-integration");

/** The detached spare refill's append-only log. */
export const poolRefillLogPath = (): string => join(stateHome(), "pool-refill.log");
/** Where the detached follower of a `slipjay land --no-wait` submission writes its outcome. */
export const landingFollowLogPath = (): string => join(stateHome(), "landing-follow.log");
