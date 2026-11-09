import type { VerificationDeclaration } from "../policy/verification-policy.ts";
import { repositoryKey, TERMINAL_EVENT_TYPES } from "../runner/runner-contract.ts";
import { failureCategory, namedError } from "../runner/failure-classification.ts";
import type { AuditCause, AuditOperation, FailureCategory, PublishedLanding, StoredEvent } from "../runner/runner-types.ts";

/**
 * What the ledger says about a repository's nightly audits: which commit was last audited green, whether the
 * latest audit failed and who is suspected, whether anyone has recorded why, and how many landings the gate
 * passed that an audit then blamed (escapes). Pure over the log's projections, so `slipjay metrics`, the
 * promotion refusal and the cause command all read one answer.
 */

/** A repository whose last green audit finished more than this long ago is overdue: a night's slack beyond 24 hours. */
export const AUDIT_OVERDUE_AFTER_MS = 26 * 3_600_000;

/** One failing audit, as its own night: what it said failed and why, never merged with another night's (SJ-215). */
export type AuditNight = {
  audit: string; finishedAt: string; commit: string | null;
  /** The category the runner recorded, or the one its rule gives the failure's recorded facts when it recorded none. */
  category: FailureCategory;
  /** False when the category was derived now from a failure recorded before rule 3: the classifier's reading, not a recorded fact. */
  recorded: boolean;
  /** The tests this night's run failed, and the error the first one printed. */
  failingTests: string[]; firstError?: string;
};

export type AuditFailure = {
  /** The failing audits of this failure, oldest first: repeated failures of one defect are one failure. */
  audits: string[];
  /** Each of them as its own night: the failures of different nights may have different causes. */
  nights: AuditNight[];
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
  /** The newest audit that reached a verdict. A cancelled, interrupted or running one is no verdict; an inconclusive one reached none. */
  latest: { status: "green" | "failed" | "inconclusive"; commit: string | null; finishedAt: string; operationId: string } | null;
  /** Audits are declared (some ran or are queued) and none has been green for `AUDIT_OVERDUE_AFTER_MS`. */
  overdue: boolean;
  /** The failure the latest audit belongs to, while it is failing. */
  openFailure: AuditFailure | null;
  /**
   * The inconclusive audits since the last audit that judged the repository (green or failing), oldest first:
   * `audits` are the ones no recorded cause covers yet, and `cause` the newest cause recorded on an inconclusive audit.
   * Two uncovered ones refuse promotion; a single one does not. Null when there is no such run.
   */
  inconclusive: { audits: string[]; cause: (AuditCause & { by: string; at: string }) | null } | null;
  /** Landings an audit failure blamed whose gate had passed, counted once each across every failure. */
  escapes: number;
};

/** What the ledger reads of an audit: an `AuditOperation` supplies it, and so do the stored events (`auditSummariesFromEvents`). */
export type AuditRecord = Pick<AuditOperation, "id" | "submittedAt" | "finishedAt" | "result" | "head" | "cause" | "classification" | "verifyLoad">;

type Verdicted = { operation: AuditRecord; verdict: "green" | "failed" | "inconclusive"; finishedAt: string; commit: string | null };

/**
 * Whether a failed audit could not judge the suite: every one of its failures is a non-zero exit from a command that
 * declares that exit code as inconclusive, decided from the failures and the policy that ran, never from output text.
 * A timeout, signal, kill, spawn failure or undeclared exit is a failure. Fixed on the audit's terminal event when it
 * ends, so a later policy cannot change what a recorded audit meant.
 */
export function auditInconclusive(failures: readonly { checkIndex: number; outcome: string; exitCode: number | null }[],
  commands: readonly VerificationDeclaration[]): boolean {
  return failures.length > 0 && failures.every((failure) => failure.outcome === "nonzero_exit" && failure.exitCode !== null
    && commands[failure.checkIndex]?.inconclusiveExitCodes?.includes(failure.exitCode) === true);
}

