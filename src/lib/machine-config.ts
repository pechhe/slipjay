/**
 * This machine's settings, `~/.slipjay/config.json`: where its runner is (`runner`) and
 * the per-repository spare limits (`spares`, keyed by integration checkout path). The one
 * reader and writer of that file; every other key in it is kept as written.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spareCount } from "./execution-policy.ts";
import { RUNNER_LOCATION_ENV } from "./runner-contract.ts";
import { machineConfigPath } from "./workspace-paths.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";

const RUNNER_PROTOCOLS = new Set(["ssh:", "http:", "https:"]);
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** A machine spare limit, named for this file rather than the repository policy. */
const machineCount = (count: unknown): number => {
  try { return spareCount(count); }
  catch { throw new Error(`${machineConfigPath()} spares must be an integer from 0 to 8 for each integration checkout`); }
};

/** The file's settings; empty when it does not exist. Malformed JSON fails rather than reading as unset. */
export function readMachineConfig(): Record<string, unknown> {
  let text: string;
  try { text = readFileSync(machineConfigPath(), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const config: unknown = JSON.parse(text);
  if (!isObject(config)) throw new Error(`${machineConfigPath()} must be a JSON object`);
  return config;
}

/** The runner location the file records, or null. */
export function configuredRunner(config: Record<string, unknown> = readMachineConfig()): string | null {
  return typeof config.runner === "string" && config.runner ? config.runner : null;
}

/** The file's spare limits, by integration checkout path; a malformed map or count fails rather than being ignored. */
export function machineSpareLimits(config: Record<string, unknown> = readMachineConfig()): Record<string, number> {
  const limits = config.spares;
  if (limits === undefined) return {};
  if (!isObject(limits)) throw new Error(`spares in ${machineConfigPath()} must map integration checkout paths to spare counts`);
  return Object.fromEntries(Object.entries(limits).map(([path, count]) => [path, machineCount(count)]));
}

/** This machine's limit for the repository whose integration checkout is `integrationRoot`, or null when it sets none. */
export function machineSpareLimit(integrationRoot: string, config?: Record<string, unknown>): number | null {
  const found = Object.entries(machineSpareLimits(config)).find(([path]) => resolve(path) === resolve(integrationRoot));
  return found ? found[1] : null;
}

/** Where the runner is, and which setting says so: `SLIPJAY_RUNNER` overrides the file. */
export function runnerSetting(env: NodeJS.ProcessEnv = process.env, config: Record<string, unknown> = readMachineConfig()): {
  value: string | null; source: "environment" | "file" | "unset"; file: string | null; overriddenByEnvironment: boolean;
} {
  const file = configuredRunner(config);
  const fromEnvironment = env[RUNNER_LOCATION_ENV] || null;
  return { value: fromEnvironment ?? file, source: fromEnvironment ? "environment" : file ? "file" : "unset", file,
    overriddenByEnvironment: Boolean(fromEnvironment && file && fromEnvironment !== file) };
}

/** A runner location as `connectRunner` reaches it: `ssh://host` or an http(s) URL. */
export function validRunnerLocation(location: string): string {
  let url: URL;
  try { url = new URL(location); } catch { throw new Error(`Runner location ${JSON.stringify(location)} is not a URL; use ssh://<host> or http://127.0.0.1:<port>`); }
  if (!RUNNER_PROTOCOLS.has(url.protocol) || !url.hostname) throw new Error(`Runner location ${JSON.stringify(location)} must be ssh://<host> or an http(s) URL`);
  return location;
}

/** Change the file under its lock: `update` gets the current settings and returns the next. */
export async function updateMachineConfig(update: (config: Record<string, unknown>) => Record<string, unknown>): Promise<Record<string, unknown>> {
  return withWorkspaceTransaction(`machine-config:${machineConfigPath()}`, async () => {
    const next = update(readMachineConfig());
    const path = machineConfigPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
    return next;
  });
}

/** Record (or with null, clear) this machine's runner location. Operations already submitted stay on their runner. */
export async function setConfiguredRunner(location: string | null): Promise<void> {
  if (location !== null) validRunnerLocation(location);
  await updateMachineConfig(({ runner: _previous, ...rest }) => location === null ? rest : { ...rest, runner: location });
}

/** Record (or with null, clear) this machine's spare limit for a repository; it only ever lowers the declared count. */
export async function setMachineSpareLimit(integrationRoot: string, count: number | null): Promise<void> {
  if (count !== null) machineCount(count);
  const root = resolve(integrationRoot);
  await updateMachineConfig((config) => {
    const limits = Object.fromEntries(Object.entries(machineSpareLimits(config)).filter(([path]) => resolve(path) !== root));
    if (count !== null) limits[root] = count;
    const { spares: _previous, ...rest } = config;
    return Object.keys(limits).length ? { ...rest, spares: limits } : rest;
  });
}
