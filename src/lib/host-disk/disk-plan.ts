/**
 * The host disk planner (SJ-226): a pure function of the policy, the filesystem usage and what the
 * host reports about each managed directory. Everything that touches the clock, the disk or a process
 * is injected, so a test plans with fakes and the command plans with the real readers. The applier
 * (disk-apply.ts) executes exactly the rows this returns, so `--plan` and a real pass cannot disagree.
 */
import { join } from "node:path";
import { EVICTION_IDLE_MS } from "../workspace/workspace-eviction.ts";
import { describeHolders, within } from "../workspace/workspace-holders.ts";
import type { ProcessWorkingDirectory } from "../workspace/workspace-holders.ts";
import type { DiskConfig, DiskThresholds } from "./disk-config.ts";

export type DiskLevel = "ok" | "warn" | "shed" | "refill-stop" | "critical";
export type RowClass = "regenerable" | "scratch" | "evidence" | "workspace";
export type RowAction = "keep" | "remove" | "archive-and-prune" | "report";

export type DiskRow = {
  path: string;
  class: RowClass;
  sizeBytes: number;
  owner: string | null;
  action: RowAction;
  reason: string;
};

export type OverCapFlag = { issue: string; sizeBytes: number; owner: string | null };

export type BallastPlan = { path: string; bytes: number; present: boolean; sizeBytes: number; action: "keep" | "remove" | "create"; reason: string };

export type DiskUsage = { percent: number; totalBytes?: number; freeBytes?: number };

/** An evidence directory's `manifest.json`. `forgeNumber` is the Forge-wide number of the Issue it belongs to: the directory name is only a label, and a ref's digits are not a number in every repository. */
export type EvidenceManifest = { issue: string; owner: string; created: string; forgeNumber?: number; expires?: string; pin?: true };

export type ManifestRead = { manifest: EvidenceManifest } | { problem: string };

export type PathStat = { mtimeMs: number; uid: number; isDirectory: boolean; isSymlink: boolean; realPath: string };

/** What the planner asks of the host. Each answer may be null: unknown always keeps. */
export type DiskHost = {
  /** Names of the direct children of a directory, or null when it cannot be read (a missing root is `[]`). */
  readDir(path: string): Promise<string[] | null>;
  stat(path: string): Promise<PathStat | null>;
  sizeOf(path: string): Promise<number | null>;
  /** Live processes working inside the path; null when they cannot be read. */
  holders(path: string): Promise<ProcessWorkingDirectory[] | null>;
  /** Whether any file under the path changed within the last `minutes`; null when it cannot be told. */
  recentlyModified(path: string, minutes: number): Promise<boolean | null>;
  readManifest(path: string): Promise<ManifestRead>;
  /** Whether the Forge item with this number is closed, the way `prune --empty` decides it; null when unknown. */
  issueClosed(forgeNumber: number): Promise<boolean | null>;
  /** The uid of the host user. */
  uid: number;
  ballast(path: string): Promise<{ present: boolean; sizeBytes: number }>;
  /** The existing idle-workspace eviction plan, at this idle time, of every registered integration root. */
  workspaceRows(idleMs: number): Promise<DiskRow[]>;
};

export type HostDiskPlan = {
  usagePercent: number;
  level: DiskLevel;
  rows: DiskRow[];
  flags: OverCapFlag[];
  ballast: BallastPlan | null;
  /** The idle time workspaces are judged at: one hour once the host sheds, else eviction's own default, so `disk --plan` and `evict --plan` agree. */
  workspaceIdleMs: number;
};

export const HOUR_MS = 60 * 60_000;
export const MIB = 1024 * 1024;

export function diskLevel(percent: number, thresholds: DiskThresholds): DiskLevel {
  if (percent >= thresholds.criticalPercent) return "critical";
  if (percent >= thresholds.refillPercent) return "refill-stop";
  if (percent >= thresholds.shedPercent) return "shed";
  return percent >= thresholds.warnPercent ? "warn" : "ok";
}

/** Whether the level is `shed` or worse. */
export const shedding = (level: DiskLevel): boolean => level !== "ok" && level !== "warn";

/** Rows whose keep is routine, not a guard: a command prints these only under `--plan`. */
export const ROUTINE_KEEP = /^(younger than|removed only at|within )/;