/**
 * An audit counts as green only when it ran every declared command to a pass: none skipped, none reused.
 * The event says so itself and is checked here, so an audit that records anything less is never green.
 */
function ranInFull(result: Extract<NonNullable<AuditRecord["result"]>, { type: "audited" }>): boolean {
  return Boolean(result.commit) && result.commands.length > 0 && result.passed.length === result.commands.length
    && result.skipped.length === 0 && result.reused.length === 0;
}

/** An audit's verdict, or null while it has none (queued, running, cancelled, interrupted). An inconclusive audit judged nothing. */
function verdictOf(operation: AuditRecord): Verdicted | null {
  const { result, finishedAt } = operation;
  if (!finishedAt) return null;
  if (result?.type === "audited") return { operation, verdict: ranInFull(result) ? "green" : "failed", finishedAt, commit: result.commit };
  if (result?.type === "failed") return { operation, verdict: result.inconclusive === true ? "inconclusive" : "failed", finishedAt, commit: operation.head ?? null };
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

/** A failing audit's night: its recorded category, else the category its recorded failure gives under the current rule. */
export function auditNight(operation: AuditRecord, finishedAt: string, commit: string | null): AuditNight {
  const fact = operation.classification;
  const reason = operation.result?.type === "failed" ? operation.result.reason : "";
  const category: FailureCategory = fact?.category ?? (fact
    ? failureCategory({ reason, fact, ...operation.verifyLoad ? { load: operation.verifyLoad } : {} })
    : { kind: "unresolved", evidence: "the audit recorded no classification" });
  const firstError = fact?.firstErrors?.[0]?.error ?? namedError(reason);
  return { audit: operation.id, finishedAt, commit, category, recorded: Boolean(fact?.category), failingTests: fact?.failingTests ?? [], ...firstError ? { firstError } : {} };
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
    audits: cluster.map(({ operation }) => operation.id), nights: cluster.map(({ operation, finishedAt, commit }) => auditNight(operation, finishedAt, commit)),
    since: cluster[0]!.finishedAt,
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
  // Inconclusive audits judge nothing: they neither join nor close a failure, and only a judging verdict (green or
  // failing) breaks a run of them. Cancelled, interrupted and killed audits are not verdicts and do neither.
  let inconclusiveRun: Verdicted[] = [];
  const close = () => { if (cluster.length) failures.push({ failure: failureOf(cluster, green, published), open: false }); cluster = []; };
  for (const verdict of verdicts) {
    if (verdict.verdict === "green") { close(); green = verdict; inconclusiveRun = []; }
    else if (verdict.verdict === "failed") { cluster.push(verdict); inconclusiveRun = []; }
    else inconclusiveRun.push(verdict);
  }
  if (cluster.length) { failures.push({ failure: failureOf(cluster, green, published), open: true }); cluster = []; }
  // A cause recorded on an audit of this run covers the run's audits up to when it was recorded, and no later ones; a
  // cause from an earlier run explained that run, as a failure's cause explains only that failure.
  const inconclusiveCauses = inconclusiveRun.flatMap(({ operation }) => operation.cause ? [operation.cause] : []);
  const uncovered = inconclusiveRun.filter((verdict) => !inconclusiveCauses.some((cause) => Date.parse(cause.at) >= Date.parse(verdict.finishedAt)));
  const recordedInconclusive = inconclusiveCauses.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1);
  const culprits = new Set(failures.flatMap(({ failure }) => failure.cause?.kind === "culprits" ? failure.cause.landings : [])
    .filter((commit) => published.get(commit)?.gate === "green"));
  const latest = verdicts.at(-1);
  // Never green: measured from the first audit, so a repository that has only just declared one is not late.
  const since = green ? Date.parse(green.finishedAt) : audits.length ? Math.min(...audits.map((operation) => Date.parse(operation.submittedAt))) : null;
  const open = failures.find((entry) => entry.open);
  return {
    lastGreen: green ? { commit: green.commit!, finishedAt: green.finishedAt, operationId: green.operation.id } : null,
    latest: latest ? { status: latest.verdict, commit: latest.commit, finishedAt: latest.finishedAt, operationId: latest.operation.id } : null,
    overdue: since !== null && now.getTime() - since > AUDIT_OVERDUE_AFTER_MS,
    openFailure: open?.failure ?? null,
    inconclusive: inconclusiveRun.length ? { audits: uncovered.map(({ operation }) => operation.id),
      cause: recordedInconclusive ? { ...recordedInconclusive.cause, by: recordedInconclusive.by, at: recordedInconclusive.at } : null } : null,
    escapes: culprits.size,
  };
}

