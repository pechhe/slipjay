import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareWorkspaceDependencies, removeNodeModules } from "./workspace-dependencies.ts";
import { repositoryProjectCode, run, workspaceContext } from "./workspace-jj.ts";
import type { WorkspaceContext, WorkspaceEntry } from "./workspace-jj.ts";
import { machineConfigPath, metadataHome, poolRefillLogPath, stateHome, workspaceHome } from "./workspace-paths.ts";
import { listWorkspaces, metadataPath, readJsonOptional, renameWorkspace, workspaceMetadata } from "./workspace-state.ts";
import { processAlive } from "./workspace-holders.ts";
import { linkSharedPaths } from "./workspace-shared-paths.ts";
import { DEFAULT_SPARES, spareCount } from "./execution-policy.ts";
import { installInputFingerprint } from "./install-inputs.ts";
import { removeWorkspace, withinWorkspaceStorage } from "./workspace-lifecycle.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "./workspace-transaction.ts";

/**
 * A pool of prepared, unassigned JJ workspaces per Project (`spares` in
 * `slipjay.json`, one by default, lowered per machine; see `spareAllowance`). Assignment renames one to the task's name
 * (its directory is stable), moves it to the current integration head and
 * reconciles dependencies there. A spare holds no work, so it is freely
 * replaceable; only spares are ever created or claimed here.
 */

/** A claimed spare's provisioned dependencies, reused because its install inputs are unchanged. */
export interface ReusedDependencies {
  state: "ready" | "not_required";
  packageManager: string | null;
  installInputs: string;
  reused: true;
}

/** Dependency readiness stored in a spare's untyped metadata. */
interface PreparedDependencies {
  state?: string;
  packageManager?: string | null;
  installInputs?: string | null;
}

/** A spare's registration, including a possibly unfinished preparation. */
interface SpareRecord {
  spare: true;
  integrationRoot: string;
  workspaceName: string;
  workspacePath: string;
  prepared?: boolean;
  preparingPid?: number | null;
}

/** Pool registration either declines a refill or reserves a workspace. */
type SpareRegistration = { reason: string; name?: never; workspacePath?: never }
  | { name: string; workspacePath: string; reason?: never };

