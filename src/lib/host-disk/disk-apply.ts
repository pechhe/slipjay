/**
 * Executes a host disk plan's rows (SJ-226). Nothing here decides: the planner (disk-plan.ts) did, and a
 * row it kept stays kept. Removals and the ballast go through injected operations so tests run with fakes.
 */
import { spawn } from "node:child_process";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { archiveEvidence } from "./disk-archive.ts";
import type { ArchiveSummary } from "./disk-archive.ts";
import type { BallastPlan, DiskHost, DiskRow, HostDiskPlan } from "./disk-plan.ts";

export type RowOutcome = "removed" | "archived" | "kept" | "failed";

export type RowResult = DiskRow & {
  outcome: RowOutcome;
  /** What became of the row, in words: the reason it was kept or why it failed. */
  detail: string;
  archive?: ArchiveSummary;
};

export type BallastResult = BallastPlan & { outcome: "released" | "created" | "kept" | "failed"; detail: string };

export type DiskOps = {
  remove(path: string): Promise<void>;
  allocate(path: string, bytes: number): Promise<void>;
  archive(directory: string, manifest: { issue: string; owner: string }, now: number): Promise<ArchiveSummary>;
  /** Runs the existing idle-workspace eviction and answers which checkouts it evicted (by root). */
  evictWorkspaces(idleMs: number): Promise<{ evicted: Set<string>; failed: Array<{ root: string; reason: string }> }>;
  /** Whether a process holds the path right now (a fresh look, not the plan's): true also when that cannot be read. */
  held?(path: string): Promise<boolean>;
  readManifest: DiskHost["readManifest"];
};

const runCommand = (command: string, args: string[]): Promise<boolean> => new Promise((resolve) => {
  const child = spawn(command, args, { stdio: "ignore" });
  child.on("error", () => resolve(false));
  child.on("close", (code) => resolve(code === 0));
});

/**
 * A ballast of real blocks: `fallocate` where the host has it, else zeroes written in chunks. A sparse
 * file would hold no space to give back, so a file whose blocks are short of its size is refused.
 */
export async function allocateBallast(path: string, bytes: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const partial = `${path}.partial`;
  await rm(partial, { force: true });
  try {
    if (!await runCommand("fallocate", ["-l", String(bytes), partial])) {
      await rm(partial, { force: true });
      const handle = await open(partial, "w", 0o600);
      try {
        const chunk = Buffer.alloc(Math.min(bytes, 8 * 1024 * 1024));
        for (let written = 0; written < bytes; written += chunk.length) {
          await handle.write(chunk, 0, Math.min(chunk.length, bytes - written));
        }
        await handle.sync();
      } finally { await handle.close(); }
    }
    const info = await stat(partial);
    if (info.size !== bytes || info.blocks * 512 < bytes) throw new Error(`the ballast is sparse or short (${info.size} bytes, ${info.blocks * 512} allocated)`);
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    throw error;
  }
}

export const realOps = (host: Pick<DiskHost, "readManifest">, evictWorkspaces: DiskOps["evictWorkspaces"]): DiskOps => ({
  remove: (path) => rm(path, { recursive: true, force: true }),
  allocate: allocateBallast,
  archive: archiveEvidence,
  evictWorkspaces,
  readManifest: host.readManifest,
});

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export type ApplyResult = { rows: RowResult[]; ballast: BallastResult | null; failures: number };

