import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { jj, workspaceContext } from "../infra/workspace-jj.ts";
import { writeWorkspaceJson } from "../infra/workspace-transaction.ts";
import { stateHome } from "./workspace-paths.ts";
import { listWorkspaces, workspaceMetadata } from "./workspace-state.ts";
import { workspaceHolders, describeHolders } from "./workspace-holders.ts";
import type { ProcessWorkingDirectory } from "./workspace-holders.ts";
import { archiveWorkspace, inventoryOf, materialDigests, readArchive, syncPath } from "./workspace-archive.ts";
import { forgetWorkspace, withinWorkspaceStorage, WorkingCopyChangedError, retireWorkspace } from "./workspace-lifecycle.ts";
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

const releasesHome = () => join(stateHome(), "releases");
export const releaseResultPath = (operationId: string) => join(releasesHome(), `${operationId}.json`);

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
    return JSON.parse(await readFile(releaseResultPath(operationId), "utf8")) as ReleaseResult | ReleaseIntent;
  } catch {
    return null;
  }
}

export async function listReleaseResults(): Promise<Array<ReleaseResult | ReleaseIntent>> {
  const entries = await readdir(releasesHome()).catch(() => [] as string[]);
  const results: Array<ReleaseResult | ReleaseIntent> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const result = await readReleaseResult(entry.slice(0, -".json".length));
    if (result) results.push(result);
  }
  return results.sort((a, b) => a.at.localeCompare(b.at));
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
  if (archive.inventoryDigests && current.inventoryDigests) {
    for (const path of archived) {
      if (archive.inventoryDigests[path] !== current.inventoryDigests[path]) return false;
    }
  }
  return true;
}

export async function releaseWorkspace(workspacePath: string, options: {
  operationId: string; now?: number; processes?: ProcessWorkingDirectory[] | null;
}): Promise<ReleaseResult> {
  const at = new Date(options.now ?? Date.now()).toISOString();
  const absolute = resolve(workspacePath);
  const operationId = options.operationId;
  const record = async (result: ReleaseResult): Promise<ReleaseResult> => {
    await mkdir(releasesHome(), { recursive: true, mode: 0o700 });
    await writeWorkspaceJson(releaseResultPath(operationId), result);
    syncPath(releaseResultPath(operationId));
    syncPath(releasesHome());
    return result;
  };
  const refused = async (reason: string) =>
    await record({ state: "refused", operationId, workspacePath: absolute, reason, at });

  // An invalid id has no place to be recorded, so this answer is returned, not stored.
  if (!validOperationId(operationId)) {
    return { state: "refused", operationId, workspacePath: absolute, reason: "the operation id is not a name SlipJay can record", at };
  }
  const known = await readReleaseResult(operationId);
  if (known && resolve(known.workspacePath) !== absolute) {
    // An id names one workspace for ever. Answering without recording keeps the original
    // result authoritative instead of overwriting it with a refusal.
    return { state: "refused", operationId, workspacePath: absolute,
      reason: `operation ${operationId} already names ${known.workspacePath}`, at };
  }
  if (known && known.state === "retired") return known;

  if (!existsSync(absolute)) {
    // An intent or an uncertain result outlived the checkout: the removal happened and the
    // answer did not. Reconcile the registration it may have left behind, then say retired.
    const unfinished = known?.state === "retiring" || known?.state === "uncertain" ? known : null;
    if (unfinished?.archiveId) {
      const archive = await readArchive(unfinished.archiveId);
      if (!archive) {
        return await record({ state: "uncertain", operationId, workspacePath: absolute, archiveId: unfinished.archiveId,
          reason: "the archive this operation made is missing, so what it removed cannot be established", at });
      }
      // A directory gone while Jujutsu still lists the workspace is a removal that stopped
      // half-way; forgetting it now is what makes the record true.
      const listed = await listWorkspaces(archive.repository).catch(() => []);
      const workspaceName = unfinished.workspaceName ?? archive.workspaceName;
      if (listed.some((entry) => entry.name === workspaceName)) {
        await forgetWorkspace(archive.repository, workspaceName, absolute).catch(() => undefined);
      }
      return await record({ state: "retired", operationId, workspacePath: absolute, workspaceName,
        archiveId: unfinished.archiveId, commitId: unfinished.commitId ?? archive.commitId, at });
    }
    return await refused("the checkout is not on disk");
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
  const holders = await workspaceHolders(absolute, { processes: options.processes ?? null }).catch(() => null);
  if (holders === null) return await refused("the processes using it cannot be read");
  if (holders.length) return await refused(`in use by a live process: ${describeHolders(holders)}`);
  if ((await workspaceMetadata(workspace.name))?.spare === true) return await refused("it is a pool spare");

  return await withWorkspaceTransaction(`writer:${workspace.name}`, async (): Promise<ReleaseResult> => {
    // Re-read under the lock: a concurrent call with the same id may have finished.
    const raced = await readReleaseResult(operationId);
    if (raced && raced.state !== "retiring") return raced;

    // Snapshot the working copy first: the archive records the commit it finds, and the
    // retirement compares that same commit before it forgets anything.
    await jj(absolute, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]).catch(() => null);
    const archived = await archiveWorkspace(absolute, { reason: `released by ${operationId}`, now: options.now });
    if ("refusal" in archived) return await refused(archived.refusal);
    const archive = archived.archive;

    const fresh = async (): Promise<string | null> => {
      const inventory = await inventoryOf(absolute, integrationRoot).catch(() => null);
      if (inventory === null) return "its files outside history could not be read again after the archive";
      const digests = await materialDigests(absolute, inventory);
      return stillArchivedState(archive, { commitId: archive.commitId, inventory, inventoryDigests: digests })
        ? null : "the checkout changed while it was being archived";
    };
    const stale = await fresh();
    if (stale) return await refused(stale);

    // The intent is durable before anything is removed: a crash from here on is reconcilable.
    await mkdir(releasesHome(), { recursive: true, mode: 0o700 });
    await writeWorkspaceJson(releaseResultPath(operationId), {
      state: "retiring", operationId, workspacePath: absolute, workspaceName: workspace.name,
      archiveId: archive.id, commitId: archive.commitId, at,
    } satisfies ReleaseIntent);
    syncPath(releaseResultPath(operationId));
    syncPath(releasesHome());

    let changedAfterTeardown: string | null = null;
    try {
      await retireWorkspace(integrationRoot, { name: workspace.name, root: absolute }, {
        // The teardown runs inside retirement, so this is where its effect on the material is
        // seen: a hook that only recorded the change would let the removal continue.
        afterEvidence: async () => {
          const changed = await fresh();
          if (changed) {
            changedAfterTeardown = changed;
            throw new WorkingCopyChangedError(workspace.name);
          }
        },
      }, { expectedCommitId: archive.commitId });
    } catch (error) {
      if (error instanceof WorkingCopyChangedError) {
        return await refused(changedAfterTeardown ?? "the checkout changed between the archive and the removal");
      }
      return await record({ state: "uncertain", operationId, workspacePath: absolute, archiveId: archive.id,
        workspaceName: workspace.name, reason: error instanceof Error ? error.message : String(error), at });
    }
    if (changedAfterTeardown) {
      // Retirement refuses on this too, but name it plainly if a host ever returns first.
      return await record({ state: "uncertain", operationId, workspacePath: absolute, archiveId: archive.id,
        workspaceName: workspace.name, reason: changedAfterTeardown, at });
    }
    return await record({ state: "retired", operationId, workspacePath: absolute, workspaceName: workspace.name,
      archiveId: archive.id, commitId: archive.commitId, at });
  }, { waitMs: 120_000 });
}
