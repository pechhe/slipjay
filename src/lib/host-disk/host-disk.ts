/**
 * The host disk pass (SJ-226), shared by `slipjay disk` and `slipjay maintain`: read the policy and the
 * usage of the disk SlipJay's state lives on, plan every managed directory, and (unless planning) apply the
 * plan under the host-wide `host-disk` lock. Every reader is injectable; the defaults read the real host.
 */
import { operationStoreReports } from "./operation-stores.ts";
import type { OperationStoreReport } from "./operation-stores.ts";
import { freeSpaceFloor, belowFloor } from "./disk-floor.ts";
import { readHeartbeatWarning, writeDiskHeartbeat } from "./disk-heartbeat.ts";
import { randomUUID } from "node:crypto";
import { retireExcessSpares } from "../workspace/workspace-pool.ts";
import { releaseWorkspace } from "../workspace/workspace-release.ts";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { run, workspaceContext } from "../infra/workspace-jj.ts";
import { withWorkspaceTransaction } from "../infra/workspace-transaction.ts";
import { trackerIsBuild, trackerOf, workItemClosed } from "../build/tracker.ts";
import type { BuildReader } from "../build/tracker.ts";
import type { EvictionOutcome } from "../workspace/workspace-eviction.ts";
import { workspaceMetadata } from "../workspace/workspace-state.ts";
import { evictIdleWorkspaces } from "../workspace/workspace-eviction.ts";
import { processWorkingDirectories, workspaceHolders } from "../workspace/workspace-holders.ts";
import { holdersOfOpenFiles, openPathsByProcess } from "./disk-holders.ts";
import type { OpenPaths } from "./disk-holders.ts";
import type { ProcessWorkingDirectory } from "../workspace/workspace-holders.ts";
import { machineConfigPath, metadataHome, stateHome } from "../workspace/workspace-paths.ts";
import { lastKnownTouch } from "../workspace/workspace-idle.ts";
import { applyHostDisk, realOps } from "./disk-apply.ts";
import type { ApplyResult, DiskOps } from "./disk-apply.ts";
import { readDockerVolumes, readLoopImages } from "./disk-readers.ts";
import { readDiskConfig } from "./disk-config.ts";
import type { DiskConfig } from "./disk-config.ts";
import { HOUR_MS, planHostDisk } from "./disk-plan.ts";
import type { DiskHost, DiskRow, HostDiskPlan, ManifestRead } from "./disk-plan.ts";
import { cachedSizeOf } from "./size-cache.ts";
import { readHostUsage, usagePath } from "./disk-usage.ts";
import type { DiskUsageReader } from "./disk-usage.ts";

/** The idle threshold below the physical free-space floor: one hour. */
export const SHED_IDLE_MS: number = HOUR_MS;

export type HostDiskOptions = {
  plan?: boolean;
  maintain?: boolean;
  cwd?: string;
  now?: number;
  config?: DiskConfig;
  readUsage?: DiskUsageReader;
  host?: Partial<DiskHost>;
  ops?: Partial<DiskOps>;
  /** Reads Build for an Issue's state in a Build-tracked repository, as `prune --empty` does. */
  readBuild?: BuildReader;
  /** The integration roots with a registered workspace; defaults to those named in `~/.slipjay/state/workspaces/*.json`. */
  integrationRoots?: () => Promise<string[]>;
  /** How long to wait for another pass before giving up (default 2s). */
  lockWaitMs?: number;
};

export type HostDiskOutcome =
  | { state: "busy"; reason: string }
  | ({ state: "planned" | "applied"; applied: boolean } & HostDiskPlan & { results: ApplyResult["rows"]; ballastResult: ApplyResult["ballast"]; failures: number; operationStores?: OperationStoreReport[]; evictions?: EvictionOutcome; rescueEnvError?: string });

/** The distinct `integrationRoot` of every registered workspace, as `maintain.sh` finds the roots to maintain. */
export async function registeredIntegrationRoots(): Promise<string[]> {
  const roots = new Set<string>();
  for (const name of await readdir(metadataHome()).catch(() => [] as string[])) {
    if (!name.endsWith(".json")) continue;
    const root = await readFile(join(metadataHome(), name), "utf8").then((text) => (JSON.parse(text) as { integrationRoot?: unknown }).integrationRoot, () => undefined);
    if (typeof root === "string" && root && existsSync(root)) roots.add(root);
  }
  return [...roots].sort();
}

