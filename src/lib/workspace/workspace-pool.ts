import { timed } from "./start-steps.ts";
import type { StartSteps } from "./start-steps.ts";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prepareWorkspaceDependencies } from "./workspace-dependencies.ts";
import { repositoryProjectCode, run, workspaceContext } from "../infra/workspace-jj.ts";
import type { WorkspaceContext, WorkspaceEntry } from "../infra/workspace-jj.ts";
import { metadataHome, workspaceHome } from "./workspace-paths.ts";
import { listWorkspaces, metadataPath, renameListedWorkspace, workspaceMetadata } from "./workspace-state.ts";
import { countsTowardPool, spareAllowance, spareRecords } from "./workspace-spares.ts";
import { linkSharedPaths } from "./workspace-shared-paths.ts";
import { installInputFingerprint } from "./install-inputs.ts";
import { removeWorkspace, withinWorkspaceStorage } from "./workspace-lifecycle.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "../infra/workspace-transaction.ts";
import { discardCheckout } from "./workspace-trash.ts";

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


/** Pool registration either declines a refill or reserves a workspace. */
type SpareRegistration = { reason: string; name?: never; workspacePath?: never }
  | { name: string; workspacePath: string; reason?: never };

async function jj(cwd: string, args: string[]): Promise<string> {
  const result = await run("jj", ["--color=never", ...args], { cwd });
  if (result.code !== 0) throw new Error(`jj ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}


/** Whether a listed workspace is a spare ready to claim. */
const isReadySpare = (workspace: WorkspaceEntry): boolean =>
  workspace.metadata?.spare === true && workspace.metadata?.prepared === true && Boolean(workspace.root) && existsSync(workspace.root);

/** Prepared spares for this repository. A spare still being prepared is never one. */
export async function readySpares(cwd: string): Promise<WorkspaceEntry[]> {
  return (await listWorkspaces(cwd)).filter(isReadySpare);
}


/**
 * Roots whose `node_modules` may seed an install of `workspacePath` with these install
 * inputs: prepared spares that recorded exactly them, then other workspaces that recorded
 * them when their dependencies were made ready (a claimed spare among them), then the
 * primary checkout. Every one but a spare must still have them at its last snapshot (read
 * without snapshotting: a session may own its working copy), since work may have changed
 * them since, so each of those is proved only once the candidates before it have failed.
 * Cloning only seeds the install, which still runs to verify it.
 */
function dependencySeeds(integrationRoot: string, workspacePath: string): (installInputs: string) => AsyncIterable<string> {
  return async function* (installInputs: string) {
    const recorded = (workspace: WorkspaceEntry) => resolve(workspace.root) !== resolve(workspacePath) && existsSync(join(workspace.root, "node_modules"))
      && (workspace.metadata?.preparedDependencies as PreparedDependencies | undefined)?.installInputs === installInputs;
    const workspaces = await listWorkspaces(integrationRoot);
    for (const workspace of workspaces) if (isReadySpare(workspace) && recorded(workspace)) yield workspace.root;
    for (const workspace of workspaces) {
      if (workspace.metadata?.spare !== true && workspace.root && recorded(workspace)
        && await installInputFingerprint(workspace.root, { snapshot: false }) === installInputs) yield workspace.root;
    }
    if (existsSync(join(integrationRoot, "node_modules")) && await installInputFingerprint(integrationRoot, { snapshot: false }) === installInputs) yield integrationRoot;
  };
}

/**
 * Make a workspace's dependencies current, recording the install inputs they match. Absent
 * `node_modules` are cloned from another checkout that has those inputs installed; stale ones
 * are installed over in place (see `prepareWorkspaceDependencies`). Either way the install
 * runs, as the verification. A start's installs into one repository's checkouts on
 * this machine run one at a time, so a second waits for the first and then clones its result
 * instead of installing the same inputs beside it. A refill installs under the machine's
 * refill lock instead (`refillDependencies`), so a start never queues behind a background
 * refill. `installInputs` is the workspace's fingerprint when the caller has already
 * computed it for this tree.
 */
export async function refreshDependencies(integrationRoot: string, workspacePath: string, options: { quiet?: boolean; installInputs?: string | null; steps?: StartSteps } = {}): Promise<ReturnType<typeof prepareWorkspaceDependencies> extends Promise<infer R> ? R : never> {
  return withWorkspaceTransaction(`install:${resolve(integrationRoot)}`, async () => {
    const installed = await installDependencies(integrationRoot, workspacePath, options);
    if (installed.installInputs) {
      const context = await workspaceContext(workspacePath);
      if (!context) throw new Error(`Workspace disappeared while recording dependency readiness: ${workspacePath}`);
      const { state, packageManager, installInputs } = installed;
      // Publish the seed before releasing the lock: the next install must be able to find it.
      const name = context.current.name;
      await writeWorkspaceJson(metadataPath(name), { ...await workspaceMetadata(name), preparedDependencies: { state, packageManager, installInputs } });
    }
    return installed;
  }, { waitMs: INSTALL_WAIT_MS });
}

/**
 * A refill's `refreshDependencies`: refills of every repository on this machine install one
 * at a time, each holding the machine-wide refill lock only for its install, so another
 * repository's refill gets its turn between spares. A spare being prepared is never a seed,
 * so a start's install beside it never clones a partial tree.
 */
async function refillDependencies(integrationRoot: string, workspacePath: string, options: { installInputs?: string | null } = {}) {
  return withWorkspaceTransaction("refill", async () => {
    // Timed inside the lock: waiting for another repository's refill is not this spare's cost.
    const started = performance.now();
    const prepared = await installDependencies(integrationRoot, workspacePath, { ...options, quiet: true });
    return { ...prepared, dependencyMs: Math.round(performance.now() - started) };
  }, { waitMs: REFILL_WAIT_MS });
}

const installDependencies = (integrationRoot: string, workspacePath: string, options: { quiet?: boolean; installInputs?: string | null; steps?: StartSteps }) =>
  prepareWorkspaceDependencies(workspacePath, {
    quiet: options.quiet, recordInputs: true, installInputs: options.installInputs, steps: options.steps,
    seedFrom: dependencySeeds(integrationRoot, workspacePath),
  });

/** How long a start's install waits for another of the same repository on this machine. */
const INSTALL_WAIT_MS = 30 * 60_000;

/**
 * Where a provisioned spare's dependencies came from: `handover` (a retiring checkout's trees were
 * moved in, then verified by an install over them), `clone` (copied from another checkout), `install`
 * (installed, over existing or absent trees), or `none` (the repository needs no dependencies).
 */
export type DependencySource = "handover" | "clone" | "install" | "none";

/**
 * A refill's outcome, one `pool-refill.log` line. A provisioned spare names its `project` and
 * `integrationRoot` (so a log of many repositories can be split), its dependency `dependencySource`,
 * and `dependencyMs`, the milliseconds its dependency step took (the install, including the one that
 * verifies a clone or handover); `cloneMs` is the clone alone, when the source is `clone`.
 */
export interface ProvisionOutcome {
  provisioned: boolean; reason?: string; workspacePath?: string; name?: string;
  project?: string; integrationRoot?: string; dependencySource?: DependencySource; dependencyMs?: number; cloneMs?: number;
}

/**
 * Add one spare to the pool, up to this machine's `spareAllowance`, without ever blocking a
 * claim: the pool transaction is held only to count the spares and register this
 * one's name (unprepared, marked with this process), not while the workspace is
 * added and its dependencies installed, so claims can take any other ready spare
 * meanwhile. A spare whose preparer died is adopted and finished.
 */
export async function provisionSpare(cwd: string = process.cwd()): Promise<ProvisionOutcome> {
  const context = await workspaceContext(cwd);
  if (!context) return { provisioned: false, reason: "not-jj" };
  const root = context.integration.root;
  const wanted = (await spareAllowance(context)).spares;
  const registration: SpareRegistration = await withWorkspaceTransaction(`pool:${root}`, async (): Promise<SpareRegistration> => {
    const records = await spareRecords(root);
    // A ready spare, or one a live process is preparing, counts toward the pool.
    if (records.filter(countsTowardPool).length >= wanted) {
      return { reason: wanted === 0 ? "pool-disabled" : "spare-exists" };
    }
    const abandoned = records.find((record) => !countsTowardPool(record));
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
      await discardCheckout(workspacePath);
      await jj(root, ["workspace", "add", "--name", name, "--revision", context.integrationBranch, workspacePath]);
    }
    await linkSharedPaths(root, workspacePath);
    const handedOver = Boolean((await workspaceMetadata(name))?.dependencyHandover);
    const { state, packageManager, installInputs, seeded, cloneMs, dependencyMs } = await refillDependencies(root, workspacePath);
    const dependencySource: DependencySource = state === "not_required" ? "none" : seeded ? "clone" : handedOver ? "handover" : "install";
    const { preparingPid: _done, dependencyHandover: _handover, ...metadata } = (await workspaceMetadata(name)) ?? {};
    await writeWorkspaceJson(metadataPath(name), { ...metadata, prepared: true, preparedAt: new Date().toISOString(), preparedDependencies: { state, packageManager, installInputs } });
    return {
      provisioned: true, workspacePath, name, project: await repositoryProjectCode(root), integrationRoot: root,
      dependencySource, dependencyMs, ...(dependencySource === "clone" ? { cloneMs } : {}),
    };
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
 * Keep the next claim's dependencies current, and no more. A claim moves its spare to the head
 * itself (`jj new`) and keeps its dependencies when the install inputs there are the ones they
 * were installed for, so moving spares ahead of time buys nothing. Only when no ready spare
 * recorded the integration head's install inputs (read from the head's commit, with no checkout
 * of it) is one spare refreshed: reserved under the pool lock, so no claim takes it meanwhile,
 * moved to the head, and installed over its existing `node_modules`, which changes only what
 * changed. The rest stay as they are until a claim or a later refill reaches them, so a landing
 * costs at most one install, never one per spare. A claim takes the newest spare, so a matching
 * spare that is not the newest (as after install inputs revert) is made the newest instead of
 * refreshing another. Returns the spare refreshed, if any; a refresh that fails hands its spare
 * back for the next refill.
 */
export async function refreshSpares(cwd: string): Promise<SpareRefresh[]> {
  const context = await workspaceContext(cwd);
  if (!context) return [];
  const root = context.integration.root;
  const headInputs = await installInputFingerprint(root, { revision: context.integrationBranch });
  // Unknown inputs prove nothing reusable, so a claim installs whatever is done here.
  if (!headInputs) return [];
  const spares = newestFirst(await readySpares(root));
  const covering = spares.find((spare) => reusableDependencies(spare.root, spare.metadata?.preparedDependencies as PreparedDependencies | undefined, headInputs));
  if (covering) {
    if (covering !== spares[0]) await withWorkspaceTransaction(`pool:${root}`, async () => {
      const metadata = await workspaceMetadata(covering.name);
      if (metadata?.spare === true && metadata.prepared === true) await writeWorkspaceJson(metadataPath(covering.name), { ...metadata, preparedAt: new Date().toISOString() });
    });
    return [];
  }
  for (const spare of spares) {
    const reserved = await withWorkspaceTransaction(`pool:${root}`, async () => {
      const metadata = await workspaceMetadata(spare.name);
      if (metadata?.spare !== true || metadata.prepared !== true) return null; // claimed meanwhile
      await writeWorkspaceJson(metadataPath(spare.name), { ...metadata, prepared: false, preparingPid: process.pid });
      return metadata;
    });
    if (!reserved) continue;
    try {
      await jj(spare.root, ["new", context.integrationBranch]);
      const prepared = reserved.preparedDependencies as PreparedDependencies | undefined;
      const installInputs = await installInputFingerprint(spare.root);
      let outcome: SpareRefresh["dependencies"] = "reused";
      let current: PreparedDependencies | undefined = prepared;
      if (!reusableDependencies(spare.root, prepared, installInputs)) {
        const installed = await refillDependencies(root, spare.root, { installInputs });
        outcome = installed.seeded ? "seeded" : "installed";
        current = { state: installed.state, packageManager: installed.packageManager, installInputs: installed.installInputs };
      }
      const { preparingPid: _done, ...metadata } = (await workspaceMetadata(spare.name)) ?? {};
      await writeWorkspaceJson(metadataPath(spare.name), { ...metadata, prepared: true, preparedAt: new Date().toISOString(), preparedDependencies: current });
      return [{ name: spare.name, dependencies: outcome }];
    } catch (error) {
      const metadata = await workspaceMetadata(spare.name);
      if (metadata) await writeWorkspaceJson(metadataPath(spare.name), { ...metadata, preparingPid: null }).catch(() => {});
      throw error;
    }
  }
  return [];
}

/**
 * Spares most recently prepared or refreshed first: the likeliest to have the integration head's
 * install inputs, so a claim takes one of them and a refresh leaves them alone.
 */
function newestFirst(spares: WorkspaceEntry[]): WorkspaceEntry[] {
  const preparedAt = (spare: WorkspaceEntry) => Date.parse(String(spare.metadata?.preparedAt ?? spare.metadata?.createdAt ?? "")) || 0;
  return [...spares].sort((a, b) => preparedAt(b) - preparedAt(a));
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
    const counted = records.filter(countsTowardPool).length;
    const retiring = records.filter((record) => record.prepared === true).slice(0, Math.max(0, counted - allowed));
    for (const record of retiring) {
      await writeWorkspaceJson(metadataPath(record.workspaceName), { ...await workspaceMetadata(record.workspaceName), prepared: false, preparingPid: process.pid });
    }
    return retiring.map((record) => record.workspaceName);
  });
  for (const name of excess) await removeWorkspace(root, name);
  return excess;
}

/** How long a refill waits for an earlier refill of its repository, or for another refill's install, on this machine. */
const REFILL_WAIT_MS = 60 * 60_000;

/**
 * The pool refill (`startSpareRefill`'s child, and `slipjay pool refill`): retire spares beyond
 * this machine's allowance or top the pool up to it one spare at a time, then refresh the next
 * claim's spare when the install inputs changed (`refreshSpares`), reporting each outcome. One repository's refills run one after another; refills of
 * different repositories interleave, installing one at a time (`refillDependencies`). Claims
 * never take either lock.
 */
export async function refillPool(root: string, report: (outcome: object) => void): Promise<void> {
  const integrationRoot = (await workspaceContext(root))?.integration.root ?? root;
  await withWorkspaceTransaction(`refill:${resolve(integrationRoot)}`, async () => {
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
 * equal `current`, its fingerprint there, and the installed tree is still on disk.
 * Otherwise null.
 */
function reusableDependencies(root: string, prepared: PreparedDependencies | null | undefined, current: string | null): ReusedDependencies | null {
  if (!prepared?.installInputs || (prepared.state !== "ready" && prepared.state !== "not_required")) return null;
  if (prepared.state === "ready" && !existsSync(join(root, "node_modules"))) return null;
  if (current !== prepared.installInputs) return null;
  return { state: prepared.state, packageManager: prepared.packageManager ?? null, installInputs: prepared.installInputs, reused: true };
}

/**
 * Exclusively assign a ready spare as workspace `name`, refreshed to the current
 * integration head. `dependencies` is the reusable readiness when the refresh
 * left the install inputs unchanged, else null and the caller installs, reusing
 * `installInputs`, the spare's fingerprint at its new `@`. Returns
 * null when no spare is ready (spares still being prepared are skipped, not
 * waited for); the caller then provisions synchronously. Never falls back to the
 * primary checkout.
 */
export async function claimSpare(context: WorkspaceContext, name: string, base?: string, steps?: StartSteps): Promise<ClaimedSpare | null> {
  // The pool is held only briefly (a claim, or a refill registering a name), so a short wait suffices.
  return await withWorkspaceTransaction(`pool:${context.integration.root}`, () => claimReadySpare(context, name, base, steps), { waitMs: 3000 })
    .catch((error: unknown) => { if ((error as { code?: string } | null | undefined)?.code === "ELOCKED") return null; throw error; });
}

/** A claimed spare's checkout, its new name and what its dependencies need (see `claimSpare`). */
type ClaimedSpare = { root: string; name: string; dependencies: ReusedDependencies | null; installInputs: string | null };

async function claimReadySpare(context: WorkspaceContext, name: string, base?: string, steps?: StartSteps): Promise<ClaimedSpare | null> {
  const workspaces = await listWorkspaces(context.integration.root);
  const [spare] = newestFirst(workspaces.filter(isReadySpare));
  if (!spare) return null;
  const { name: assigned } = await renameListedWorkspace(spare, workspaces, name);
  await timed(steps, "jjNew", () => jj(spare.root, ["new", base ?? context.integrationBranch]));
  const installInputs = await timed(steps, "fingerprint", () => installInputFingerprint(spare.root));
  const dependencies = reusableDependencies(spare.root, spare.metadata?.preparedDependencies as PreparedDependencies | null | undefined, installInputs);
  const { spare: _released, prepared: _prepared, preparedAt: _preparedAt, preparedDependencies: _dependencies, createdAt: _created, ...metadata } =
    (await workspaceMetadata(assigned)) ?? {};
  await writeWorkspaceJson(metadataPath(assigned), { ...metadata, workspaceName: assigned, claimedAt: new Date().toISOString() });
  return { root: spare.root, name: assigned, dependencies, installInputs };
}


