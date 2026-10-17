import { randomUUID } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { processAlive, describeHolders, workspaceHolders } from "./workspace-holders.ts";
import { removeWorkspace, retainedWorkspaceMaterial } from "./workspace-lifecycle.ts";
import { attemptHome } from "./workspace-paths.ts";
import { listWorkspaces, lockPath, readJsonOptional, workspaceMetadata } from "./workspace-state.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "./workspace-transaction.ts";

/**
 * Durable allocation attempts. A caller that names its start (`start --attempt <id>`, or
 * `attemptId`) can learn which checkout that start allocated even when the start never
 * printed its receipt: dependency preparation failed, the receipt was lost or malformed, the
 * caller timed out, or either process died. The record is written before anything is
 * allocated and updated as the start proceeds, and `releaseAttempt` reconciles it, removing
 * only a checkout this attempt created or claimed and nothing has used since.
 */

/** An attempt id: a caller-chosen token such as a UUID. */
export const ATTEMPT_ID: RegExp = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type AllocationAttempt = {
  version: 1;
  attemptId: string;
  integrationRoot: string;
  issueNumber: number | null;
  /** `allocating` until a checkout is assigned, `preparing` while its dependencies are made ready. */
  status: "allocating" | "preparing" | "ready" | "failed";
  /** The process running the start; with `allocating` or `preparing`, a dead one means the start was interrupted. */
  pid: number;
  startedAt: string;
  /** The checkout assigned, once known (its path once it exists). */
  workspaceName?: string;
  workspacePath?: string;
  /** True when this attempt created or claimed the checkout; a bound or resumed one is never its to remove. */
  owned?: boolean;
  finishedAt?: string;
  error?: string;
};

const attemptPath = (attemptId: string) => join(attemptHome(), `${attemptId}.json`);

function validAttemptId(attemptId: string): string {
  if (!ATTEMPT_ID.test(attemptId)) throw new Error(`Invalid allocation attempt id '${attemptId}': use letters, digits, '.', '_' and '-' (at most 128)`);
  return attemptId;
}

/**
 * Open an attempt before anything is allocated. An id names one start: the record is created
 * exclusively (written aside, then linked into place, which fails if it exists), so of two
 * starts reusing an id, even at once, exactly one proceeds.
 */
export async function beginAttempt(attemptId: string, integrationRoot: string, issueNumber: number | null): Promise<void> {
  const path = attemptPath(validAttemptId(attemptId));
  await mkdir(attemptHome(), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({
      version: 1, attemptId, integrationRoot, issueNumber, status: "allocating", pid: process.pid, startedAt: new Date().toISOString(),
    } satisfies AllocationAttempt), { mode: 0o600 });
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Allocation attempt '${attemptId}' already exists; read it with \`slipjay attempt show ${attemptId}\``);
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Record what the start has learned since. */
export async function updateAttempt(attemptId: string, update: Partial<AllocationAttempt>): Promise<void> {
  const current = await readJsonOptional<AllocationAttempt>(attemptPath(attemptId));
  if (current) await writeWorkspaceJson(attemptPath(attemptId), { ...current, ...update });
}

/** An attempt with whether its start is still running; null when no such attempt was recorded. */
export async function readAttempt(attemptId: string): Promise<(AllocationAttempt & { interrupted: boolean }) | null> {
  const attempt = await readJsonOptional<AllocationAttempt>(attemptPath(validAttemptId(attemptId)));
  if (!attempt) return null;
  const running = attempt.status === "allocating" || attempt.status === "preparing";
  return { ...attempt, interrupted: running && !processAlive(attempt.pid) };
}

export type AttemptRelease =
  | { released: true; removed: string | null; reason?: string }
  | { released: false; reason: string };

/**
 * Reconcile an attempt the caller no longer wants: remove the checkout it created or claimed,
 * then forget the attempt. Only that checkout is ever removed, and only while it is still this
 * attempt's, unused and empty: a bound or resumed checkout (a resumed Issue's), one another
 * attempt now holds, and one that has gone are kept and the attempt is forgotten; a checkout
 * with a live process or owner, unlanded work, unique files or undelivered runner facts keeps
 * the attempt too, so the caller can retry once that ends. A start still running is refused.
 */
export async function releaseAttempt(attemptId: string): Promise<AttemptRelease> {
  const attempt = await readAttempt(attemptId);
  if (!attempt) return { released: false, reason: "unknown attempt" };
  if ((attempt.status === "allocating" || attempt.status === "preparing") && !attempt.interrupted) return { released: false, reason: "the start is still running" };
  const forget = async (reason?: string): Promise<AttemptRelease> => {
    await rm(attemptPath(attemptId), { force: true });
    return { released: true, removed: null, ...reason ? { reason } : {} };
  };
  if (!attempt.workspaceName) return forget("nothing was allocated");
  if (!attempt.owned) return forget("the checkout was bound or resumed, not created by this attempt");
  // Under the allocation lock, so no start can bind or resume the checkout between this check and its removal.
  return await withWorkspaceTransaction(`allocate:${attempt.integrationRoot}`, () => releaseOwnedCheckout(attempt, forget));
}

async function releaseOwnedCheckout(attempt: AllocationAttempt & { interrupted: boolean }, forget: (reason?: string) => Promise<AttemptRelease>): Promise<AttemptRelease> {
  const { attemptId } = attempt;
  const name = attempt.workspaceName!;
  const workspace = (await listWorkspaces(attempt.integrationRoot, { readOnly: true })).find((entry) => entry.name === name);
  if (!workspace?.root) return forget("the checkout no longer exists");
  // Every later bind or resume records its own marker (null without an attempt). A checkout with none
  // was never assigned since: a start that died before marking what it created.
  const marker = (await workspaceMetadata(name))?.allocationAttempt;
  if (marker !== attemptId && !(marker === undefined && attempt.interrupted)) return forget("the checkout is no longer this attempt's");
  const holders = await workspaceHolders(workspace.root);
  if (!holders) return { released: false, reason: "process working directories unavailable" };
  if (holders.length) return { released: false, reason: `in use by a live process: ${describeHolders(holders)}` };
  const owner = await readJsonOptional<{ pid?: unknown }>(lockPath(name));
  if (owner && processAlive(owner.pid)) return { released: false, reason: "in use by a live process" };
  const unique = await retainedWorkspaceMaterial(workspace.root, attempt.integrationRoot);
  if (unique.length) return { released: false, reason: `holds unique files: ${unique.join(", ")}` };
  try {
    // Refuses unlanded work, undelivered runner facts and checkouts outside workspace storage.
    await removeWorkspace(attempt.integrationRoot, name, { allowIssue: true });
  } catch (error) {
    return { released: false, reason: error instanceof Error ? error.message : String(error) };
  }
  await rm(attemptPath(attemptId), { force: true });
  return { released: true, removed: name };
}
