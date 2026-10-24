import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { jj, workspaceContext } from "../infra/workspace-jj.ts";
import { writeWorkspaceJson } from "../infra/workspace-transaction.ts";
import { stateHome } from "./workspace-paths.ts";
import { listWorkspaces, workspaceMetadata } from "./workspace-state.ts";
import { callerPids, describeHolders, workspaceHolders } from "./workspace-holders.ts";
import type { ProcessWorkingDirectory } from "./workspace-holders.ts";
import { archiveWorkspace, inventoryOf, materialDigests, readArchive, syncPath } from "./workspace-archive.ts";
import { finishMissingRetirement, withinWorkspaceStorage, WorkingCopyChangedError, retireWorkspace, workspaceRegistered } from "./workspace-lifecycle.ts";
import { withWorkspaceTransaction } from "../infra/workspace-transaction.ts";

/**
 * Release: the one operation a harness calls when it has decided a workspace may go.
 *
 * It preserves first and retires second. The caller's operation id makes it idempotent,
 * because a caller cannot always tell whether its request arrived: the same id answers
 * with the result it already holds rather than archiving twice or removing a workspace
 * that was already removed. The intent is written before anything is removed, so a crash
 * between the removal and the result leaves a record a later pass can reconcile instead
 * of a path that has simply vanished.
 *
 * A refusal and an uncertain outcome are different answers on purpose. A refusal means
 * nothing was removed and the checkout is intact. An uncertain outcome means a removal
 * may have half-finished, and the caller must reconcile before it uses that workspace
 * again rather than retry blindly.
 */
export type ReleaseResult =
  | { state: "retired"; operationId: string; workspacePath: string; workspaceName: string; archiveId: string; commitId: string; at: string }
  | { state: "refused"; operationId: string; workspacePath: string; reason: string; at: string }
  | { state: "uncertain"; operationId: string; workspacePath: string; reason: string; workspaceName?: string; archiveId?: string; commitId?: string; at: string };

/** Written before the removal, so a crash leaves evidence of what was being done. */
export type ReleaseIntent = {
  state: "retiring";
  operationId: string;
  workspacePath: string;
  workspaceName: string;
  archiveId: string;
  commitId: string;
  at: string;
};

/** Its own directory: `state/releases` already holds SlipJay's promotion records. */
const retirementsHome = () => join(stateHome(), "retirements");
export const retirementResultPath = (operationId: string) => join(retirementsHome(), `${operationId}.json`);

/**
 * An operation id names one record under the state home, so it must be a name and
 * nothing else: no separators, no traversal, nothing that reads as a flag.
 */
export function validOperationId(operationId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(operationId) && !operationId.includes("..");
}

export async function readReleaseResult(operationId: string): Promise<ReleaseResult | ReleaseIntent | null> {
  if (!validOperationId(operationId)) return null;
  try {
    return JSON.parse(await readFile(retirementResultPath(operationId), "utf8")) as ReleaseResult | ReleaseIntent;
  } catch {
    return null;
  }
}

export async function listReleaseResults(): Promise<Array<ReleaseResult | ReleaseIntent>> {
  const entries = await readdir(retirementsHome()).catch(() => [] as string[]);
  const results: Array<ReleaseResult | ReleaseIntent> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const result = await readReleaseResult(entry.slice(0, -".json".length));
    // Only this operation's own records: anything else that lands here is not a result.
    if (result && ["retired", "refused", "uncertain", "retiring"].includes(result.state)) results.push(result);
  }
  return results.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}

/**
 * Whether the checkout still is what the archive holds: the same commit, and the same
 * bytes, modes and links for every file outside history. Names alone would call a
 * rewritten `.env` unchanged, and a release would then delete what it never kept.
 */
export function stillArchivedState(
  archive: { commitId: string; inventory: string[]; inventoryDigests?: Record<string, string> },
  current: { commitId: string; inventory: string[]; inventoryDigests?: Record<string, string> },
): boolean {
  if (archive.commitId !== current.commitId) return false;
  const archived = new Set(archive.inventory);
  const now = new Set(current.inventory);
  if (archived.size !== now.size) return false;
  for (const path of archived) if (!now.has(path)) return false;
  // Names alone cannot prove the bytes are the ones preserved: fail closed instead.
  if (!archive.inventoryDigests || !current.inventoryDigests) return false;
  for (const path of archived) {
    if (archive.inventoryDigests[path] !== current.inventoryDigests[path]) return false;
  }
  return true;
}

/**
 * One operation, one lock. Every call for this id — a first attempt, a replay, a
 * reconciliation — is serialised here, so no two can read each other's half-finished
 * record, and the key is taken before the workspace's own keys.
 */
export async function releaseWorkspace(workspacePath: string, options: {
  operationId: string; now?: number; processes?: ProcessWorkingDirectory[] | null;
}): Promise<ReleaseResult> {
  if (!validOperationId(options.operationId)) {
    return { state: "refused", operationId: options.operationId, workspacePath: resolve(workspacePath),
      reason: "the operation id is not a name SlipJay can record", at: new Date(options.now ?? Date.now()).toISOString() };
  }
  return await withWorkspaceTransaction(`retire:${options.operationId}`, () => releaseOperation(workspacePath, options), { waitMs: 120_000 });
}

