import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startBackgroundEntry } from "./workspace-background.ts";
import { workspaceContext } from "../infra/workspace-jj.ts";
import type { WorkspaceContext } from "../infra/workspace-jj.ts";
import { stateHome } from "./workspace-paths.ts";
import { readJsonOptional } from "./workspace-state.ts";
import { sweepDisposableWorkspaces } from "./workspace-sweep.ts";
import type { SweepOptions, SweepResult } from "./workspace-sweep.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "../infra/workspace-transaction.ts";

/** Minimum time between background sweeps of one repository. */
export const HOUSEKEEPING_INTERVAL_MS: number = 15 * 60_000;

export type HousekeepingOutcome =
  | { ran: true; result: SweepResult }
  | { ran: false; reason: "running" | "recent" };

const stampPath = (root: string) => join(stateHome(), "housekeeping", `${createHash("sha256").update(root).digest("hex")}.json`);

async function recentlySwept(root: string, now: number, intervalMs: number) {
  return now - ((await readJsonOptional<{ at?: number }>(stampPath(root)))?.at ?? 0) < intervalMs;
}

/**
 * One bounded sweep of the repository at `root` for every surface that allocates
 * a workspace, so unused checkouts retire without any landing or manual prune.
 * Triggers serialise per repository (another repository's sweep never waits on
 * this one): a trigger finding a sweep running or finished within `intervalMs`
 * does nothing, so concurrent triggers converge on exactly one sweep. The stamp
 * records the attempt before sweeping, so a sweep that keeps failing is retried
 * at the same bounded rate.
 */
export async function runHousekeeping(root: string, options: SweepOptions & { intervalMs?: number } = {}): Promise<HousekeepingOutcome> {
  const { intervalMs = HOUSEKEEPING_INTERVAL_MS, ...sweep } = options;
  try {
    return await withWorkspaceTransaction(`housekeeping:${root}`, async () => {
      const now = sweep.now ?? Date.now();
      if (await recentlySwept(root, now, intervalMs)) return { ran: false as const, reason: "recent" as const };
      await mkdir(join(stateHome(), "housekeeping"), { recursive: true, mode: 0o700 });
      await writeWorkspaceJson(stampPath(root), { at: now });
      return { ran: true as const, result: await sweepDisposableWorkspaces(root, sweep) };
    }, { wait: false });
  } catch (error) {
    if ((error as { code?: string } | null | undefined)?.code === "ELOCKED") return { ran: false, reason: "running" };
    throw error;
  }
}

/** Sweep the repository in a detached child without delaying the caller; see `startBackgroundEntry`. */
export async function startHousekeeping(cwd: string = process.cwd(), options: { command?: string[] } = {}): ReturnType<typeof startBackgroundEntry> {
  if (process.env.SLIPJAY_AUTO_HOUSEKEEPING === "0") return { started: false, reason: "disabled" };
  const context = await workspaceContext(cwd);
  if (!context) return { started: false, reason: "not-jj" };
  // A sweep that ran recently needs no child, so frequent allocations cost one small read.
  // The stamp is keyed by the integration root, which is what the child sweeps.
  if (await recentlySwept(context.integration.root, Date.now(), HOUSEKEEPING_INTERVAL_MS)) return { started: false, reason: "recent" };
  return await startBackgroundEntry(context.integration.root, "../../launcher/housekeeping-run.ts", options);
}

/**
 * A landing's own housekeeping, started once its verdict is known: a detached child releases the
 * landed workspace (unless it is the integration checkout), then sweeps the repository's other
 * delivered or idle checkouts at once, whatever the interval. Deleting a checkout takes minutes in
 * a large repository, so none of it delays the verdict; each outcome is a line in the background
 * log. `ignore` are the landing's own processes and the session that ran it, which never keep the
 * landed workspace, as `releaseLandedWorkspace` ignores its caller's.
 */
export async function startLandedHousekeeping(context: WorkspaceContext, ignore: Iterable<number>, options: { command?: string[] } = {}): ReturnType<typeof startBackgroundEntry> {
  const args = ["--landing", "--ignore", [...ignore].join(","), ...context.current.name === "default" ? [] : ["--release", context.current.root]];
  return await startBackgroundEntry(context.integration.root, "../../launcher/housekeeping-run.ts", { ...options, args });
}
