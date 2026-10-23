import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { repairAuthority } from "../landing/repair-claim.ts";
import { submissionStorePath } from "../landing/submission-source.ts";
import { landingCommandEnvironment } from "../infra/workspace-command.ts";
import type { Executor, LandingOperation, OperationLog } from "./runner-types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** After its logical change published, an attempt's evidence explains history only. */
export const PUBLISHED_RETENTION_MS = 14 * DAY_MS;
/** A failed, cancelled or superseded attempt nobody adopted, measured from its outcome. */
export const UNADOPTED_RETENTION_MS = 30 * DAY_MS;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

type Expiry = { operation: LandingOperation; policy: "published" | "unadopted" };

/** What one retention pass did: the attempts whose evidence it expired, and the ones whose files a later pass must finish. */
export type RetentionPass = { pruned: string[]; unfinished: string[] };

/**
 * The retention policy that has expired `operation`'s evidence, if any. Open attempts,
 * unconfirmed publication and a change under an active repair claim never expire: they
 * wait for reconciliation or the claim to close.
 */
function expiryPolicy(log: OperationLog, operation: LandingOperation, now: Date): Expiry["policy"] | null {
  if (!operation.finishedAt || !operation.outcome || operation.outcome.evidenceExpired) return null;
  if (operation.outcome.publication.state === "unconfirmed") return null;
  if (repairAuthority(log, operation.repo, operation.changeId).active) return null;
  const published = log.operationsForChange(operation.repo, operation.changeId).some((attempt) => attempt.status === "landed");
  return now.getTime() - Date.parse(operation.finishedAt) >= (published ? PUBLISHED_RETENTION_MS : UNADOPTED_RETENTION_MS)
    ? published ? "published" : "unadopted" : null;
}

const retainedOperations = (log: OperationLog) => log.retainedEvidence()
  .flatMap((id) => { const operation = log.operation(id); return operation?.kind === "landing" ? [operation] : []; });

/** Landing attempts whose retained source, manifest and command artifacts may now be deleted. */
export function expiredEvidence(log: OperationLog, now: Date): Expiry[] {
  return retainedOperations(log).flatMap((operation) => {
    const policy = expiryPolicy(log, operation, now);
    return policy ? [{ operation, policy }] : [];
  });
}

/**
 * Record expiry, then delete. The record comes first because it fences repair claims,
 * which refuse expired evidence after their own awaited checks: a claim admitted during
 * a pass keeps its evidence, since the policy is rechecked just before recording. A
 * deletion cut short leaves files a later pass removes. Unreferenced source objects go
 * with Git's own gc expiry, so a submission fetching concurrently keeps its objects.
 */
export async function pruneRetainedEvidence(input: {
  home: string; log: OperationLog; executor: Executor; gitExecutable?: string; env?: NodeJS.ProcessEnv; now?: Date;
}): Promise<RetentionPass> {
  const { home, log, executor } = input;
  const now = input.now ?? new Date();
  const stores = new Set<string>();
  const git = async (args: string[]) => {
    const result = await executor.run({ executable: input.gitExecutable ?? "git", args, cwd: home, env: landingCommandEnvironment(input.env),
      timeoutMs: 120_000, maxOutputBytes: 16_384, maxOutputBytesPerStream: 8192 });
    if (result.exitCode !== 0 || result.signal || result.timedOut || result.cancelled) throw new Error(`git ${args[2] ?? ""} failed`);
  };
  const manifest = (id: string) => join(home, "submissions", `${digest(id)}.json`);
  const artifacts = (id: string) => join(home, "command-artifacts", digest(id));
  const present = (path: string) => stat(path).then(() => true, () => false);
  const pruned: string[] = [];
  const unfinished: string[] = [];
  for (const candidate of retainedOperations(log)) {
    // Current state, not the scan's: an earlier deletion awaited I/O.
    const operation = log.operation(candidate.id);
    if (operation?.kind !== "landing") continue;
    const policy = expiryPolicy(log, operation, now);
    if (policy) { log.append(operation.id, { type: "evidence_expired", policy }); pruned.push(operation.id); }
    else if (!operation.outcome?.evidenceExpired || !(await present(manifest(operation.id)) || await present(artifacts(operation.id)))) continue;
    try {
      const retained = operation.outcome?.sourceRetention;
      if (retained) {
        const store = submissionStorePath(home, operation.repo);
        await git(["--git-dir", store, "update-ref", "-d", retained.sourceRef]);
        stores.add(store);
        await rm(manifest(operation.id), { force: true });
      }
      await rm(artifacts(operation.id), { recursive: true, force: true });
    } catch { /* Recorded as expired; a later pass finishes the deletion, and the caller keeps what names the files. */ unfinished.push(operation.id); }
  }
  for (const store of stores) await git(["--git-dir", store, "gc", "--auto", "--quiet"]).catch(() => {});
  return { pruned, unfinished };
}
