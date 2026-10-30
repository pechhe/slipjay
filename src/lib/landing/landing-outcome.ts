import { isLandingSubmission } from "../runner/runner-contract.ts";
import type { LandingOperation, LandingOutcome, StoredEvent } from "../runner/runner-types.ts";
import { owedReceipts, receiptSettlement } from "../build/build-receipts.ts";

/** Pure operation-local history: publication elsewhere is never inferred from age or a failed push. */
export function landingOutcome(operation: LandingOperation, history: StoredEvent[]): LandingOutcome {
  const events = history.filter((row) => row.operationId === operation.id).map((row) => row.event);
  const identity = events.find((event) => event.type === "identity");
  const request = events.find((event) => event.type === "submission_request");
  const retained = events.find((event) => event.type === "source_retained");
  const expiredRow = history.find((row) => row.operationId === operation.id && row.event.type === "evidence_expired");
  const expired = expiredRow?.event.type === "evidence_expired" ? { at: expiredRow.at, policy: expiredRow.event.policy } : undefined;
  const attempt = events.findLast((event) => event.type === "attempt_prepared");
  const screens = events.flatMap((event) => event.type === "stage_detail" && event.stage === "screening" ? [event.durationMs] : []);
  const integrated = events.findLast((event) => event.type === "integrated");
  const intent = events.findLast((event) => event.type === "publication_intent");
  const classification = events.findLast((event) => event.type === "classified");
  const landed = events.findLast((event) => event.type === "landed");
  const result = operation.result;
  const published = landed !== undefined;
  // A hold may concern an earlier candidate being recovered by this operation. It still
  // prohibits blind retry. Only this operation's landed verdict certifies its publication.
  const uncertain = Boolean(integrated || intent || events.some((event) => event.type === "integration_held")
    || (result?.type === "failed" && ["integrating", "finalizing", "publishing"].includes(result.stage)));
  const publication: LandingOutcome["publication"] = landed
    ? { state: "published", base: landed.base, commitId: landed.commitId, ...landed.process ? { process: landed.process } : {} }
    : { state: uncertain ? "unconfirmed" : "not-attempted", ...(integrated ? { base: integrated.base, commitId: integrated.commitId }
      : intent ? { base: intent.base, commitId: intent.candidate } : {}) };
  const invalidated = new Set(events.filter((event) => event.type === "attempt_invalidated").map((event) => event.attempt));
  const runs: LandingOutcome["runs"] = operation.runs.map((run) => ({ ...run,
    outcome: !run.finishedAt ? "incomplete" : run.killed ? "killed"
      : run.exitCode === 0 && !run.signal && !run.timedOut ? "passed"
        : run.exitCode == null && !run.signal && !run.timedOut ? "incomplete" : "failed",
    invalidated: run.attempt !== undefined && invalidated.has(run.attempt),
  }));
  const gaps = ["Only recorded commands are listed; skipped or unstarted units are not inventoried",
    ...events.some((event) => (event.type === "submitted" || event.type === "submission_request") && "handoffSha256" in event && event.handoffSha256) ? [] : ["No author handoff (Spec snapshot, helper, check or review evidence) was supplied"]];
  if (runs.some((run) => run.artifact?.status !== "retained")) gaps.push("Some commands have no retained output artifact");
  if (runs.some((run) => run.artifact?.status === "retained" && !run.artifact.complete)) gaps.push("Some retained command artifacts contain incomplete output; inspect their truncation metadata");
  if (expired) gaps.push(`Retained source, handoff manifest and command artifacts expired under the ${expired.policy} retention policy at ${expired.at}; only ledger records remain`);
  if (runs.some((run) => run.commandEvidence?.status !== "recorded")) gaps.push("Some commands lack structured executable/argument/working-directory evidence");
  if (runs.some((run) => run.commandEvidence?.status === "recorded" && (run.commandEvidence.redacted || run.commandEvidence.cwd === null)))
    gaps.push("Some command context is redacted or outside the checkout; it cannot be replayed verbatim");
  if (!retained) gaps.push("No retained-source acknowledgement was recorded");
  if (runs.some((run) => run.diagnosticCapture !== "selected")) gaps.push("Some commands have incomplete or unavailable selected diagnostics");
  if (runs.some((run) => run.outcome === "incomplete")) gaps.push("Some command completions are unknown");
  if (!classification && result && !published) gaps.push("Failure classification was not recorded");
  if (uncertain && !published) gaps.push("Publication is unconfirmed in this operation's history; reconcile authoritative refs and held state before any retry");
  const recovery: LandingOutcome["recovery"]["kind"] = published ? "already-published" : uncertain ? "reconcile-publication"
    : !result ? "follow" : result.type === "cancelled" ? "owner-stopped" : result.type === "superseded" ? "superseded"
      : result.type === "declined" ? "policy-refusal" : "inspect-failure";
  const failure = result?.type === "failed" ? { reason: result.reason, stage: result.stage,
    ...(result.command ? { command: result.command } : {}), ...(result.output !== undefined ? { excerpt: result.output.slice(0, 6000) } : {}),
    excerptTruncated: (result.output?.length ?? 0) > 6000 }
    : result?.type === "cancelled" || result?.type === "declined" ? { reason: result.reason, excerptTruncated: false } : undefined;
  const bound = events.filter(isLandingSubmission).find((event) => event.admission || event.chore);
  // Operation-local: a publication confirmed later by another operation is counted by the drain and the snapshot.
  const owed = bound ? owedReceipts(operation, history) : [];
  const settled = owed.filter((receipt) => receipt.after === undefined || receiptSettlement(history, { operationId: receipt.operationId, key: receipt.after })?.state !== "parked")
    .map((receipt) => receiptSettlement(history, receipt)?.state);
  // A chore's Build number is Build's own, recorded with the receipt once Build has answered for that publication.
  const choreReceipt = owed.find((receipt) => receipt.action === "recordChoreLanding");
  const chore = choreReceipt && receiptSettlement(history, choreReceipt)?.chore;
  // A published landing whose receipt has not reached Build yet is still landed: delivery is reported apart.
  const build: LandingOutcome["build"] = bound ? {
    admission: bound.type === "submitted" && "chore" in bound && bound.chore ? "unassociated" : events.some((event) => event.type === "build_admitted") ? "admitted"
      : result?.type === "declined" && result.build ? "refused" : "pending",
    receipts: !owed.length ? "none" : settled.includes(undefined) ? "pending" : settled.includes("parked") ? "parked" : "delivered",
    // Only while admission is still owed: a refused, cancelled or finished landing no longer waits on it.
    ...operation.admissionUnavailable && !result && !events.some((event) => event.type === "build_admitted") ? { admissionUnavailable: operation.admissionUnavailable } : {},
    ...chore ? { chore } : {} } : undefined;
  return { version: 1, operationId: operation.id, repo: operation.repo, changeId: operation.changeId, sourceCommitId: operation.commitId,
    status: operation.status, stage: operation.stage, terminal: Boolean(result), asOfSeq: operation.lastSeq,
    ...screens.length ? { screening: { durationMs: screens.reduce((total, duration) => total + duration, 0) } } : {},
    submittedAt: operation.submittedAt, ...(operation.finishedAt ? { finishedAt: operation.finishedAt } : {}),
    ...(identity ? { identity } : {}), ...(request ? { requestId: request.requestId } : {}), ...(retained ? { sourceRetention: retained } : {}), ...(expired ? { evidenceExpired: expired } : {}),
    ...(attempt ? { attempt } : {}), publication, ...(failure ? { failure } : {}), ...(classification ? { classification } : {}), runs,
    evidence: { coverage: "partial", gaps, logCommand: `slipjay runner log ${operation.id}`, logPath: `/v1/operations/${encodeURIComponent(operation.id)}/log` },
    recovery: { kind: recovery, automaticRetry: false }, ...build ? { build } : {} };
}
