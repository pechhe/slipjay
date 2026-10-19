import { repositoryKey, TERMINAL_EVENT_TYPES } from "../runner/runner-contract.ts";
import type { AuditCause, AuditOperation, PublishedLanding, StoredEvent } from "../runner/runner-contract.ts";

/**
 * What the ledger says about a repository's nightly audits: which commit was last audited green, whether the
 * latest audit failed and who is suspected, whether anyone has recorded why, and how many landings the gate
 * passed that an audit then blamed (escapes). Pure over the log's projections, so `slipjay metrics`, the
 * promotion refusal and the cause command all read one answer.
 */

/** A repository whose last green audit finished more than this long ago is overdue: a night's slack beyond 24 hours. */
export const AUDIT_OVERDUE_AFTER_MS = 26 * 3_600_000;

export type AuditFailure = {
  /** The failing audits of this failure, oldest first: repeated failures of one defect are one failure. */
  audits: string[];
  /** When the first of them finished. */
  since: string;
  /** The newest commit any of them audited, if one resolved a head. */
  commit: string | null;
  /**
   * Published commits of the landings between the last green audit's commit and the failing ones, oldest first, by
   * integration-branch ancestry as the ledger recorded it. All landings back to the start when no audit was green
   * (or the green one is not an ancestor). Empty when no failing audit resolved a head the ledger knows.
   */
  suspects: string[];
  /** The newest cause anyone recorded on it, or null while it has none. */
  cause: (AuditCause & { by: string; at: string }) | null;
};

export type AuditSummary = {
  /** The newest audit that ran in full and passed. */
  lastGreen: { commit: string; finishedAt: string; operationId: string } | null;
  /** The newest audit that reached a verdict. A cancelled, interrupted or running one is no verdict. */
  latest: { status: "green" | "failed"; commit: string | null; finishedAt: string; operationId: string } | null;
  /** Audits are declared (some ran or are queued) and none has been green for `AUDIT_OVERDUE_AFTER_MS`. */
  overdue: boolean;
  /** The failure the latest audit belongs to, while it is failing. */
  openFailure: AuditFailure | null;
  /** Landings an audit failure blamed whose gate had passed, counted once each across every failure. */
  escapes: number;
};

/** What the ledger reads of an audit: an `AuditOperation` supplies it, and so do the stored events (`auditSummariesFromEvents`). */
export type AuditRecord = Pick<AuditOperation, "id" | "submittedAt" | "finishedAt" | "result" | "head" | "cause">;

type Verdicted = { operation: AuditRecord; green: boolean; finishedAt: string; commit: string | null };

/**
 * An audit counts as green only when it ran every declared command to a pass: none skipped, none reused.
 * The event says so itself and is checked here, so an audit that records anything less is never green.
 */
function ranInFull(result: Extract<NonNullable<AuditRecord["result"]>, { type: "audited" }>): boolean {
  return Boolean(result.commit) && result.commands.length > 0 && result.passed.length === result.commands.length
    && result.skipped.length === 0 && result.reused.length === 0;
}

/** An audit's verdict, or null while it has none (queued, running, cancelled, interrupted). */
function verdictOf(operation: AuditRecord): Verdicted | null {
  const { result, finishedAt } = operation;
  if (!finishedAt) return null;
  if (result?.type === "audited") return { operation, green: ranInFull(result), finishedAt, commit: result.commit };
  if (result?.type === "failed") return { operation, green: false, finishedAt, commit: operation.head ?? null };
  return null;
}

/** The landings in the ancestry of `head`, newest first, following each landing's recorded base. */
function ancestry(head: string | null, landings: ReadonlyMap<string, PublishedLanding>): PublishedLanding[] {
  const chain: PublishedLanding[] = [];
  const seen = new Set<string>();
  for (let commit = head; commit && !seen.has(commit);) {
    const landing = landings.get(commit);
    if (!landing) break;
    seen.add(commit);
    chain.push(landing);
    commit = landing.base;
  }
  return chain;
}

