import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { trackedManifests } from "./workspace-dependencies.ts";
import { repositoryProjectCode, run, workspaceContext } from "../infra/workspace-jj.ts";
import type { WorkspaceContext } from "../infra/workspace-jj.ts";
import { metadataHome, workspaceHome } from "./workspace-paths.ts";
import { listWorkspaces, metadataPath, readJsonOptional, workspaceMetadata } from "./workspace-state.ts";
import { describeHolders, processAlive, processWorkingDirectories, workspaceHolders } from "./workspace-holders.ts";
import { startBackgroundEntry } from "./workspace-background.ts";
import { DEFAULT_SPARES } from "../policy/execution-policy.ts";
import { machineSpareLimit } from "../policy/machine-config.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "../infra/workspace-transaction.ts";

/**
 * The spare pool's registry: which spares a repository has and how many this machine keeps,
 * apart from how they are prepared and claimed (workspace-pool.ts), so retirement can hand a
 * retiring checkout's dependencies to a new spare (`reserveSpareForHandover`).
 */

/** A spare's registration, including a possibly unfinished preparation. */
export interface SpareRecord {
  spare: true;
  integrationRoot: string;
  workspaceName: string;
  workspacePath: string;
  prepared?: boolean;
  preparingPid?: number | null;
}

/** How many spares this machine keeps for a repository, and why. */
export interface SpareAllowance {
  spares: number;
  /** The repository's `spares` (or the default). */
  declared: number;
  /** This machine's limit for the repository, or null when it sets none. */
  machineLimit: number | null;
  /**
   * Where `declared` was read: the policy committed on the integration bookmark at this commit,
   * never the primary checkout's working files, so an unlanded or stale local edit cannot change it.
   */
  source: { integrationBranch: string; commitId: string | null };
}

/**
 * This machine's spare count for the repository: its declared `spares`, lowered (never
 * raised) by the machine's limit, `spares` in ~/.slipjay/config.json keyed by the
 * integration checkout's absolute path. A malformed limit fails rather than being ignored.
 */
export async function spareAllowance(context: WorkspaceContext): Promise<SpareAllowance> {
  const declared = context.configuration.spares ?? DEFAULT_SPARES;
  const machineLimit = machineSpareLimit(context.integration.root);
  return { spares: machineLimit === null ? declared : Math.min(declared, machineLimit), declared, machineLimit,
    source: { integrationBranch: context.integrationBranch, commitId: context.policyCommitId ?? null } };
}

/**
 * Every spare registered for the repository, ready, in progress or abandoned, from its metadata
 * records: those naming its integration checkout by real path (so a symlinked or differently
 * spelled path still matches), and, when a record names a checkout path that no longer exists,
 * any that is still one of its JJ workspaces, so spares recorded under an old checkout path still
 * count against the allowance and can be retired.
 */
export async function spareRecords(integrationRoot: string): Promise<SpareRecord[]> {
  const records: SpareRecord[] = [];
  const root = await realpath(integrationRoot).catch(() => resolve(integrationRoot));
  let members: Set<string> | undefined;
  for (const file of await readdir(metadataHome()).catch(() => [])) {
    if (!file.endsWith(".json")) continue;
    const metadata = await readJsonOptional(join(metadataHome(), file)) as SpareRecord | null;
    if (metadata?.spare !== true || typeof metadata.integrationRoot !== "string") continue;
    const recorded = await realpath(metadata.integrationRoot).catch(() => null);
    if (recorded === root) records.push(metadata);
    else if (recorded === null) {
      // Rare, so JJ is read only then.
      members ??= new Set((await listWorkspaces(integrationRoot, { readOnly: true })).map((workspace) => workspace.name));
      if (members.has(metadata.workspaceName)) records.push(metadata);
    }
  }
  return records;
}

/**
 * Refill the repository's spare pool without blocking the caller: a detached,
 * `nice`d child runs the package's own refill entry (`src/launcher/spare-refill.ts`,
 * in source and in the installed package) for the integration root,
 * appending its outcome to the pool-refill log in the state home. Concurrent refills
 * serialise on the pool transaction, and a ready spare makes one a no-op. While
 * a refill is in flight, a claim finds no ready spare and installs a fresh
 * workspace instead of waiting. `started` means the child process spawned; its
 * outcome is only in the log. `command` replaces the spawned runner (tests); the
 * integration root is always its last argument.
 */
export async function startSpareRefill(cwd: string = process.cwd(), options: { command?: string[] } = {}): Promise<{ started: boolean; pid?: number; logPath?: string; reason?: string }> {
  return await startBackgroundEntry(cwd, "../../launcher/spare-refill.ts", options);
}

/** The host's processes could not be read, so the pool cannot tell a free spare from a held checkout, and takes none. */
export class ProcessesUnreadableError extends Error {
  constructor() { super("The processes on this host cannot be read, so the pool cannot tell a free spare from a held checkout"); }
}

