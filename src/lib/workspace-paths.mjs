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

/** slipjay's home: `~/.slipjay`. */
export const slipjayHome = () => join(homedir(), ".slipjay");

/** Written as the last step of `slipjay cutover`; its presence settles the cutover. */
export const cutoverMarkerPath = () => join(slipjayHome(), "cutover.json");

/** Slipway's locations, read only by the cutover (and kept usable for existing workspaces). */
export const legacyHome = () => join(homedir(), ".slipway");
export const legacyStateHome = () => join(legacyHome(), "state");
export const legacyModePath = () => join(legacyHome(), "mode.json");
export const legacyWorkspaceHome = () => join(legacyHome(), "workspaces");

export const CUTOVER_REQUIRED_CODE = "SLIPJAY_CUTOVER_REQUIRED";

/** Slipway state exists on this machine and `slipjay cutover` has not run. */
export function cutoverPending() {
  return !existsSync(cutoverMarkerPath()) && (existsSync(legacyStateHome()) || existsSync(legacyModePath()));
}

/** Refuses while the cutover is pending, naming the command that settles it. */
export function assertCutoverSettled() {
  if (!cutoverPending()) return;
  const error = new Error(`slipjay state still lives under ${legacyStateHome()} (Slipway's). `
    + "Run `slipjay cutover` once while nothing is landing, then retry.");
  error.code = CUTOVER_REQUIRED_CODE;
  throw error;
}

const settled = (path) => { assertCutoverSettled(); return path; };

/** Where new isolated JJ workspaces are created: `~/.slipjay/workspaces`. */
export const workspaceHome = () => settled(join(slipjayHome(), "workspaces"));

/**
 * Every directory workspaces were created in: the current home, then Slipway's,
 * whose existing workspaces stay usable at their recorded paths.
 */
export const workspaceStorageHomes = () => [workspaceHome(), legacyWorkspaceHome()];

/** Checkout mode (`isolated`/`direct`) chosen through `slipjay mode`. */
export const modePath = () => settled(join(slipjayHome(), "mode.json"));

/** Machine-local landing state: top-level landing sidecars and verification slots. */
export const stateHome = () => settled(join(slipjayHome(), "state"));

/** When `start` last refreshed each integration branch from its remote. */
export const startFetchHome = () => join(stateHome(), "start-fetches");

/** Legacy per-workspace owner records and primary-checkout writer records. */
export const lockHome = () => join(stateHome(), "locks");

/** Per-workspace metadata (Issue, task, spare readiness). */
export const metadataHome = () => join(stateHome(), "workspaces");

/** Legacy landing sidecars and integrated-artifact evidence. */
export const landedHome = () => join(stateHome(), "landed");

/** Cross-process transaction locks. */
export const transactionHome = () => join(stateHome(), "transactions");

/** Background post-land verification records, logs and queues. */
export const postLandHome = () => join(stateHome(), "post-land");

/** Post-integration finalization receipts and locks. */
export const postIntegrationHome = () => join(stateHome(), "post-integration");

/** The detached spare refill's append-only log. */
export const poolRefillLogPath = () => join(stateHome(), "pool-refill.log");
