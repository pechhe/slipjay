/**
 * The host disk policy's settings (SJ-226): the optional `disk` key of this machine's config
 * (`~/.slipjay/config.json`, read through machine-config.ts). One host holds several repositories, so
 * thresholds and managed roots are per machine, never per repository. Every field is optional; a
 * malformed `disk` fails loudly rather than reading as the defaults, as `spares` does.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { readMachineConfig } from "../policy/machine-config.ts";
import { machineConfigPath } from "../workspace/workspace-paths.ts";

const GIB = 1024 ** 3;

export type DiskThresholds = {
  /** Percent of the root filesystem used at which the host is `warn`. */
  warnPercent: number;
  /** Regenerable caches and idle workspaces are shed from here. */
  shedPercent: number;
  /** The pool refill stops from here. */
  refillPercent: number;
  /** The ballast is released from here. */
  criticalPercent: number;
  /** An absent ballast is recreated only below this. */
  ballastRecreatePercent: number;
};

export type ScratchRoot = { path: string; match: string[]; ttlHours: number };

export type DiskConfig = {
  thresholds: DiskThresholds;
  /** `bytes: 0` turns the ballast off. */
  ballast: { path: string; bytes: number };
  runRoot: string;
  scratchRoots: ScratchRoot[];
  regenerable: string[];
  issueCapBytes: number;
  /** SJ-235: an optional size budget per class; absent means no budget and today's behaviour. */
  budgets: { workspacesBytes?: number; evidenceBytes?: number };
};

export const DEFAULT_THRESHOLDS: Readonly<DiskThresholds> = {
  warnPercent: 80, shedPercent: 88, refillPercent: 93, criticalPercent: 96, ballastRecreatePercent: 85,
};

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** `~` and `~/…` expanded against the current home. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** The defaults, resolved against the current home (read at call time, so a hermetic home applies). */
export function defaultDiskConfig(): DiskConfig {
  return {
    thresholds: { ...DEFAULT_THRESHOLDS },
    ballast: { path: join(homedir(), ".slipjay", "disk-ballast"), bytes: 8 * GIB },
    runRoot: join(homedir(), "runs"),
    scratchRoots: [{ path: "/tmp", match: ["*-scratch", "ys-attack-build-*"], ttlHours: 72 }],
    regenerable: ["/tmp/node-compile-cache"],
    issueCapBytes: 20 * GIB,
    budgets: {},
  };
}

function fail(message: string): never {
  throw new Error(`disk in ${machineConfigPath()} ${message}`);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!isObject(value)) fail(`${name} must be a JSON object`);
  return value;
}

function known(value: Record<string, unknown>, keys: string[], name: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${name} has an unknown key ${JSON.stringify(key)}`);
}

function absolutePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) fail(`${name} must be a path`);
  const path = expandHome(value);
  if (!isAbsolute(path)) fail(`${name} must be an absolute path (or start with ~/): ${value}`);
  const resolved = resolve(path);
  if (resolved === "/" || resolved === homedir()) fail(`${name} must not be the filesystem root or the home directory: ${value}`);
  return resolved;
}

function number(value: unknown, name: string, { min, max, integer = false }: { min: number; max: number; integer?: boolean }): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    fail(`${name} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
  }
  return value;
}