async function releaseOperation(workspacePath: string, options: {
  operationId: string; now?: number; processes?: ProcessWorkingDirectory[] | null;
}): Promise<ReleaseResult> {
  const at = new Date(options.now ?? Date.now()).toISOString();
  const absolute = resolve(workspacePath);
  const operationId = options.operationId;
  const record = async (result: ReleaseResult): Promise<ReleaseResult> => {
    await mkdir(retirementsHome(), { recursive: true, mode: 0o700 });
    await writeWorkspaceJson(retirementResultPath(operationId), result);
    syncPath(retirementResultPath(operationId));
    syncPath(retirementsHome());
    return result;
  };
  const refused = async (reason: string) =>
    await record({ state: "refused", operationId, workspacePath: absolute, reason, at });

  const known = await readReleaseResult(operationId);
  if (known && resolve(known.workspacePath) !== absolute) {
    // An id names one workspace for ever. Answering without recording keeps the original
    // result authoritative instead of overwriting it with a refusal.
    return { state: "refused", operationId, workspacePath: absolute,
      reason: `operation ${operationId} already names ${known.workspacePath}`, at };
  }
  // A finished answer is authoritative: a replay reports it and acts on nothing. A refused
  // operation is not retried under its own id either — a new attempt is a new operation,
  // otherwise a stale id could release whatever now occupies the path.
  if (known && (known.state === "retired" || known.state === "refused")) return known;

  if (!existsSync(absolute)) {
    // An intent or an uncertain result outlived the checkout: the removal happened and the
    // answer did not. Reconcile the registration and sidecars it left, under the lock, and
    // only then call it retired.
    const unfinished = known && (known.state === "retiring" || known.state === "uncertain") ? known : null;
    if (!unfinished?.archiveId) {
      // Inside the operation lock, so this read cannot race another call for the same id.
      const settled = await readReleaseResult(operationId);
      if (settled && settled.state !== "retiring" && resolve(settled.workspacePath) === absolute) return settled;
      return await refused("the checkout is not on disk");
    }
    const archiveId: string = unfinished.archiveId;
    const archive = await readArchive(archiveId);
    if (!archive) {
      return await record({ state: "uncertain", operationId, workspacePath: absolute, archiveId: unfinished.archiveId,
        reason: "the archive this operation made is missing, so what it removed cannot be established", at });
    }
    return await withWorkspaceTransaction(`allocate:${archive.repository}`, async (): Promise<ReleaseResult> => {
      const latest = await readReleaseResult(operationId);
      if (latest && resolve(latest.workspacePath) !== absolute) {
        return { state: "refused", operationId, workspacePath: absolute,
          reason: `operation ${operationId} already names ${latest.workspacePath}`, at };
      }
      if (latest && (latest.state === "retired" || latest.state === "refused")) return latest;
      if (existsSync(absolute)) {
        // Something occupies the path again: forget nothing, and do not claim a retirement.
        return { state: "uncertain", operationId, workspacePath: absolute, archiveId,
          reason: "a checkout now occupies the path; reconcile this operation by hand", at };
      }
      const workspaceName: string = unfinished.workspaceName ?? archive.workspaceName;
      try {
        await finishMissingRetirement(archive.repository, workspaceName, absolute);
      } catch (error) {
        return await record({ state: "uncertain", operationId, workspacePath: absolute, archiveId,
          workspaceName, reason: `its registration could not be reconciled: ${error instanceof Error ? error.message : String(error)}`, at });
      }
      return await record({ state: "retired", operationId, workspacePath: absolute, workspaceName,
        archiveId, commitId: unfinished.commitId ?? archive.commitId, at });
    }, { waitMs: 120_000 });
  }
  // The checkout is still here but an earlier attempt never finished: act on nothing until
  // the caller reconciles that attempt, because it may have been removing this very path.
  if (known?.state === "retiring" || known?.state === "uncertain") {
    return { state: "uncertain", operationId, workspacePath: absolute,
      ...(known.state === "uncertain" && known.archiveId ? { archiveId: known.archiveId } : {}),
      reason: "an earlier attempt for this operation did not finish; reconcile it before releasing", at };
  }
  if (!await withinWorkspaceStorage(absolute)) return await refused("it is not a workspace SlipJay manages");
  const context = await workspaceContext(absolute).catch(() => null);
  if (!context) return await refused("it is not a SlipJay workspace (no Jujutsu identity)");
  const integrationRoot = resolve(context.integration.root);
  const workspace = (await listWorkspaces(integrationRoot)).find((entry) => entry.root && resolve(entry.root) === absolute);
  if (!workspace) return await refused("the repository does not list it as a workspace");
  // The CLI's own process and its parents are not users of the checkout: they are the
  // command releasing it, and counting them would refuse every release run from its own
  // working directory.
  // An injected process list is the caller's whole view (tests and hosts use it), so only
  // the real reading discounts the command's own process and its parents.
  const ignore = options.processes ? new Set<number>() : await callerPids().catch(() => new Set<number>());
  const holders = await workspaceHolders(absolute, { processes: options.processes ?? null, ignore }).catch(() => null);
  if (holders === null) return await refused("the processes using it cannot be read");
  if (holders.length) return await refused(`in use by a live process: ${describeHolders(holders)}`);
  if ((await workspaceMetadata(workspace.name))?.spare === true) return await refused("it is a pool spare");

  // `allocate:` is the key a start or a resume takes, and `writer:` the one a removal takes:
  // holding both is what makes "cleanup first, resume waits" true rather than hoped for.
  return await withWorkspaceTransaction(`allocate:${integrationRoot}`, () =>
    withWorkspaceTransaction(`writer:${workspace.name}`, async (): Promise<ReleaseResult> => {
      // Re-read under both locks: a concurrent call with the same id may have finished.
      const raced = await readReleaseResult(operationId);
      if (raced && resolve(raced.workspacePath) !== absolute) {
        return { state: "refused", operationId, workspacePath: absolute,
          reason: `operation ${operationId} already names ${raced.workspacePath}`, at };
      }
      if (raced && (raced.state === "retired" || raced.state === "refused")) return raced;
      // The holder and spare checks were made before the lock: make them again inside it.
      const held = await workspaceHolders(absolute, { processes: options.processes ?? null, ignore }).catch(() => null);
      if (held === null) return await refused("the processes using it cannot be read");
      if (held.length) return await refused(`in use by a live process: ${describeHolders(held)}`);
      if ((await workspaceMetadata(workspace.name))?.spare === true) return await refused("it is a pool spare");

      // Snapshot the working copy first: the archive records the commit it finds, and the
      // retirement compares that same commit before it forgets anything.
      await jj(absolute, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]).catch(() => null);
      const archived = await archiveWorkspace(absolute, { reason: `released by ${operationId}`, now: options.now });
      if ("refusal" in archived) return await refused(archived.refusal);
      const archive = archived.archive;

      const fresh = async (): Promise<string | null> => {
        // No `--ignore-working-copy`: a tracked edit made during the handover snapshots into a
        // new commit here, which is exactly the change that must keep the checkout.
        const commit = (await jj(absolute, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]).catch(() => null))?.trim();
        if (!commit) return "its working copy could not be read again after the archive";
        const inventory = await inventoryOf(absolute, integrationRoot).catch(() => null);
        if (inventory === null) return "its files outside history could not be read again after the archive";
        const digests = await materialDigests(absolute, inventory);
        return stillArchivedState(archive, { commitId: commit, inventory, inventoryDigests: digests })
          ? null : "the checkout changed while it was being archived";
      };
      const stale = await fresh();
      if (stale) return await refused(stale);

      // The intent is durable before anything is removed: a crash from here on is reconcilable.
      await mkdir(retirementsHome(), { recursive: true, mode: 0o700 });
      await writeWorkspaceJson(retirementResultPath(operationId), {
        state: "retiring", operationId, workspacePath: absolute, workspaceName: workspace.name,
        archiveId: archive.id, commitId: archive.commitId, at,
      } satisfies ReleaseIntent);
      syncPath(retirementResultPath(operationId));
      syncPath(retirementsHome());

      let changed: string | null = null;
      try {
        await retireWorkspace(integrationRoot, { name: workspace.name, root: absolute }, {
          // Both hooks run inside retirement: after the teardown, and again as the very last
          // look before the forget, so a file written between them still keeps the checkout.
          afterEvidence: async () => {
            const reason = await fresh();
            if (reason) {
              changed = reason;
              throw new WorkingCopyChangedError(workspace.name);
            }
          },
          beforeForget: async () => {
            const reason = await fresh();
            if (reason) {
              changed = reason;
              throw new WorkingCopyChangedError(workspace.name);
            }
          },
        }, { expectedCommitId: archive.commitId });
      } catch (error) {
        if (error instanceof WorkingCopyChangedError) {
          return await refused(changed ?? "the checkout changed between the archive and the removal");
        }
        const reason = error instanceof Error ? error.message : String(error);
        // Nothing was removed only if the checkout, its record *and* its registration are all
        // still here. A forget can succeed and the discard then fail, leaving a directory that
        // looks intact; an unreadable registration is unknown, so it errs to uncertainty.
        const present = existsSync(absolute) && await workspaceMetadata(workspace.name).then((metadata) => metadata !== null, () => false);
        const registered = present && await workspaceRegistered(integrationRoot, workspace.name, absolute).catch(() => false);
        if (registered) return await refused(reason);
        return await record({ state: "uncertain", operationId, workspacePath: absolute, archiveId: archive.id,
          workspaceName: workspace.name, reason, at });
      }
      return await record({ state: "retired", operationId, workspacePath: absolute, workspaceName: workspace.name,
        archiveId: archive.id, commitId: archive.commitId, at });
    }, { waitMs: 120_000 }), { waitMs: 120_000 });
}