/** Why a promotion is refused on account of the audits, or null when it is not. */
export function promotionRefusal(summary: AuditSummary): string | null {
  const failure = summary.openFailure;
  if (failure && !failure.cause) {
    const suspects = failure.suspects.length ? ` Suspects: ${failure.suspects.slice(-5).map((commit) => commit.slice(0, 12)).join(", ")}${failure.suspects.length > 5 ? ` and ${failure.suspects.length - 5} earlier` : ""}.` : "";
    return `The latest audit failed${failure.commit ? ` at ${failure.commit.slice(0, 12)}` : ""} and no cause is recorded.${suspects} `
      + `Record one with slipjay audit cause <landing...|--flake|--infrastructure|--unresolved> before promoting.`;
  }
  const run = summary.inconclusive?.audits ?? [];
  if (run.length < 2) return null;
  // What last judged the repository, stated as it stands: an open failure here already has its cause recorded, and a
  // green one is the newest judging verdict when there is no open failure.
  const judged = failure ? `The last audit to judge the repository failed${failure.commit ? ` at ${failure.commit.slice(0, 12)}` : ""} and its cause is recorded`
    : summary.lastGreen ? `The last audit to judge the repository was green at ${summary.lastGreen.commit.slice(0, 12)}`
    : "No audit has judged the repository yet";
  return `The latest ${run.length === 2 ? "two" : run.length} audits were inconclusive (${run.join(", ")}) and no cause is recorded for them. ${judged}; inconclusive audits do not judge it. `
    + `Record one with slipjay audit cause <landing...|--flake|--infrastructure|--unresolved> before promoting.`;
}

/**
 * The failing audit a cause attaches to: `requested`, which must have failed (an inconclusive audit counts, as it
 * recorded a failure it could not judge); or whichever refusal `promotionRefusal` names, the newest audit of an open
 * failure with no cause and then the newest uncovered inconclusive audit of a refusing run; or the open failure's newest
 * audit, to correct its cause. A cause covers its whole failure, or the inconclusive audits up to when it was recorded,
 * so which of its audits carries it is immaterial.
 */
export function auditToExplain<Audit extends AuditRecord>(audits: readonly Audit[], summary: AuditSummary, requested?: string): { ok: true; audit: Audit } | { ok: false; reason: string } {
  if (requested !== undefined) {
    const audit = audits.find((operation) => operation.id === requested);
    if (!audit) return { ok: false, reason: `${requested} is not an audit of this repository` };
    return audit.result?.type === "failed" || (audit.result?.type === "audited" && verdictOf(audit)?.verdict === "failed")
      ? { ok: true, audit } : { ok: false, reason: `${requested} did not fail, so it has no cause to record` };
  }
  const failure = summary.openFailure;
  const run = summary.inconclusive?.audits ?? [];
  const id = failure && !failure.cause ? failure.audits.at(-1) : run.length >= 2 ? run.at(-1) : failure?.audits.at(-1);
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
    else if (audit && event.type === "classified") audit.classification = event;
    else if (audit && event.type === "stage" && event.health && (event.stage === "verifying" || event.stage === "screening")) audit.verifyLoad = { load1: event.health.load1, cpus: event.health.cpus };
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