/** Execute the plan. Failures never stop the rest; each is a `failed` outcome and counted. */
export async function applyHostDisk(plan: HostDiskPlan, ops: DiskOps, now: number): Promise<ApplyResult> {
  let ballast: BallastResult | null = null;
  // The ballast is released first: at critical, headroom is the point.
  if (plan.ballast?.action === "remove") {
    ballast = await ops.remove(plan.ballast.path).then(
      (): BallastResult => ({ ...plan.ballast!, outcome: "released", detail: `CRITICAL: ${plan.ballast!.reason}` }),
      (error: unknown): BallastResult => ({ ...plan.ballast!, outcome: "failed", detail: `could not release the ballast: ${message(error)}` }),
    );
  }
  const rows: RowResult[] = [];
  let workspaces: Awaited<ReturnType<DiskOps["evictWorkspaces"]>> | null = null;
  const workspaceRows = plan.rows.filter((row) => row.class === "workspace");
  // On a healthy disk the plan still shows eviction's verdict, but `maintain`'s hourly pass does the evicting: this pass
  // runs every few minutes and must stay cheap.
  const deferWorkspaces = plan.level === "ok" || plan.level === "warn";
  if (workspaceRows.length && !deferWorkspaces) {
    workspaces = await ops.evictWorkspaces(plan.workspaceIdleMs).catch((error: unknown) => ({ evicted: new Set<string>(), failed: [{ root: "", reason: message(error) }] }));
  }
  for (const row of plan.rows) {
    if (row.class === "workspace") {
      if (row.action !== "remove") rows.push({ ...row, outcome: "kept", detail: row.reason });
      else if (deferWorkspaces) rows.push({ ...row, outcome: "kept", detail: `${row.reason}; left to maintain's hourly eviction while the disk is healthy` });
      else if (workspaces?.evicted.has(row.path)) rows.push({ ...row, outcome: "removed", detail: row.reason });
      else {
        const failure = workspaces?.failed.find((entry) => entry.root === row.path);
        rows.push(failure ? { ...row, outcome: "failed", detail: failure.reason } : { ...row, outcome: "kept", detail: "in use or changed while evicting" });
      }
    } else if (row.action === "remove") {
      // Judged again at the moment of removal: the plan may be minutes old (a `du` can take two).
      if (row.class === "scratch" && await ops.held?.(row.path)) { rows.push({ ...row, action: "keep", outcome: "kept", detail: "kept: a process holds it now, or it cannot be told" }); continue; }
      rows.push(await ops.remove(row.path).then(
        (): RowResult => ({ ...row, outcome: "removed", detail: row.reason }),
        (error: unknown): RowResult => ({ ...row, outcome: "failed", detail: `${row.reason}; removal failed: ${message(error)}` }),
      ));
    } else if (row.action === "archive-and-prune") {
      rows.push(await archiveAndPrune(row, ops, now));
    } else rows.push({ ...row, outcome: "kept", detail: row.reason });
  }
  for (const failure of workspaces?.failed ?? []) {
    if (!rows.some((row) => row.path === failure.root)) {
      rows.push({ path: failure.root || "(workspaces)", class: "workspace", sizeBytes: 0, owner: null, action: "report", reason: failure.reason, outcome: "failed", detail: failure.reason });
    }
  }
  if (plan.ballast?.action === "create") {
    ballast = await ops.allocate(plan.ballast.path, plan.ballast.bytes).then(
      (): BallastResult => ({ ...plan.ballast!, outcome: "created", detail: plan.ballast!.reason }),
      (error: unknown): BallastResult => ({ ...plan.ballast!, outcome: "failed", detail: `could not recreate the ballast: ${message(error)}` }),
    );
  } else if (plan.ballast && !ballast) ballast = { ...plan.ballast, outcome: "kept", detail: plan.ballast.reason };
  const failures = rows.filter((row) => row.outcome === "failed").length + (ballast?.outcome === "failed" ? 1 : 0);
  return { rows, ballast, failures };
}

async function archiveAndPrune(row: DiskRow, ops: DiskOps, now: number): Promise<RowResult> {
  if (await ops.held?.(row.path)) return { ...row, action: "report", outcome: "kept", detail: "kept: a process holds it now, or it cannot be told" };
  const read = await ops.readManifest(row.path);
  if (!("manifest" in read)) return { ...row, outcome: "kept", detail: `kept: manifest unreadable at removal (${read.problem})` };
  // Judged again at the moment of removal: a pin added since the plan keeps it.
  if (read.manifest.pin === true) return { ...row, action: "report", outcome: "kept", detail: "kept: pinned since it was planned" };
  // The expiry and the manifest's own issue are judged again too: an extension or a rename since the plan keeps it.
  const expires = read.manifest.expires === undefined ? NaN : Date.parse(read.manifest.expires);
  if (!Number.isFinite(expires) || expires > now) return { ...row, action: "report", outcome: "kept", detail: "kept: no longer expired since it was planned" };
  if (read.manifest.issue !== basename(row.path)) return { ...row, action: "report", outcome: "kept", detail: "kept: the manifest's issue no longer matches the directory" };
  let archive: ArchiveSummary;
  try { archive = await ops.archive(row.path, read.manifest, now); }
  catch (error) { return { ...row, action: "report", outcome: "kept", detail: `kept everything: ${message(error)}` }; }
  try { await ops.remove(row.path); }
  catch (error) { return { ...row, outcome: "failed", archive, detail: `archived to ${archive.directory} but removal failed: ${message(error)}` }; }
  return {
    ...row, outcome: "archived", archive,
    detail: `archived to ${archive.directory}: kept ${archive.keptFiles} files (${archive.keptBytes} bytes), dropped ${archive.droppedFiles} files (${archive.droppedBytes} bytes)`,
  };
}