async function jj(cwd: string, args: string[]): Promise<string> {
  const result = await run("jj", ["--color=never", ...args], { cwd });
  if (result.code !== 0) throw new Error(`jj ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

/** How many spares this machine keeps for a repository, and why. */
export interface SpareAllowance {
  spares: number;
  /** The repository's `spares` (or the default). */
  declared: number;
  /** This machine's limit for the repository, or null when it sets none. */
  machineLimit: number | null;
}

/**
 * This machine's spare count for the repository: its declared `spares`, lowered (never
 * raised) by the machine's limit, `spares` in ~/.slipjay/config.json keyed by the
 * integration checkout's absolute path. A malformed limit fails rather than being ignored.
 */
export async function spareAllowance(context: WorkspaceContext): Promise<SpareAllowance> {
  const declared = context.configuration.spares ?? DEFAULT_SPARES;
  const text = await readFile(machineConfigPath(), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  const limits: unknown = text === null ? undefined : JSON.parse(text).spares;
  if (limits !== undefined && (!limits || typeof limits !== "object" || Array.isArray(limits))) {
    throw new Error(`spares in ${machineConfigPath()} must map integration checkout paths to spare counts`);
  }
  const limit = Object.entries((limits ?? {}) as Record<string, unknown>).find(([path]) => resolve(path) === resolve(context.integration.root));
  const machineLimit = limit === undefined ? null : spareCount(limit[1]);
  return { spares: machineLimit === null ? declared : Math.min(declared, machineLimit), declared, machineLimit };
}

/** Prepared spares for this repository. A spare still being prepared is never one. */
export async function readySpares(cwd: string): Promise<WorkspaceEntry[]> {
  return (await listWorkspaces(cwd)).filter((workspace: WorkspaceEntry) =>
    workspace.metadata?.spare === true && workspace.metadata?.prepared === true && workspace.root && existsSync(workspace.root));
}

/** Every spare registered for the repository, ready, in progress or abandoned, from its metadata records. */
async function spareRecords(integrationRoot: string): Promise<SpareRecord[]> {
  const records: SpareRecord[] = [];
  for (const file of await readdir(metadataHome()).catch(() => [])) {
    if (!file.endsWith(".json")) continue;
    const metadata = await readJsonOptional(join(metadataHome(), file)) as SpareRecord | null;
    if (metadata?.spare === true && typeof metadata.integrationRoot === "string" && resolve(metadata.integrationRoot) === resolve(integrationRoot)) records.push(metadata);
  }
  return records;
}

/**
 * Roots whose `node_modules` may seed an install of `workspacePath` with these install
 * inputs: prepared spares that recorded exactly them, then other workspaces that recorded
 * them when their dependencies were made ready (a claimed spare among them), then the
 * primary checkout. Every one but a spare must still have them at its last snapshot (read
 * without snapshotting: a session may own its working copy), since work may have changed
 * them since. Cloning only seeds the install, which still runs to verify it.
 */
function dependencySeeds(integrationRoot: string, workspacePath: string): (installInputs: string) => Promise<string[]> {
  return async (installInputs: string): Promise<string[]> => {
    const recorded = (workspace: WorkspaceEntry) => resolve(workspace.root) !== resolve(workspacePath) && existsSync(join(workspace.root, "node_modules"))
      && (workspace.metadata?.preparedDependencies as PreparedDependencies | undefined)?.installInputs === installInputs;
    const seeds = (await readySpares(integrationRoot)).filter(recorded).map((spare) => spare.root);
    for (const workspace of await listWorkspaces(integrationRoot)) {
      if (workspace.metadata?.spare !== true && workspace.root && recorded(workspace)
        && await installInputFingerprint(workspace.root, { snapshot: false }) === installInputs) seeds.push(workspace.root);
    }
    if (existsSync(join(integrationRoot, "node_modules")) && await installInputFingerprint(integrationRoot, { snapshot: false }) === installInputs) seeds.push(integrationRoot);
    return seeds;
  };
}

/**
 * Make a workspace's dependencies current, recording the install inputs they match. Absent
 * `node_modules` are cloned from another checkout that has those inputs installed; with
 * `replace` (a spare, which holds nothing of its own), stale ones are discarded for that
 * clone too. Only when no checkout has them does the install run in place. Either way the
 * install runs, as the verification. Installs of one repository's checkouts on this machine
 * run one at a time, so a second waits for the first and then clones its result instead of
 * installing the same inputs beside it.
 */
export async function refreshDependencies(integrationRoot: string, workspacePath: string, options: { quiet?: boolean; replace?: boolean } = {}): Promise<ReturnType<typeof prepareWorkspaceDependencies> extends Promise<infer R> ? R : never> {
  return withWorkspaceTransaction(`install:${resolve(integrationRoot)}`, async () => {
    const inputs = options.replace ? await installInputFingerprint(workspacePath) : null;
    if (inputs && (await dependencySeeds(integrationRoot, workspacePath)(inputs)).length) await removeNodeModules(workspacePath);
    return installSeededDependencies(integrationRoot, workspacePath, { quiet: options.quiet, recordInputs: true });
  }, { waitMs: INSTALL_WAIT_MS });
}

/** How long an install waits for another install of the same repository on this machine. */
const INSTALL_WAIT_MS = 30 * 60_000;

/** Dependency installation for a workspace that has none yet, seeded from a matching checkout when one exists. */
const installSeededDependencies = (integrationRoot: string, workspacePath: string, options: {
  quiet?: boolean; recordInputs?: boolean; env?: NodeJS.ProcessEnv;
} = {}): ReturnType<typeof prepareWorkspaceDependencies> =>
  prepareWorkspaceDependencies(workspacePath, { ...options, seedFrom: dependencySeeds(integrationRoot, workspacePath) });

/**
 * Add one spare to the pool, up to this machine's `spareAllowance`, without ever blocking a
 * claim: the pool transaction is held only to count the spares and register this
 * one's name (unprepared, marked with this process), not while the workspace is
 * added and its dependencies installed, so claims can take any other ready spare
 * meanwhile. A spare whose preparer died is adopted and finished.
 */
export async function provisionSpare(cwd: string = process.cwd()): Promise<{ provisioned: boolean; reason?: string; workspacePath?: string; name?: string }> {
  const context = await workspaceContext(cwd);
  if (!context) return { provisioned: false, reason: "not-jj" };
  const root = context.integration.root;
  const wanted = (await spareAllowance(context)).spares;
  const registration: SpareRegistration = await withWorkspaceTransaction(`pool:${root}`, async (): Promise<SpareRegistration> => {
    const records = await spareRecords(root);
    // A ready spare, or one a live process is preparing, counts toward the pool.
    if (records.filter((record) => record.prepared === true || processAlive(record.preparingPid)).length >= wanted) {
      return { reason: wanted === 0 ? "pool-disabled" : "spare-exists" };
    }
    const abandoned = records.find((record) => record.prepared !== true && !processAlive(record.preparingPid));
    const name = abandoned?.workspaceName ?? `${await repositoryProjectCode(root)}-spare-${randomUUID().slice(0, 6)}`;
    const workspacePath = abandoned?.workspacePath ?? join(workspaceHome(), name);
    await mkdir(metadataHome(), { recursive: true, mode: 0o700 });
    await writeWorkspaceJson(metadataPath(name), {
      ...(abandoned ?? { version: 1, workspaceName: name, workspacePath, integrationRoot: root, spare: true, createdAt: new Date().toISOString() }),
      prepared: false, preparingPid: process.pid,
    });
    return { name, workspacePath };
  });
  if (!registration.name) return { provisioned: false, reason: registration.reason };
  const { name, workspacePath } = registration;
  try {
    if (!(await listWorkspaces(cwd)).some((workspace) => workspace.name === name)) {
      // An interrupted add may have left a half-made checkout under this spare's own name.
      if (!await withinWorkspaceStorage(workspacePath)) throw new Error(`Spare ${name} is outside workspace storage`);
      await mkdir(workspaceHome(), { recursive: true, mode: 0o700 });
      await rm(workspacePath, { recursive: true, force: true });
      await jj(root, ["workspace", "add", "--name", name, "--revision", context.integrationBranch, workspacePath]);
    }
    await linkSharedPaths(root, workspacePath);
    const { state, packageManager, installInputs } = await refreshDependencies(root, workspacePath, { quiet: true });
    const { preparingPid: _done, ...metadata } = (await workspaceMetadata(name)) ?? {};
    await writeWorkspaceJson(metadataPath(name), { ...metadata, prepared: true, preparedDependencies: { state, packageManager, installInputs } });
    return { provisioned: true, workspacePath, name };
  } catch (error) {
    // Hand the name back so another refill can adopt and finish it.
    const metadata = await workspaceMetadata(name);
    if (metadata) await writeWorkspaceJson(metadataPath(name), { ...metadata, preparingPid: null }).catch(() => {});
    throw error;
  }
}

/** How a refreshed spare's dependencies became current: kept, cloned from a matching checkout, or installed. */
export type SpareRefresh = { name: string; dependencies: "reused" | "seeded" | "installed" };

/**
 * Move every ready spare that is behind the integration head onto it, one at a time,
 * so a claim finds dependencies that are already current. A spare is reserved under
 * the pool lock first (unprepared, marked with this process), so no claim takes it
 * mid-refresh, and claims take the others meanwhile. Unchanged install inputs keep its
 * dependencies; otherwise, when a prepared checkout already has the new inputs, its
 * `node_modules` replaces the spare's by copy-on-write clone, and only when none has
 * them does the install run in place. Refreshing in turn, the first stale spare installs
 * and the rest clone it. A refresh that fails hands its spare back for the next refill.
 */
export async function refreshSpares(cwd: string): Promise<SpareRefresh[]> {
  const context = await workspaceContext(cwd);
  if (!context) return [];
  const root = context.integration.root;
  const head = await jj(root, ["--ignore-working-copy", "log", "--no-graph", "-r", context.integrationBranch, "-T", "commit_id"]);
  const refreshed: SpareRefresh[] = [];
  for (const spare of await readySpares(root)) {
    const reserved = await withWorkspaceTransaction(`pool:${root}`, async () => {
      const metadata = await workspaceMetadata(spare.name);
      if (metadata?.spare !== true || metadata.prepared !== true) return null; // claimed meanwhile
      if (await jj(spare.root, ["--ignore-working-copy", "log", "--no-graph", "-r", "@-", "-T", "commit_id"]) === head) return null;
      await writeWorkspaceJson(metadataPath(spare.name), { ...metadata, prepared: false, preparingPid: process.pid });
      return metadata;
    });
    if (!reserved) continue;
    try {
      await jj(spare.root, ["new", context.integrationBranch]);
      const prepared = reserved.preparedDependencies as PreparedDependencies | undefined;
      let outcome: SpareRefresh["dependencies"] = "reused";
      let current: PreparedDependencies | undefined = prepared;
      if (!await reusableDependencies(spare.root, prepared)) {
        const installed = await refreshDependencies(root, spare.root, { quiet: true, replace: true });
        outcome = installed.seeded ? "seeded" : "installed";
        current = { state: installed.state, packageManager: installed.packageManager, installInputs: installed.installInputs };
      }
      const { preparingPid: _done, ...metadata } = (await workspaceMetadata(spare.name)) ?? {};
      await writeWorkspaceJson(metadataPath(spare.name), { ...metadata, prepared: true, preparedDependencies: current });
      refreshed.push({ name: spare.name, dependencies: outcome });
    } catch (error) {
      const metadata = await workspaceMetadata(spare.name);
      if (metadata) await writeWorkspaceJson(metadataPath(spare.name), { ...metadata, preparingPid: null }).catch(() => {});
      throw error;
    }
  }
  return refreshed;
}

/**
 * Remove ready spares beyond this machine's allowance, as when its limit was lowered. Each is
 * reserved under the pool lock first, so no claim takes it; a spare holds no work. Returns the
 * names removed.
 */
export async function retireExcessSpares(cwd: string): Promise<string[]> {
  const context = await workspaceContext(cwd);
  if (!context) return [];
  const root = context.integration.root;
  const { spares: allowed } = await spareAllowance(context);
  const excess = await withWorkspaceTransaction(`pool:${root}`, async () => {
    const records = await spareRecords(root);
    const counted = records.filter((record) => record.prepared === true || processAlive(record.preparingPid)).length;
    const retiring = records.filter((record) => record.prepared === true).slice(0, Math.max(0, counted - allowed));
    for (const record of retiring) {
      await writeWorkspaceJson(metadataPath(record.workspaceName), { ...await workspaceMetadata(record.workspaceName), prepared: false, preparingPid: process.pid });
    }
    return retiring.map((record) => record.workspaceName);
  });
  for (const name of excess) await removeWorkspace(root, name);
  return excess;
}

/** How long a refill waits for another repository's refill on this machine. */
const REFILL_WAIT_MS = 60 * 60_000;

/**
 * The pool refill (`startSpareRefill`'s child, and `slipjay pool refill`): retire spares beyond
 * this machine's allowance or top the pool up to it one spare at a time, then refresh stale
 * spares, reporting each
 * outcome. It holds a machine-wide refill lock throughout, so refills of every
 * repository on this machine install one after another; claims never take that lock.
 */
export async function refillPool(root: string, report: (outcome: object) => void): Promise<void> {
  await withWorkspaceTransaction("refill", async () => {
    for (const retired of await retireExcessSpares(root)) report({ retired });
    for (;;) {
      const outcome = await provisionSpare(root);
      report(outcome);
      if (!outcome.provisioned) break;
    }
    for (const refreshed of await refreshSpares(root)) report({ refreshed });
  }, { waitMs: REFILL_WAIT_MS });
}

/**
 * The spare's provisioned dependencies as readiness, when they are still exactly
 * what installing at its refreshed `@` would produce: recorded install inputs
 * equal the current ones and the installed tree is still on disk. Otherwise null.
 */
async function reusableDependencies(root: string, prepared: PreparedDependencies | null | undefined): Promise<ReusedDependencies | null> {
  if (!prepared?.installInputs || (prepared.state !== "ready" && prepared.state !== "not_required")) return null;
  if (prepared.state === "ready" && !existsSync(join(root, "node_modules"))) return null;
  if (await installInputFingerprint(root) !== prepared.installInputs) return null;
  return { state: prepared.state, packageManager: prepared.packageManager ?? null, installInputs: prepared.installInputs, reused: true };
}

/**
 * Exclusively assign a ready spare as workspace `name`, refreshed to the current
 * integration head. `dependencies` is the reusable readiness when the refresh
 * left the install inputs unchanged, else null and the caller installs. Returns
 * null when no spare is ready (spares still being prepared are skipped, not
 * waited for); the caller then provisions synchronously. Never falls back to the
 * primary checkout.
 */
export async function claimSpare(cwd: string, name: string): Promise<{ root: string; name: string; dependencies: ReusedDependencies | null } | null> {
  const context = await workspaceContext(cwd);
  if (!context) return null;
  // The pool is held only briefly (a claim, or a refill registering a name), so a short wait suffices.
  return await withWorkspaceTransaction(`pool:${context.integration.root}`, () => claimReadySpare(cwd, context, name), { waitMs: 3000 })
    .catch((error: unknown) => { if ((error as { code?: string } | null | undefined)?.code === "ELOCKED") return null; throw error; });
}

async function claimReadySpare(cwd: string, context: WorkspaceContext, name: string): Promise<{ root: string; name: string; dependencies: ReusedDependencies | null } | null> {
  const [spare] = await readySpares(cwd);
  if (!spare) return null;
  const { name: assigned } = await renameWorkspace(spare.root, name);
  await jj(spare.root, ["new", context.integrationBranch]);
  const dependencies = await reusableDependencies(spare.root, spare.metadata?.preparedDependencies as PreparedDependencies | null | undefined);
  const { spare: _released, prepared: _prepared, preparedDependencies: _dependencies, createdAt: _created, ...metadata } =
    (await workspaceMetadata(assigned)) ?? {};
  await writeWorkspaceJson(metadataPath(assigned), { ...metadata, workspaceName: assigned, claimedAt: new Date().toISOString() });
  return { root: spare.root, name: assigned, dependencies };
}

const REFILL_LOG_LIMIT = 1024 * 1024;

/**
 * Refill the repository's spare pool without blocking the caller: a detached,
 * `nice`d child runs the closure's own refill entry (`spare-refill.ts`, beside
 * this module in source and in the installed bundle) for the integration root,
 * appending its outcome to the pool-refill log in the state home. Concurrent refills
 * serialise on the pool transaction, and a ready spare makes one a no-op. While
 * a refill is in flight, a claim finds no ready spare and installs a fresh
 * workspace instead of waiting. `started` means the child process spawned; its
 * outcome is only in the log. `command` replaces the spawned runner (tests); the
 * integration root is always its last argument.
 */
export async function startSpareRefill(cwd: string = process.cwd(), options: { command?: string[] } = {}): Promise<{ started: boolean; pid?: number; logPath?: string; reason?: string }> {
  const context = await workspaceContext(cwd);
  if (!context) return { started: false, reason: "not-jj" };
  await mkdir(stateHome(), { recursive: true, mode: 0o700 });
  const logPath = poolRefillLogPath();
  let oversized = false;
  try { oversized = statSync(logPath).size > REFILL_LOG_LIMIT; } catch { /* no log yet */ }
  const log = openSync(logPath, oversized ? "w" : "a", 0o600);
  try {
    const [executable, ...args] = options.command ?? ["nice", "-n", "10", process.execPath, fileURLToPath(new URL("./spare-refill.ts", import.meta.url))];
    const child = spawn(executable!, [...args, context.integration.root], {
      cwd: context.integration.root,
      detached: true,
      stdio: ["ignore", log, log],
    });
    const spawned = await new Promise<Error | null>((resolveSpawn) => {
      child.once("spawn", () => resolveSpawn(null));
      child.once("error", (error) => resolveSpawn(error));
    });
    if (spawned) return { started: false, reason: spawned.message, logPath };
    child.unref();
    return { started: true, pid: child.pid, logPath };
  } finally {
    closeSync(log);
  }
}