/**
 * Which of `paths` a live process other than this one is working in, each with its holders. A checkout
 * one names is held by a thread whatever its record says, so the pool neither counts, adopts, refreshes,
 * claims nor retires it (SJ-118), as sweeps and release already refuse it. Throws
 * `ProcessesUnreadableError` when processes cannot be read.
 */
export async function occupiedPaths(paths: string[]): Promise<Map<string, string>> {
  if (!paths.length) return new Map();
  const processes = await processWorkingDirectories();
  if (!processes) throw new ProcessesUnreadableError();
  const occupied = new Map<string, string>();
  for (const path of paths) {
    const holders = await workspaceHolders(path, { processes, ignore: new Set([process.pid]) });
    if (holders?.length) occupied.set(path, describeHolders(holders));
  }
  return occupied;
}

/**
 * The pool's spares (`spareRecords`) apart from those a live process is working in, which are `held`
 * with who holds them. A spare a live refill is preparing is the pool's own work, never held.
 */
export async function poolSpares(integrationRoot: string): Promise<{ spares: SpareRecord[]; held: { workspaceName: string; holders: string }[] }> {
  const records = await spareRecords(integrationRoot);
  const occupied = await occupiedPaths(records.filter((record) => !processAlive(record.preparingPid)).map((record) => record.workspacePath));
  return {
    spares: records.filter((record) => !occupied.has(record.workspacePath)),
    held: records.flatMap((record) => occupied.has(record.workspacePath) ? [{ workspaceName: record.workspaceName, holders: occupied.get(record.workspacePath)! }] : []),
  };
}

/** Whether a spare counts toward the pool: ready, or being prepared by a live process. One neither is abandoned, for a refill to adopt. */
export const countsTowardPool = (record: SpareRecord): boolean => record.prepared === true || processAlive(record.preparingPid);

/** A new spare made to receive a retiring checkout's dependencies, and the manifests whose trees it can take. */
export interface SpareHandover { integrationRoot: string; name: string; path: string; manifests: string[] }

/**
 * Make a new spare to receive a retiring checkout's `node_modules`, when the pool is short and no
 * abandoned spare already waits for a refill, or return null. The spare is a fresh workspace at the
 * integration head under its own new path, so a session still holding the retiring path never finds
 * another task's checkout there. It is registered unprepared and held by this process, so no claim or
 * refill takes it, until `releaseSpareHandover`. Retirement moves the trees in (`moveNodeModules`) only
 * once its last checks pass, which is a rename, where cloning them costs minutes and millions of file
 * events in a large repository.
 */
export async function reserveSpareForHandover(integrationRoot: string, retiringRoot: string): Promise<SpareHandover | null> {
  if (!existsSync(join(retiringRoot, "node_modules"))) return null;
  const context = await workspaceContext(integrationRoot);
  if (!context) return null;
  const root = context.integration.root;
  const wanted = (await spareAllowance(context)).spares;
  const name = await withWorkspaceTransaction(`pool:${root}`, async () => {
    const { spares: records } = await poolSpares(root);
    if (records.filter(countsTowardPool).length >= wanted || records.some((record) => !countsTowardPool(record))) return null;
    const name = `${await repositoryProjectCode(root)}-spare-${randomUUID().slice(0, 6)}`;
    await mkdir(metadataHome(), { recursive: true, mode: 0o700 });
    await writeWorkspaceJson(metadataPath(name), { version: 1, workspaceName: name, workspacePath: join(workspaceHome(), name), integrationRoot: root,
      spare: true, createdAt: new Date().toISOString(), prepared: false, preparingPid: process.pid });
    return name;
  });
  if (!name) return null;
  const handover = { integrationRoot: root, name, path: join(workspaceHome(), name), manifests: [] as string[] };
  try {
    await mkdir(workspaceHome(), { recursive: true, mode: 0o700 });
    const added = await run("jj", ["--color=never", "workspace", "add", "--name", name, "--revision", context.integrationBranch, handover.path], { cwd: root });
    if (added.code !== 0) throw new Error(`jj workspace add failed: ${(added.stderr || added.stdout).trim()}`);
    handover.manifests = await trackedManifests(handover.path) ?? [];
    return handover;
  } catch (error) {
    await releaseSpareHandover(handover);
    throw error;
  }
}

/**
 * Hand a reserved spare to the refill, whatever retirement did: the refill started here adopts it and
 * installs over any trees moved in, which changes only what changed, or finishes the checkout itself.
 */
export async function releaseSpareHandover(handover: SpareHandover): Promise<void> {
  const metadata = await workspaceMetadata(handover.name);
  if (metadata) await writeWorkspaceJson(metadataPath(handover.name), { ...metadata, preparingPid: null });
  await startSpareRefill(handover.integrationRoot).catch(() => undefined);
}