function globRegex(glob: string): RegExp {
  const source = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`);
}

async function plannedRegenerable(config: DiskConfig, level: DiskLevel, host: DiskHost): Promise<DiskRow[]> {
  const rows: DiskRow[] = [];
  for (const path of config.regenerable) {
    const stat = await host.stat(path);
    if (!stat) continue;
    const base = { path, class: "regenerable" as const, sizeBytes: (await host.sizeOf(path)) ?? 0, owner: String(stat.uid) };
    rows.push(shedding(level)
      ? { ...base, action: "remove", reason: `regenerable cache, host at ${level}` }
      : { ...base, action: "keep", reason: `removed only at shed or worse (host is ${level})` });
  }
  return rows;
}

async function plannedScratch(config: DiskConfig, now: number, host: DiskHost): Promise<DiskRow[]> {
  const rows: DiskRow[] = [];
  for (const root of config.scratchRoots) {
    const names = await host.readDir(root.path);
    if (names === null) { rows.push({ path: root.path, class: "scratch", sizeBytes: 0, owner: null, action: "keep", reason: "cannot read the scratch root" }); continue; }
    const matchers = root.match.map(globRegex);
    const rootStat = await host.stat(root.path);
    for (const name of names.filter((entry) => matchers.some((matcher) => matcher.test(entry))).sort()) {
      const path = join(root.path, name);
      const stat = await host.stat(path);
      if (!stat) continue;
      const base = { path, class: "scratch" as const, sizeBytes: (await host.sizeOf(path)) ?? 0, owner: String(stat.uid) };
      const keep = (reason: string): DiskRow => ({ ...base, action: "keep", reason });
      // Guards first: each fails closed, and a keep says which one held.
      if (stat.isSymlink || !rootStat || !within(stat.realPath, rootStat.realPath) || stat.realPath === rootStat.realPath) { rows.push(keep("lies outside the declared scratch root")); continue; }
      if (stat.uid !== host.uid) { rows.push(keep(`not owned by the host user (uid ${stat.uid})`)); continue; }
      const holders = await host.holders(path);
      if (holders === null) { rows.push(keep("cannot read the processes using it")); continue; }
      if (holders.length) { rows.push(keep(`held by a live process: ${describeHolders(holders)}`)); continue; }
      const ageMs = now - stat.mtimeMs;
      if (ageMs < root.ttlHours * HOUR_MS) { rows.push(keep(`younger than ${root.ttlHours}h (${Math.max(0, Math.floor(ageMs / HOUR_MS))}h old)`)); continue; }
      // A directory's own time moves only when its direct children do: a build writing deeper looks idle.
      const written = await host.recentlyModified(path, Math.ceil(root.ttlHours * 60));
      if (written === null) { rows.push(keep("cannot tell whether files in it are still being written")); continue; }
      if (written) { rows.push(keep(`a file in it changed within ${root.ttlHours}h`)); continue; }
      rows.push({ ...base, action: "remove", reason: `scratch idle ${Math.floor(ageMs / HOUR_MS)}h, past ${root.ttlHours}h` });
    }
  }
  return rows;
}

async function plannedEvidence(config: DiskConfig, now: number, host: DiskHost): Promise<{ rows: DiskRow[]; flags: OverCapFlag[] }> {
  const rows: DiskRow[] = [];
  const flags: OverCapFlag[] = [];
  const names = await host.readDir(config.runRoot);
  if (names === null) return { rows: [{ path: config.runRoot, class: "evidence", sizeBytes: 0, owner: null, action: "report", reason: "cannot read the run root" }], flags };
  for (const name of [...names].sort()) {
    const path = join(config.runRoot, name);
    const stat = await host.stat(path);
    if (!stat) continue;
    if (!stat.isDirectory || stat.isSymlink) { rows.push({ path, class: "evidence", sizeBytes: 0, owner: String(stat.uid), action: "report", reason: "a link or file, not an evidence directory: not managed" }); continue; }
    const sizeBytes = (await host.sizeOf(path)) ?? 0;
    const read = await host.readManifest(path);
    const manifest = "manifest" in read ? read.manifest : null;
    const owner = manifest?.owner ?? null;
    if (sizeBytes > config.issueCapBytes) flags.push({ issue: manifest?.issue ?? name, sizeBytes, owner });
    const report = (reason: string): DiskRow => ({ path, class: "evidence", sizeBytes, owner, action: "report", reason });
    if (!manifest) { rows.push(report(`no usable manifest.json: ${"problem" in read ? read.problem : "missing"}`)); continue; }
    if (manifest.issue !== name) { rows.push(report(`manifest names issue ${manifest.issue}, not ${name}`)); continue; }
    if (manifest.pin === true) { rows.push(report("pinned")); continue; }
    if (manifest.expires === undefined) { rows.push(report("no expiry recorded")); continue; }
    const expires = Date.parse(manifest.expires);
    if (!Number.isFinite(expires)) { rows.push(report(`expires is not a date: ${manifest.expires}`)); continue; }
    if (expires > now) { rows.push(report(`not expired until ${manifest.expires}`)); continue; }
    if (manifest.forgeNumber === undefined) { rows.push(report("the manifest names no Forge number, so the Issue's state cannot be read")); continue; }
    const closed = await host.issueClosed(manifest.forgeNumber).catch(() => null);
    if (closed === null) { rows.push(report("the Issue's state cannot be read")); continue; }
    if (!closed) { rows.push(report("the Issue is not closed")); continue; }
    const holders = await host.holders(path);
    if (holders === null) { rows.push(report("cannot read the processes using it")); continue; }
    if (holders.length) { rows.push(report(`held by a live process: ${describeHolders(holders)}`)); continue; }
    rows.push({ path, class: "evidence", sizeBytes, owner, action: "archive-and-prune", reason: `Issue closed and expired ${manifest.expires}` });
  }
  return { rows, flags };
}

async function plannedBallast(config: DiskConfig, usage: DiskUsage, level: DiskLevel, host: DiskHost): Promise<BallastPlan | null> {
  const { path, bytes } = config.ballast;
  if (bytes <= 0) return null;
  const { present, sizeBytes } = await host.ballast(path);
  if (level === "critical") {
    return present
      ? { path, bytes, present, sizeBytes, action: "remove", reason: `disk at ${usage.percent}% (critical ${config.thresholds.criticalPercent}%): releasing the ballast` }
      : { path, bytes, present, sizeBytes, action: "keep", reason: `disk is critical and the ballast is already released` };
  }
  if (present) return { path, bytes, present, sizeBytes, action: "keep", reason: "ballast in place" };
  if (usage.percent >= config.thresholds.ballastRecreatePercent) {
    return { path, bytes, present, sizeBytes, action: "keep", reason: `absent; recreated only below ${config.thresholds.ballastRecreatePercent}% (disk at ${usage.percent}%)` };
  }
  // Never recreate a ballast that would itself push the disk past the recreate threshold.
  if (usage.totalBytes && ((usage.percent / 100) * usage.totalBytes + bytes) / usage.totalBytes * 100 >= config.thresholds.ballastRecreatePercent) {
    return { path, bytes, present, sizeBytes, action: "keep", reason: `absent; recreating ${bytes} bytes would take the disk past ${config.thresholds.ballastRecreatePercent}%` };
  }
  return { path, bytes, present, sizeBytes, action: "create", reason: `absent and disk at ${usage.percent}% (below ${config.thresholds.ballastRecreatePercent}%)` };
}

/** What the host disk policy would do now, changing nothing. */
export async function planHostDisk(input: { config: DiskConfig; usage: DiskUsage; now: number; host: DiskHost }): Promise<HostDiskPlan> {
  const { config, usage, now, host } = input;
  const level = diskLevel(usage.percent, config.thresholds);
  const evidence = await plannedEvidence(config, now, host);
  const workspaceIdleMs = shedding(level) ? HOUR_MS : EVICTION_IDLE_MS;
  const rows = [
    ...await plannedRegenerable(config, level, host),
    ...await plannedScratch(config, now, host),
    ...evidence.rows,
    // The existing eviction's own plan, unchanged, at eviction's own idle time unless the host is shedding.
    ...await host.workspaceRows(workspaceIdleMs),
  ];
  return { usagePercent: usage.percent, level, rows, flags: evidence.flags, ballast: await plannedBallast(config, usage, level, host), workspaceIdleMs };
}
