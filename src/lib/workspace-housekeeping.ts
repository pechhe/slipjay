import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { startBackgroundEntry } from "./workspace-background.ts";
import { stateHome } from "./workspace-paths.ts";
import { readJsonOptional } from "./workspace-state.ts";
import { sweepDisposableWorkspaces } from "./workspace-sweep.ts";
import type { SweepOptions, SweepResult } from "./workspace-sweep.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "./workspace-transaction.ts";

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
 * does nothing, so concurrent triggers converge on exactly one sweep.
 */
export async function runHousekeeping(root: string, options: SweepOptions & { intervalMs?: number } = {}): Promise<HousekeepingOutcome> {
  const { intervalMs = HOUSEKEEPING_INTERVAL_MS, ...sweep } = options;
  try {
    return await withWorkspaceTransaction(`housekeeping:${root}`, async () => {
      const now = sweep.now ?? Date.now();
      if (await recentlySwept(root, now, intervalMs)) return { ran: false as const, reason: "recent" as const };
      await mkdir(join(stateHome(), "housekeeping"), { recursive: true, mode: 0o700 });
      const result = await sweepDisposableWorkspaces(root, sweep);
      await writeWorkspaceJson(stampPath(root), { at: now });
      return { ran: true as const, result };
    }, { wait: false });
  } catch (error) {
    if ((error as { code?: string } | null | undefined)?.code === "ELOCKED") return { ran: false, reason: "running" };
    throw error;
  }
}

/** Sweep the repository in a detached child without delaying the caller; see `startBackgroundEntry`. */
export async function startHousekeeping(cwd: string = process.cwd(), options: { command?: string[] } = {}): ReturnType<typeof startBackgroundEntry> {
  if (process.env.SLIPJAY_AUTO_HOUSEKEEPING === "0") return { started: false, reason: "disabled" };
  // A sweep that ran recently needs no child, so frequent allocations cost one small read.
  if (await recentlySwept(cwd, Date.now(), HOUSEKEEPING_INTERVAL_MS)) return { started: false, reason: "recent" };
  return await startBackgroundEntry(cwd, "./housekeeping-run.ts", options);
}
