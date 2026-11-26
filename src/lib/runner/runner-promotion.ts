import { promotionRefusal, auditSummary } from "../release/audit-ledger.ts";
import type { PromotionState } from "../release/release-types.ts";
import type { OperationLog, PromotionVerification, VerificationOperation } from "./runner-types.ts";

/** The newest commits staging is green on that a promotion state lists, before it is extended to reach a named commit. */
export const PROMOTION_GREEN_COMMITS = 20;
/** The newest finished verifications of commits no one named that a promotion state keeps, enough to report the latest batch check. */
export const PROMOTION_FINISHED_VERIFICATIONS = 3;

const compact = (operation: VerificationOperation): PromotionVerification => {
  const result = operation.result;
  const reduced: PromotionVerification["result"] = !result ? undefined
    : result.type === "verified" ? { type: "verified", base: result.base, checks: result.checks }
    : result.type === "failed" ? { type: "failed", reason: result.reason, ...result.command ? { command: result.command } : {} }
    : result.type === "superseded" ? { type: "superseded", by: result.by }
    : result.type === "cancelled" ? { type: "cancelled", reason: result.reason, ...result.by ? { by: result.by } : {} }
    : { type: result.type } as PromotionVerification["result"];
  return { id: operation.id, commitId: operation.commitId, status: operation.status, submittedAt: operation.submittedAt,
    ...operation.finishedAt ? { finishedAt: operation.finishedAt } : {}, ...reduced ? { result: reduced } : {} };
};

/**
 * What a promotion plan reads of `repo` (the key of `repositoryKey`), whose size does not grow with its history: see
 * `GET /v1/promotion` in `runner-types.ts`. `named` are the commits (ids or prefixes) the plan cares about.
 */
export function promotionState(log: OperationLog, repo: string, named: string[]): PromotionState & { stagingGreenCommits: string[]; auditRefusal: string | null } {
  const isNamed = (commitId: string): boolean => named.some((commit) => commitId.startsWith(commit));
  const green = [...new Set(log.deployments(repo, "staging").filter((operation) => operation.result?.type === "deployed").map((operation) => operation.commitId))];
  const reach = Math.max(PROMOTION_GREEN_COMMITS, ...green.map((commit, index) => isNamed(commit) ? index + 1 : 0));
  // Approvals older than the newest release that shipped are ancestors of it (the integration branch is linear).
  const approved: string[] = [];
  for (const release of log.releases(repo)) {
    if (release.status === "cancelled" || release.status === "superseded") continue;
    approved.push(release.commitId);
    if (release.result?.type === "released") break;
  }
  let finished = 0;
  const verifications = log.verifications(repo).filter((operation) => {
    if (isNamed(operation.commitId) || operation.status === "queued" || operation.status === "running") return true;
    return (operation.status === "failed" || operation.status === "verified") && finished++ < PROMOTION_FINISHED_VERIFICATIONS;
  }).map(compact);
  return { verifications, approved, stagingGreen: green[0] ?? null, stagingGreenCommits: green.slice(0, reach),
    auditRefusal: promotionRefusal(auditSummary({ audits: log.audits(repo), landings: log.landings(repo) }, new Date())) };
}