/** The disk policy in force: `config.disk` over the defaults, validated. */
export function readDiskConfig(config: Record<string, unknown> = readMachineConfig()): DiskConfig {
  const defaults = defaultDiskConfig();
  const raw = config.disk;
  if (raw === undefined) return defaults;
  const disk = object(raw, "disk");
  known(disk, ["thresholds", "ballast", "runRoot", "scratchRoots", "regenerable", "issueCapBytes", "budgets"], "disk");
  const result: DiskConfig = { ...defaults };
  if (disk.thresholds !== undefined) {
    const given = object(disk.thresholds, "thresholds");
    known(given, Object.keys(DEFAULT_THRESHOLDS), "thresholds");
    const thresholds = { ...DEFAULT_THRESHOLDS } as DiskThresholds;
    for (const key of Object.keys(DEFAULT_THRESHOLDS) as Array<keyof DiskThresholds>) {
      if (given[key] !== undefined) thresholds[key] = number(given[key], `thresholds.${key}`, { min: 1, max: 100 });
    }
    if (!(thresholds.warnPercent <= thresholds.shedPercent && thresholds.shedPercent <= thresholds.refillPercent && thresholds.refillPercent <= thresholds.criticalPercent)) {
      fail("thresholds must satisfy warnPercent <= shedPercent <= refillPercent <= criticalPercent");
    }
    if (thresholds.ballastRecreatePercent > thresholds.criticalPercent) fail("thresholds.ballastRecreatePercent must not exceed criticalPercent");
    result.thresholds = thresholds;
  }
  if (disk.ballast !== undefined) {
    const given = object(disk.ballast, "ballast");
    known(given, ["path", "bytes"], "ballast");
    result.ballast = {
      path: given.path === undefined ? defaults.ballast.path : absolutePath(given.path, "ballast.path"),
      bytes: given.bytes === undefined ? defaults.ballast.bytes : number(given.bytes, "ballast.bytes", { min: 0, max: 2 ** 50, integer: true }),
    };
  }
  if (disk.runRoot !== undefined) result.runRoot = absolutePath(disk.runRoot, "runRoot");
  if (disk.scratchRoots !== undefined) {
    if (!Array.isArray(disk.scratchRoots)) fail("scratchRoots must be an array");
    result.scratchRoots = disk.scratchRoots.map((entry, index): ScratchRoot => {
      const name = `scratchRoots[${index}]`;
      const given = object(entry, name);
      known(given, ["path", "match", "ttlHours"], name);
      if (!Array.isArray(given.match) || !given.match.length || given.match.some((glob) => typeof glob !== "string" || !glob || glob.includes("/"))) {
        fail(`${name}.match must be a non-empty array of directory-name globs`);
      }
      return { path: absolutePath(given.path, `${name}.path`), match: given.match as string[], ttlHours: number(given.ttlHours, `${name}.ttlHours`, { min: 0, max: 24 * 3650 }) };
    });
  }
  if (disk.regenerable !== undefined) {
    if (!Array.isArray(disk.regenerable)) fail("regenerable must be an array of absolute paths");
    result.regenerable = disk.regenerable.map((path, index) => absolutePath(path, `regenerable[${index}]`));
  }
  if (disk.issueCapBytes !== undefined) result.issueCapBytes = number(disk.issueCapBytes, "issueCapBytes", { min: 1, max: 2 ** 50, integer: true });
  if (disk.budgets !== undefined) {
    const given = object(disk.budgets, "budgets");
    known(given, ["workspacesBytes", "evidenceBytes"], "budgets");
    result.budgets = {};
    for (const key of ["workspacesBytes", "evidenceBytes"] as const) {
      if (given[key] !== undefined) result.budgets[key] = number(given[key], `budgets.${key}`, { min: 1, max: 2 ** 50, integer: true });
    }
  }
  // Evidence is never removed by age or pressure, except over an evidence budget (SJ-235: then a closed, unpinned,
  // unheld directory is archived and pruned before its expiry, oldest first, until the class is under budget). So nothing else may be allowed to remove it: no scratch root,
  // regenerable path or ballast may equal, contain or sit inside the run root.
  const nested = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  for (const [name, path] of [
    ...result.scratchRoots.map((root, index) => [`scratchRoots[${index}].path`, root.path] as const),
    ...result.regenerable.map((entry, index) => [`regenerable[${index}]`, entry] as const),
    ["ballast.path", result.ballast.path] as const,
  ]) {
    if (nested(path, result.runRoot)) fail(`${name} (${path}) must not equal, contain or lie inside runRoot (${result.runRoot}): evidence is never removed by age or pressure`);
  }
  return result;
}