async function directorySize(path: string): Promise<number | null> {
  const result = await run("du", ["-sk", path], { timeoutMs: 2000 }).catch(() => null);
  const kilobytes = result ? Number.parseInt(result.stdout, 10) : NaN;
  return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
}

async function readManifest(directory: string): Promise<ManifestRead> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")); }
  catch (error) { return { problem: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable or not JSON" }; }
  const manifest = parsed as Record<string, unknown> | null;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return { problem: "not a JSON object" };
  const { issue, owner, created, expires, pin, forgeNumber } = manifest;
  if (typeof issue !== "string" || !issue || typeof owner !== "string" || typeof created !== "string") return { problem: "issue, owner and created must be strings" };
  if (expires !== undefined && typeof expires !== "string") return { problem: "expires must be a date string" };
  if (pin !== undefined && typeof pin !== "boolean") return { problem: "pin must be true or false" };
  if (forgeNumber !== undefined && (typeof forgeNumber !== "number" || !Number.isInteger(forgeNumber) || forgeNumber <= 0)) return { problem: "forgeNumber must be a positive integer" };
  return { manifest: { issue, owner, created, ...forgeNumber === undefined ? {} : { forgeNumber: forgeNumber as number }, ...expires === undefined ? {} : { expires }, ...pin === true ? { pin: true } : {} } };
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function realHost(options: HostDiskOptions, config: DiskConfig, evictions: EvictionOutcome): DiskHost {
  let processes: Promise<ProcessWorkingDirectory[] | null> | undefined;
  let openFiles: Promise<OpenPaths | null> | undefined;
  const roots = options.integrationRoots ?? registeredIntegrationRoots;
  const sizes = cachedSizeOf(directorySize, join(stateHome(), "disk-sizes.json"));
  return {
    readDir: async (path) => readdir(path).then((names) => names, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : null),
    stat: async (path) => {
      const info = await lstat(path).catch(() => null);
      if (!info) return null;
      return { mtimeMs: info.mtimeMs, uid: info.uid, isDirectory: info.isDirectory(), isSymlink: info.isSymbolicLink(), realPath: await realpath(path).catch(() => path) };
    },
    sizeOf: sizes,
    // Working directories and open or mapped files both count; either unreadable keeps the path.
    holders: async (path) => {
      const working = await workspaceHolders(path, { processes: await (processes ??= processWorkingDirectories()) }).catch(() => null);
      const open = await (openFiles ??= openPathsByProcess().catch(() => null));
      return working === null || open === null ? null : [...working, ...holdersOfOpenFiles(path, open)];
    },
    recentlyModified: async (path, minutes) => {
      if (minutes <= 0) return false;
      const found = await run("find", [path, "-xdev", "-type", "f", "-mmin", `-${minutes}`, "-print", "-quit"], { timeoutMs: 60_000 }).catch(() => null);
      if (!found) return null;
      if (found.stdout.trim()) return true;
      return found.code === 0 ? false : null;
    },
    readManifest,
    // Forge numbers are Forge-wide, so any Forge-tracked repository on the host can answer for any Issue. A GitHub
    // number belongs to one repository and the manifest does not name it: such a tracker never answers, and an
    // Issue nobody can read is kept.
    issueClosed: async (number) => {
      for (const root of [options.cwd ?? process.cwd(), ...await roots()]) {
        const context = await workspaceContext(root).catch(() => null);
        if (!context) continue;
        const tracker = trackerOf(context.configuration);
        if (trackerIsBuild(tracker)) return workItemClosed(context.integration.root, tracker, number, options.readBuild);
      }
      return null;
    },
    uid: process.getuid?.() ?? -1,
    ballast: async (path) => {
      const info = await stat(path).catch(() => null);
      return { present: Boolean(info?.isFile()), sizeBytes: info?.size ?? 0 };
    },
    workspaceRows: async (idleMs) => {
      const rows: DiskRow[] = [];
      for (const root of await roots()) {
        try {
          const planned = await evictIdleWorkspaces(root, { idleMs, plan: true, sizeOf: sizes, inspectRetirement: Boolean(options.maintain) });
          // Retirement diagnostics belong to the hourly pass, even when there are no dependencies to evict.
          evictions.unretirable.push(...planned.outcome.unretirable);
          for (const plan of planned.plans) {
            rows.push({
              path: plan.root, class: "workspace", sizeBytes: plan.sizeBytes ?? 0, owner: plan.name,
              action: plan.action === "evict" ? "remove" : "keep", reason: plan.reason,
              spare: plan.spare, idleSince: plan.idleSince, retirable: plan.retirable, repository: root,
              ...resolve(plan.root) === resolve(root) ? { integration: true as const } : {},
            });
          }
        } catch (error) {
          if (options.maintain) throw error;
          rows.push({ path: root, class: "workspace", sizeBytes: 0, owner: null, action: "report", reason: `cannot plan its eviction: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      return rows;
    },
    dockerVolumes: readDockerVolumes,
    loopImages: readLoopImages,
    ...options.host,
  } satisfies DiskHost;
}

/** Evict every registered root's idle workspaces: the existing eviction, at the plan's idle time. */
function evictAllRoots(roots: () => Promise<string[]>, collected: EvictionOutcome): DiskOps["evictWorkspaces"] {
  return async (idleMs, onlyPaths) => {
    const evicted = new Set<string>();
    const failed: Array<{ root: string; reason: string }> = [];
    let freedBytes = 0;
    for (const root of await roots()) {
      try {
        const { outcome } = await evictIdleWorkspaces(root, { idleMs, onlyPaths, inspectRetirement: false });
        collected.results.push(...outcome.results);
        collected.skipped.push(...outcome.skipped);
        collected.unretirable.push(...outcome.unretirable);
        for (const result of outcome.results) {
          if (result.evicted) evicted.add(result.root);
          freedBytes += result.freedBytes ?? 0;
          if (result.failedPaths.length) failed.push({ root: result.root, reason: `could not remove ${result.failedPaths.join(", ")}` });
        }
      } catch (error) {
        failed.push({ root, reason: `eviction failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return { evicted, failed, freedBytes };
  };
}

/** A fresh look at who holds a path, never the plan's cached scan: true when anything does, or when that cannot be read. */
async function freshlyHeld(path: string): Promise<boolean> {
  const working = await workspaceHolders(path, { processes: await processWorkingDirectories() }).catch(() => null);
  const open = await openPathsByProcess().catch(() => null);
  return working === null || open === null || working.length > 0 || holdersOfOpenFiles(path, open).length > 0;
}

/**
 * The shell rescue (scripts/disk-rescue.sh) cannot read this config, so every applying pass writes the values it needs,
 * from this one policy, to `disk-rescue.env` beside it: the two cannot drift. Paths with whitespace cannot be listed
 * in a shell word list and are left out.
 */
export async function writeRescueEnv(config: DiskConfig): Promise<void> {
  const file = join(dirname(machineConfigPath()), "disk-rescue.env");
  const regenerable = config.regenerable.filter((path) => !/\s/.test(path)).join(" ");
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const text = [
    "# Written by `slipjay disk` from the machine config's `disk` key; do not edit.",
    `SLIPJAY_RESCUE_SHED_PERCENT=${config.thresholds.shedPercent}`,
    `SLIPJAY_RESCUE_CRITICAL_PERCENT=${config.thresholds.criticalPercent}`,
    `SLIPJAY_RESCUE_BALLAST=${quote(config.ballast.path)}`,
    // The filesystem this pass measured, so the rescue on a host without one cannot measure a different one instead.
    `SLIPJAY_RESCUE_ROOT=${quote(usagePath())}`,
    `SLIPJAY_RESCUE_REGENERABLE=${quote(regenerable)}`,
    "",
  ].join("\n");
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, file);
}

/**
 * Plan the host's disk, and apply the plan unless `plan`. A plan changes nothing on disk. An applying pass
 * runs under the `host-disk` lock and answers `busy` when another pass holds it.
 */
export async function hostDisk(options: HostDiskOptions = {}): Promise<HostDiskOutcome> {
  const config = options.config ?? readDiskConfig();
  const evictions: EvictionOutcome = { results: [], skipped: [], unretirable: [] };
  const host = realHost(options, config, evictions);
  const now = options.now ?? Date.now();
  const pass = async (): Promise<HostDiskOutcome> => {
    const usage = await (options.readUsage ?? readHostUsage)();
    if (!usage) throw new Error(`cannot read the usage of ${usagePath()}'s filesystem`);
    const plan = { ...await planHostDisk({ config, usage, now, host, plan: options.plan }), maintenance: options.maintain };
    const operationStores = await operationStoreReports(await (options.integrationRoots ?? registeredIntegrationRoots)(), host.sizeOf);
    for (const store of operationStores) if (store.warning) plan.notes.push(store.warning);
    const warning = await readHeartbeatWarning(now);
    if (warning) plan.notes.push(warning);
    if (options.plan) return { state: "planned", applied: false, ...plan, operationStores, results: plan.rows.map((row) => ({ ...row, outcome: "kept" as const, detail: row.reason })), ballastResult: null, failures: 0 };
    const ops: DiskOps = { ...realOps(host, evictAllRoots(options.integrationRoots ?? registeredIntegrationRoots, evictions)), held: freshlyHeld,
      readUsage: options.readUsage ?? readHostUsage,
      retireSpare: async (repository, path) => {
        if (await freshlyHeld(path)) return "held by a process or holders unreadable";
        const name = plan.rows.find((entry) => entry.path === path)?.owner;
        const removed = await retireExcessSpares(repository, { onlyPath: path });
        return name && removed.includes(name) ? null : "spare is within its configured allowance, held or changed";
      },
      retireWorkspace: async (path) => {
        if (await freshlyHeld(path)) return "held by a process or holders unreadable";
        const row = plan.rows.find((entry) => entry.path === path);
        const metadata = await workspaceMetadata(row?.owner ?? basename(path));
        if (!metadata) return "workspace metadata unreadable at retirement";
        if (!metadata.spare) {
          const activity = lastKnownTouch(metadata);
          if (activity === null || now - activity < plan.workspaceIdleMs) return "workspace resumed or idle clock unreadable at retirement";
        }
        const result = await releaseWorkspace(path, { operationId: `disk-${randomUUID()}`, now });
        return result.state === "retired" ? null : result.reason;
      }, ...options.ops };
    const applied = await applyHostDisk(plan, ops, now);
    const after = await (options.readUsage ?? readHostUsage)();
    const heartbeatError = await writeDiskHeartbeat({ at: now, operationStores, freeBytes: after?.freeBytes, floorBytes: freeSpaceFloor(config, after ?? usage), level: after && belowFloor(config, after) ? "critical" : plan.level, failures: applied.failures }).then(() => undefined, (error: unknown) => message(error));
    if (after && belowFloor(config, after)) plan.notes.push(`CRITICAL: free space ${after.freeBytes} bytes remains below floor ${freeSpaceFloor(config, after)} bytes; safe reclaimable material exhausted or held`);
    if (heartbeatError) plan.notes.push(`WARNING: heartbeat could not be written: ${heartbeatError}`);
    // A rescue env that could not be written leaves the rescue on stale values: say so, and count it as a failure.
    const rescueEnvError = await writeRescueEnv(config).then(() => undefined, (error: unknown) => message(error));
    return { state: "applied", applied: true, ...plan, operationStores, evictions, budgets: applied.budgets, results: applied.rows, ballastResult: applied.ballast, failures: applied.failures + (rescueEnvError === undefined ? 0 : 1) + (heartbeatError === undefined ? 0 : 1), ...rescueEnvError === undefined ? {} : { rescueEnvError } };
  };
  if (options.plan) return pass();
  try {
    return await withWorkspaceTransaction("host-disk", pass, { waitMs: options.lockWaitMs ?? 2000 });
  } catch (error) {
    if ((error as { code?: string } | null | undefined)?.code === "ELOCKED") return { state: "busy", reason: "another host-disk pass is running" };
    throw error;
  }
}