function failureOf(cluster: Verdicted[], green: Verdicted | null, landings: ReadonlyMap<string, PublishedLanding>): AuditFailure {
  const audited = green ? new Set(ancestry(green.commit, landings).map((landing) => landing.commitId)) : new Set<string>();
  const suspects = new Set<string>();
  // Later heads normally contain earlier ones; the union also covers a branch that moved backwards between runs.
  for (const failed of cluster)
    for (const landing of ancestry(failed.commit, landings).reverse()) if (!audited.has(landing.commitId)) suspects.add(landing.commitId);
  const recorded = cluster.flatMap(({ operation }) => operation.cause ? [operation.cause] : [])
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
  return {
    audits: cluster.map(({ operation }) => operation.id), since: cluster[0]!.finishedAt,
    commit: cluster.findLast(({ commit }) => commit)?.commit ?? null, suspects: [...suspects],
    cause: recorded ? { ...recorded.cause, by: recorded.by, at: recorded.at } : null,
  };
}

/**
 * The state of a repository's audits at `now`. `audits` are its audit operations in any order; `landings` its
 * published landings (`OperationLog.audits` and `OperationLog.landings`). Failing audits with no green one between
 * them are one failure, closed by the next green audit.
 */
export function auditSummary({ audits, landings }: { audits: readonly AuditRecord[]; landings: readonly PublishedLanding[] }, now: Date): AuditSummary {
  // A commit published once; a reland that found it already published repeats the landing, and the first stands.
  const published = new Map<string, PublishedLanding>();
  for (const landing of landings) if (!published.has(landing.commitId)) published.set(landing.commitId, landing);
  const verdicts = audits.flatMap((operation) => verdictOf(operation) ?? [])
    .sort((a, b) => a.finishedAt === b.finishedAt ? a.operation.id.localeCompare(b.operation.id) : Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
  const failures: { failure: AuditFailure; open: boolean }[] = [];
  let green: Verdicted | null = null;
  let cluster: Verdicted[] = [];
  const close = () => { if (cluster.length) failures.push({ failure: failureOf(cluster, green, published), open: false }); cluster = []; };
  for (const verdict of verdicts) {
    if (verdict.green) { close(); green = verdict; } else cluster.push(verdict);
  }
  if (cluster.length) { failures.push({ failure: failureOf(cluster, green, published), open: true }); cluster = []; }
  const culprits = new Set(failures.flatMap(({ failure }) => failure.cause?.kind === "culprits" ? failure.cause.landings : [])
    .filter((commit) => published.get(commit)?.gate === "green"));
  const latest = verdicts.at(-1);
  // Never green: measured from the first audit, so a repository that has only just declared one is not late.
  const since = green ? Date.parse(green.finishedAt) : audits.length ? Math.min(...audits.map((operation) => Date.parse(operation.submittedAt))) : null;
  const open = failures.find((entry) => entry.open);
  return {
    lastGreen: green ? { commit: green.commit!, finishedAt: green.finishedAt, operationId: green.operation.id } : null,
    latest: latest ? { status: latest.green ? "green" : "failed", commit: latest.commit, finishedAt: latest.finishedAt, operationId: latest.operation.id } : null,
    overdue: since !== null && now.getTime() - since > AUDIT_OVERDUE_AFTER_MS,
    openFailure: open?.failure ?? null,
    escapes: culprits.size,
  };
}

/** Why a promotion is refused on account of the audits, or null when it is not. */
export function promotionRefusal(summary: AuditSummary): string | null {
  const failure = summary.openFailure;
  if (!failure || failure.cause) return null;
  const suspects = failure.suspects.length ? ` Suspects: ${failure.suspects.slice(-5).map((commit) => commit.slice(0, 12)).join(", ")}${failure.suspects.length > 5 ? ` and ${failure.suspects.length - 5} earlier` : ""}.` : "";
  return `The latest audit failed${failure.commit ? ` at ${failure.commit.slice(0, 12)}` : ""} and no cause is recorded.${suspects} `
    + `Record one with slipjay audit cause <landing...|--flake|--infrastructure|--unresolved> before promoting.`;
}

/**
 * The failing audit a cause attaches to: `requested`, which must have failed, or the newest audit of the open
 * failure. A cause covers its whole failure, so which of its audits carries it is immaterial.
 */
export function auditToExplain<Audit extends AuditRecord>(audits: readonly Audit[], summary: AuditSummary, requested?: string): { ok: true; audit: Audit } | { ok: false; reason: string } {
  if (requested !== undefined) {
    const audit = audits.find((operation) => operation.id === requested);
    if (!audit) return { ok: false, reason: `${requested} is not an audit of this repository` };
    return audit.result?.type === "failed" || (audit.result?.type === "audited" && verdictOf(audit)?.green === false)
      ? { ok: true, audit } : { ok: false, reason: `${requested} did not fail, so it has no cause to record` };
  }
  const id = summary.openFailure?.audits.at(-1);
  const audit = audits.find((operation) => operation.id === id);
  return audit ? { ok: true, audit }
    : { ok: false, reason: "The latest audit did not fail, so there is no open failure to explain; name an earlier failing audit with --audit" };
}

/** Resolve culprit references (a landing's operation id, or its published commit id in full or by 12 or more hex digits) to published commits. */
export function resolveCulprits(references: readonly string[], landings: readonly PublishedLanding[]): { ok: true; commits: string[] } | { ok: false; reason: string } {
  if (!references.length) return { ok: false, reason: "Name at least one culprit landing" };
  const commits: string[] = [];
  for (const reference of references) {
    const matches = landings.filter((landing) => landing.operationId === reference || landing.commitId === reference
      || (/^[0-9a-f]{12,64}$/.test(reference) && landing.commitId.startsWith(reference)));
    const distinct = [...new Set(matches.map((landing) => landing.commitId))];
    if (distinct.length !== 1) return { ok: false, reason: distinct.length ? `${reference} matches more than one landing` : `${reference} is not a landing this runner published for the repository` };
    if (!commits.includes(distinct[0]!)) commits.push(distinct[0]!);
  }
  return { ok: true, commits };
}

/**
 * `auditSummary` for every repository that has audited, read from stored events alone (the runner's metrics
 * export), keyed by repository as the runner keys it. Gives the same answer as the log's own projections.
 */
export function auditSummariesFromEvents(events: readonly StoredEvent[], now: Date): Map<string, AuditSummary> {
  const terminal: readonly string[] = TERMINAL_EVENT_TYPES;
  const audits = new Map<string, { repo: string; record: { -readonly [K in keyof AuditRecord]: AuditRecord[K] } }>();
  const submissions = new Map<string, { repo: string; changeId: string | null }>();
  const published: { operationId: string; at: string; event: Extract<StoredEvent["event"], { type: "landed" }> }[] = [];
  const passed = new Set<string>(), skipped = new Set<string>();
  for (const { operationId, at, event } of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.type === "submitted") {
      if (event.kind === "audit") audits.set(operationId, { repo: repositoryKey(event.repo), record: { id: operationId, submittedAt: at } });
      else if (event.kind === undefined || event.kind === "landing") submissions.set(operationId, { repo: repositoryKey(event.repo), changeId: event.changeId });
      else if (event.kind === "recovery") submissions.set(operationId, { repo: repositoryKey(event.repo), changeId: null });
      continue;
    }
    const audit = audits.get(operationId)?.record;
    if (audit && event.type === "audit_head") audit.head = event.commit;
    else if (audit && event.type === "audit_cause") audit.cause = { cause: event.cause, by: event.by, at, ...event.note ? { note: event.note } : {} };
    else if (audit && terminal.includes(event.type)) { audit.result = event as NonNullable<AuditRecord["result"]>; audit.finishedAt = at; }
    else if (event.type === "landed") published.push({ operationId, at, event });
    else if (event.type === "verification_passed") passed.add(event.candidate);
    else if (event.type === "verification_skipped") skipped.add(event.candidate);
  }
  const repositories = new Set([...audits.values()].map(({ repo }) => repo));
  return new Map([...repositories].map((repo) => [repo, auditSummary({
    audits: [...audits.values()].filter((audit) => audit.repo === repo).map(({ record }) => record),
    landings: published.flatMap(({ operationId, at, event }) => {
      const submission = submissions.get(operationId);
      return submission?.repo === repo ? [{ operationId, changeId: submission.changeId, commitId: event.commitId, base: event.base, at,
        gate: skipped.has(event.commitId) ? "skipped" as const : passed.has(event.commitId) ? "green" as const : "none" as const }] : [];
    }),
  }, now)]));
}
