/**
 * The host disk pass (SJ-226), shared by `slipjay disk` and `slipjay maintain`: read the policy and the
 * root filesystem's usage, plan every managed directory, and (unless planning) apply the plan under the
 * host-wide `host-disk` lock. Every reader is injectable; the defaults read the real host.
 */
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { run, workspaceContext } from "../infra/workspace-jj.ts";
import { withWorkspaceTransaction } from "../infra/workspace-transaction.ts";
import { trackerIsBuild, trackerOf, workItemClosed } from "../build/tracker.ts";
import type { BuildReader } from "../build/tracker.ts";
import { evictIdleWorkspaces } from "../workspace/workspace-eviction.ts";
import { processWorkingDirectories, workspaceHolders } from "../workspace/workspace-holders.ts";
import { holdersOfOpenFiles, openPathsByProcess } from "./disk-holders.ts";
import type { OpenPaths } from "./disk-holders.ts";
import type { ProcessWorkingDirectory } from "../workspace/workspace-holders.ts";
import { machineConfigPath, metadataHome } from "../workspace/workspace-paths.ts";
import { applyHostDisk, realOps } from "./disk-apply.ts";
import type { ApplyResult, DiskOps } from "./disk-apply.ts";
import { readDiskConfig } from "./disk-config.ts";
import type { DiskConfig } from "./disk-config.ts";
import { HOUR_MS, planHostDisk } from "./disk-plan.ts";
import type { DiskHost, DiskRow, HostDiskPlan, ManifestRead } from "./disk-plan.ts";
import { readRootUsage } from "./disk-usage.ts";
import type { DiskUsageReader } from "./disk-usage.ts";

/** The idle threshold the pass applies to workspaces once the host sheds: one hour. */
export const SHED_IDLE_MS: number = HOUR_MS;

export type HostDiskOptions = {
  plan?: boolean;
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
  | ({ state: "planned" | "applied"; applied: boolean } & HostDiskPlan & { results: ApplyResult["rows"]; ballastResult: ApplyResult["ballast"]; failures: number });

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
  const result = await run("du", ["-sk", path], { timeoutMs: 120_000 }).catch(() => null);
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

function realHost(options: HostDiskOptions, config: DiskConfig): DiskHost {
  let processes: Promise<ProcessWorkingDirectory[] | null> | undefined;
  let openFiles: Promise<OpenPaths | null> | undefined;
  const roots = options.integrationRoots ?? registeredIntegrationRoots;
  return {
    readDir: async (path) => readdir(path).then((names) => names, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : null),
    stat: async (path) => {
      const info = await lstat(path).catch(() => null);
      if (!info) return null;
      return { mtimeMs: info.mtimeMs, uid: info.uid, isDirectory: info.isDirectory(), isSymlink: info.isSymbolicLink(), realPath: await realpath(path).catch(() => path) };
    },
    sizeOf: directorySize,
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
          for (const plan of (await evictIdleWorkspaces(root, { idleMs, plan: true })).plans) {
            rows.push({
              path: plan.root, class: "workspace", sizeBytes: plan.sizeBytes ?? 0, owner: plan.name,
              action: plan.action === "evict" ? "remove" : "keep", reason: plan.reason,
            });
          }
        } catch (error) {
          rows.push({ path: root, class: "workspace", sizeBytes: 0, owner: null, action: "report", reason: `cannot plan its eviction: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      return rows;
    },
    ...options.host,
  } satisfies DiskHost;
}

/** Evict every registered root's idle workspaces: the existing eviction, at the plan's idle time. */
function evictAllRoots(roots: () => Promise<string[]>): DiskOps["evictWorkspaces"] {
  return async (idleMs) => {
    const evicted = new Set<string>();
    const failed: Array<{ root: string; reason: string }> = [];
    for (const root of await roots()) {
      try {
        const { outcome } = await evictIdleWorkspaces(root, { idleMs });
        for (const result of outcome.results) {
          if (result.evicted) evicted.add(result.root);
          if (result.failedPaths.length) failed.push({ root: result.root, reason: `could not remove ${result.failedPaths.join(", ")}` });
        }
      } catch (error) {
        failed.push({ root, reason: `eviction failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return { evicted, failed };
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
  const host = realHost(options, config);
  const now = options.now ?? Date.now();
  const pass = async (): Promise<HostDiskOutcome> => {
    const usage = await (options.readUsage ?? readRootUsage)();
    if (!usage) throw new Error("cannot read the root filesystem's usage");
    const plan = await planHostDisk({ config, usage, now, host });
    if (options.plan) return { state: "planned", applied: false, ...plan, results: plan.rows.map((row) => ({ ...row, outcome: "kept" as const, detail: row.reason })), ballastResult: null, failures: 0 };
    const ops: DiskOps = { ...realOps(host, evictAllRoots(options.integrationRoots ?? registeredIntegrationRoots)), held: freshlyHeld, ...options.ops };
    const applied = await applyHostDisk(plan, ops, now);
    await writeRescueEnv(config).catch(() => {});
    return { state: "applied", applied: true, ...plan, results: applied.rows, ballastResult: applied.ballast, failures: applied.failures };
  };
  if (options.plan) return pass();
  try {
    return await withWorkspaceTransaction("host-disk", pass, { waitMs: options.lockWaitMs ?? 2000 });
  } catch (error) {
    if ((error as { code?: string } | null | undefined)?.code === "ELOCKED") return { state: "busy", reason: "another host-disk pass is running" };
    throw error;
  }
}
