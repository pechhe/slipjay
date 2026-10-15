import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { repairAuthority } from "./repair-claim.ts";
import { submissionStorePath } from "./submission-source.ts";
import { landingCommandEnvironment } from "./workspace-command.ts";
import type { Executor, LandingOperation, OperationLog } from "./runner-contract.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** After its logical change published, an attempt's evidence explains history only. */
export const PUBLISHED_RETENTION_MS = 14 * DAY_MS;
/** A failed, cancelled or superseded attempt nobody adopted, measured from its outcome. */
export const UNADOPTED_RETENTION_MS = 30 * DAY_MS;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Landing attempts whose retained source, manifest and command artifacts may now be
 * deleted. Open attempts, unconfirmed publication and a change under an active repair
 * claim are never expired: they wait for reconciliation or the claim to close.
 */
export function expiredEvidence(log: OperationLog, now: Date): { operation: LandingOperation; policy: "published" | "unadopted" }[] {
  const ids = new Set(log.events().flatMap((row) => row.event.type === "source_retained"
    || row.event.type === "run_finished" && row.event.artifact?.status === "retained" ? [row.operationId] : []));
  const expired: { operation: LandingOperation; policy: "published" | "unadopted" }[] = [];
  for (const id of ids) {
    const operation = log.operation(id);
    if (operation?.kind !== "landing" || !operation.finishedAt || !operation.outcome || operation.outcome.evidenceExpired) continue;
    if (operation.outcome.publication.state === "unconfirmed") continue;
    if (repairAuthority(log, operation.repo, operation.changeId).active) continue;
    const published = log.operationsForChange(operation.repo, operation.changeId).some((attempt) => attempt.status === "landed");
    const age = now.getTime() - Date.parse(operation.finishedAt);
    if (age >= (published ? PUBLISHED_RETENTION_MS : UNADOPTED_RETENTION_MS)) expired.push({ operation, policy: published ? "published" : "unadopted" });
  }
  return expired;
}

/**
 * Delete expired evidence, then record it, so a reader reports expiry rather than
 * tampering. A crash between the two leaves files missing for an unexpired record,
 * which readers already refuse; the next pass records it. Unreferenced source objects
 * go with Git's own gc expiry, so a submission fetching concurrently keeps its objects.
 */
export async function pruneRetainedEvidence(input: {
  home: string; log: OperationLog; executor: Executor; gitExecutable?: string; env?: NodeJS.ProcessEnv; now?: Date;
}): Promise<string[]> {
  const { home, log, executor } = input;
  const expired = expiredEvidence(log, input.now ?? new Date());
  const stores = new Set<string>();
  const git = async (args: string[]) => {
    const result = await executor.run({ executable: input.gitExecutable ?? "git", args, cwd: home, env: landingCommandEnvironment(input.env),
      timeoutMs: 120_000, maxOutputBytes: 16_384, maxOutputBytesPerStream: 8192 });
    if (result.exitCode !== 0 || result.signal || result.timedOut || result.cancelled) throw new Error(`git ${args[2] ?? ""} failed`);
  };
  const pruned: string[] = [];
  for (const { operation, policy } of expired) {
    try {
      const retained = operation.outcome?.sourceRetention;
      if (retained) {
        const store = submissionStorePath(home, operation.repo);
        await git(["--git-dir", store, "update-ref", "-d", retained.sourceRef]);
        stores.add(store);
        await rm(join(home, "submissions", `${digest(operation.id)}.json`), { force: true });
      }
      await rm(join(home, "command-artifacts", digest(operation.id)), { recursive: true, force: true });
      log.append(operation.id, { type: "evidence_expired", policy });
      pruned.push(operation.id);
    } catch { /* A later pass retries; nothing was recorded as expired. */ }
  }
  for (const store of stores) await git(["--git-dir", store, "gc", "--auto", "--quiet"]).catch(() => {});
  return pruned;
}
