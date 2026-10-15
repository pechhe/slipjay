import type { BuildAdmissionRecord, BuildRoute } from "./build-admission.ts";
import { recoveryKey, RUNNER_CONTROL_ID, TERMINAL_EVENT_TYPES } from "./runner-contract.ts";
import type { LandingOperation, OperationEvent, OperationLog, RunnerStage, StoredEvent } from "./runner-contract.ts";

/** Build's `failed` bundle (pechhe/slipjay#57), bounded: references to retained logs, never their content. */
type AttemptFailure = {
  stage: string; cause: string; command: string | null; excerpt: string | null;
  exit: { code: number | null; signal: string | null; timedOut: boolean; cancelled: boolean };
  checks: { passed: string[]; failed: string[]; skipped: string[]; incomplete: string[] };
  artifacts: string[]; truncated: boolean;
  recovery: "code_repair" | "infrastructure_retry" | "publication_unknown" | "cancelled" | "superseded" | "policy_refusal";
};

/** Build's `recordAttempt` input for one runner event: every receipt repeats the admitted source tuple. */
export type BuildReceiptInput = {
  repository: string; operationId: string; sequence: number; occurredAt: string;
  specId: string; ticketIds: string[]; specBodyRevision: number | null; specBodyHash: string | null;
  candidateRevision: string; baseRevision: string | null; helperRevisions: string[]; repairsOperationId: string | null;
  event: "held" | "failed" | "published"; bindGeneration: number; verifiedRevision: string | null; publishedRevision: string | null; failure: AttemptFailure | null;
};
type RunOutcome = "passed" | "failed" | "incomplete" | "cancelled";
/** Build's `recordAttemptRun` input: one command, attached to the attempt fact at `sequence`, whose source Build reads. */
export type BuildRunInput = {
  repository: string; operationId: string; sequence: number; clientRef: string; startedAt: string; endedAt: string | null;
  outcome: RunOutcome; command: string | null; checks: { name: string; outcome: RunOutcome }[]; knownGaps: string[]; usageIds: string[];
};
/** Build's `recordChoreLanding` input: published work its author declared as belonging to no Spec. */
export type BuildChoreInput = {
  unassociated: true; repository: string; operationId: string; sequence: number; occurredAt: string; candidateRevision: string;
  baseRevision: string | null; verifiedRevision: string | null; helperRevisions: string[]; publishedRevision: string; title: string;
};

/**
 * One receipt an operation owes Build. `key` is the ledger sequence of the runner fact it reports, which names its
 * delivery; a run waits for the attempt fact it attaches to (`after`), since Build reads its source from that fact.
 */
export type BuildReceipt = { operationId: string; key: number; occurredAt: string; after?: number } & (
  | { action: "recordAttempt"; input: BuildReceiptInput }
  | { action: "recordAttemptRun"; input: BuildRunInput }
  | { action: "recordChoreLanding"; input: BuildChoreInput });

/** Delivery as the runner snapshot reports it: receipts still owed, and whether Build is answering. */
export type BuildDeliveryState = {
  state: "available" | "unavailable"; since: string | null; reason: string | null;
  pending: number; oldestPendingAt: string | null; parked: number;
};

/** Build refuses a body over 256 KiB, and a refusal that size is permanent: keep every receipt well inside it. */
export const RECEIPT_MAX_BYTES = 200_000;
const bodyBytes = (action: string, input: unknown) => Buffer.byteLength(JSON.stringify({ action, input }));
const bounded = (values: string[], count: number, length: number) => [...new Set(values.map((value) => value.slice(0, length)))].slice(0, count);
/** Shrinks only the failure's free text and lists, reporting it as truncated, until the whole request fits. */
function fit(input: BuildReceiptInput): BuildReceiptInput {
  const failure = input.failure;
  if (!failure) return input;
  for (const [count, length, excerpt] of [[500, 500, 8000], [100, 200, 4000], [20, 100, 1000], [0, 0, 0]] as const) {
    const candidate = { ...input, failure: { ...failure, truncated: failure.truncated || count < 500 || excerpt < 8000,
      excerpt: failure.excerpt === null || excerpt === 0 ? null : failure.excerpt.slice(0, excerpt),
      checks: { passed: bounded(failure.checks.passed, count, length), failed: bounded(failure.checks.failed, count, length), skipped: [], incomplete: bounded(failure.checks.incomplete, count, length) } } };
    if (bodyBytes("recordAttempt", candidate) <= RECEIPT_MAX_BYTES) return candidate;
  }
  return { ...input, failure: { ...failure, excerpt: null, truncated: true, command: null, cause: failure.cause.slice(0, 200), checks: { passed: [], failed: [], skipped: [], incomplete: [] }, artifacts: failure.artifacts.slice(0, 1) } };
}
const UNCERTAIN_STAGES: RunnerStage[] = ["integrating", "finalizing", "publishing"];
type Run = LandingOperation["runs"][number];
const runOutcome = (run: Run): RunOutcome => run.killed ? "cancelled" : !run.finishedAt || run.exitCode == null && !run.signal && !run.timedOut ? "incomplete"
  : run.exitCode === 0 && !run.signal && !run.timedOut ? "passed" : "failed";

/** Where each repository's integration was later confirmed published: on its own record, another operation's, or the runner's. */
export type PublicationRecoveries = ReadonlyMap<string, readonly StoredEvent[]>;

/** The integration a failed operation left unknown, once a later event in its repository confirms it published. */
function confirmedLate(operation: LandingOperation, events: readonly StoredEvent[], terminal: StoredEvent, recoveries: PublicationRecoveries) {
  const integrated = events.findLast((row) => row.event.type === "integrated")?.event;
  if (integrated?.type !== "integrated") return undefined;
  const confirmed = recoveries.get(recoveryKey(operation.repo, integrated.commitId))?.find((row) => row.seq > terminal.seq);
  return confirmed && { confirmed, base: integrated.base, commitId: integrated.commitId };
}

/**
 * The receipts an operation owes Build, from the ledger. An admitted operation reports `held` once its integration is
 * held, its terminal fact (`published`, or `failed` with how it recovers), a `published` confirmed after an unknown or
 * held publication, and each command it ran; its `submitted` fact was delivered by admission itself. A declared chore
 * reports its publication only, whether it landed or was confirmed published later. Nothing else owes anything.
 */
export function owedReceipts(operation: LandingOperation, history: readonly StoredEvent[], recoveries: PublicationRecoveries = new Map()): BuildReceipt[] {
  const events = history.filter((row) => row.operationId === operation.id);
  const submitted = events.find((row) => row.event.type === "submitted")?.event;
  if (submitted?.type !== "submitted" || submitted.kind !== undefined && submitted.kind !== "landing") return [];
  const terminal = events.find((row) => ["landed", "failed", "cancelled", "superseded", "declined"].includes(row.event.type));
  if (submitted.chore) {
    if (!terminal) return [];
    const late = terminal.event.type === "landed" ? undefined : confirmedLate(operation, events, terminal, recoveries);
    const publication = terminal.event.type === "landed" ? { row: terminal, base: terminal.event.base, commitId: terminal.event.commitId }
      : late && { row: late.confirmed, base: late.base, commitId: late.commitId };
    if (!publication) return [];
    const { row, base, commitId } = publication;
    return [{ operationId: operation.id, key: row.seq, occurredAt: row.at, action: "recordChoreLanding", input: { unassociated: true, repository: operation.repo,
      operationId: operation.id, sequence: row.seq, occurredAt: row.at, candidateRevision: operation.commitId, baseRevision: base,
      verifiedRevision: verifiedBefore(events, terminal.seq), helperRevisions: submitted.chore.helperRevisions, publishedRevision: commitId,
      title: submitted.chore.title.slice(0, 2000) } }];
  }
  if (!submitted.admission || !events.some((row) => row.event.type === "build_admitted")) return [];
  const record: BuildAdmissionRecord = submitted.admission;
  const attempt = (row: StoredEvent, fields: Pick<BuildReceiptInput, "event" | "baseRevision" | "verifiedRevision" | "publishedRevision" | "failure">): BuildReceipt => ({
    operationId: operation.id, key: row.seq, occurredAt: row.at, action: "recordAttempt", input: fit({
      repository: operation.repo, operationId: operation.id, sequence: row.seq, occurredAt: row.at,
      specId: record.binding.specId, ticketIds: record.binding.ticketIds, specBodyRevision: record.binding.bodyRevision, specBodyHash: record.specBodyHash,
      candidateRevision: operation.commitId, helperRevisions: record.helperRevisions, repairsOperationId: record.repairsOperationId,
      bindGeneration: record.binding.bindGeneration, ...fields }) });
  const receipts: BuildReceipt[] = [];
  const held = events.find((row) => row.event.type === "integration_held");
  if (held?.event.type === "integration_held")
    receipts.push(attempt(held, { event: "held", baseRevision: integratedBase(events, held.event.commitId), verifiedRevision: verifiedBefore(events, held.seq), publishedRevision: null, failure: null }));
  if (terminal?.event.type === "landed")
    receipts.push(attempt(terminal, { event: "published", baseRevision: terminal.event.base, verifiedRevision: verifiedBefore(events, terminal.seq), publishedRevision: terminal.event.commitId, failure: null }));
  else if (terminal) {
    receipts.push(attempt(terminal, { event: "failed", baseRevision: verification(events, terminal.seq)?.base ?? null,
      verifiedRevision: verification(events, terminal.seq)?.candidate ?? null, publishedRevision: null, failure: failureOf(operation, events, terminal) }));
    // An integration whose publication was unknown when this failed is reported published once it is confirmed.
    const late = confirmedLate(operation, events, terminal, recoveries);
    if (late) receipts.push(attempt(late.confirmed, { event: "published", baseRevision: late.base, verifiedRevision: verifiedBefore(events, terminal.seq), publishedRevision: late.commitId, failure: null }));
  }
  // Runs attach to the terminal fact, so Build reads their source from it; runs of an invalidated attempt say so.
  const invalidated = new Set(events.flatMap((row) => row.event.type === "attempt_invalidated" ? [row.event.attempt] : []));
  if (terminal) for (const run of operation.runs) {
    const started = events.find((row) => row.event.type === "run_started" && row.event.runId === run.runId)!;
    const outcome = runOutcome(run);
    const sourced = terminal.event.type === "landed" ? verifiedBefore(events, terminal.seq) !== null : verification(events, terminal.seq)?.candidate !== undefined;
    const gaps = [...outcome === "incomplete" ? ["The runner recorded no completion for this command"] : [],
      ...!sourced ? ["The runner recorded no verified candidate for this attempt"] : [],
      ...run.attempt !== undefined && invalidated.has(run.attempt) ? ["This command's attempt was invalidated by its predecessor; it does not describe the published candidate"] : []];
    // A pass without a known verified candidate is reported as incomplete: Build cannot accept it as evidence.
    const reported: RunOutcome = outcome === "passed" && (!sourced || gaps.length) ? "incomplete" : outcome;
    receipts.push({ operationId: operation.id, key: started.seq, occurredAt: started.at, after: terminal.seq, action: "recordAttemptRun", input: {
      repository: operation.repo, operationId: operation.id, sequence: terminal.seq, clientRef: run.runId.slice(0, 200), startedAt: run.startedAt,
      endedAt: run.finishedAt ?? null, outcome: reported, command: run.command.slice(0, 2000),
      checks: (run.failingTests ?? []).slice(0, 200).map((name) => ({ name: name.slice(0, 1000), outcome: "failed" as const })),
      knownGaps: reported === "incomplete" && !gaps.length ? ["The command passed but its attempt's verified candidate is unknown"] : gaps, usageIds: [] } });
  }
  return receipts;
}

const verifiedBefore = (events: readonly StoredEvent[], before: number): string | null => {
  const row = events.findLast((entry) => entry.seq < before && entry.event.type === "verification_passed")?.event;
  return row?.type === "verification_passed" ? row.candidate : null;
};
/** The base and candidate the last verification before `before` ran on; a depth-two prepared attempt names both. */
function verification(events: readonly StoredEvent[], before: number): { base: string; candidate?: string } | undefined {
  const row = events.findLast((entry) => entry.seq < before && (entry.event.type === "verification_base" || entry.event.type === "attempt_prepared"))?.event;
  return row?.type === "verification_base" ? { base: row.base, ...row.candidate ? { candidate: row.candidate } : {} }
    : row?.type === "attempt_prepared" ? { base: row.base, candidate: row.candidate } : undefined;
}
const integratedBase = (events: readonly StoredEvent[], commitId: string): string | null => {
  const row = events.findLast((entry) => entry.event.type === "integrated" && entry.event.commitId === commitId)?.event;
  return row?.type === "integrated" ? row.base : null;
};

function failureOf(operation: LandingOperation, events: readonly StoredEvent[], row: StoredEvent): AttemptFailure {
  const event = row.event as Extract<OperationEvent, { type: "failed" | "cancelled" | "superseded" | "declined" }>;
  const failed = event.type === "failed" ? event : undefined;
  const run = operation.runs.findLast((entry) => failed?.command !== undefined && entry.command === failed.command) ?? operation.runs.at(-1);
  const classification = events.findLast((entry) => entry.seq <= row.seq && entry.event.type === "classified")?.event;
  const cause = classification?.type === "classified" ? classification.cause : undefined;
  // Publication may have happened when the failure came at or after integration: Build keeps custody until it is known.
  const uncertain = failed !== undefined && (UNCERTAIN_STAGES.includes(failed.stage) || events.some((entry) => entry.seq < row.seq && (entry.event.type === "integrated" || entry.event.type === "integration_held")));
  const recovery: AttemptFailure["recovery"] = uncertain ? "publication_unknown" : event.type === "superseded" ? "superseded"
    : event.type === "declined" ? "policy_refusal" : event.type === "cancelled" || cause === "killed" ? "cancelled"
      : cause === "infrastructure" || cause === "paused_out" ? "infrastructure_retry" : "code_repair";
  const output = failed?.output ?? null;
  const named = (outcome: RunOutcome) => bounded(operation.runs.filter((entry) => runOutcome(entry) === outcome).map((entry) => entry.command), 500, 500);
  return {
    stage: failed?.stage ?? operation.stage, cause: (event.type === "superseded" ? `Superseded by ${event.by}` : event.reason).slice(0, 2000),
    command: failed?.command?.slice(0, 2000) ?? null, excerpt: output?.slice(0, 8000) ?? null,
    exit: { code: run?.exitCode ?? null, signal: run?.signal ?? null, timedOut: run?.timedOut ?? false, cancelled: run?.killed ?? false },
    checks: { passed: named("passed"), failed: named("failed"), skipped: [], incomplete: [...named("incomplete"), ...named("cancelled")] },
    artifacts: [`slipjay runner log ${operation.id}`, ...operation.runs.filter((entry) => entry.artifact?.status === "retained")
      .map((entry) => `slipjay runner artifact ${operation.id} ${entry.runId}`)].slice(0, 100),
    truncated: (output?.length ?? 0) > 8000, recovery,
  };
}

/** Whether a receipt has been settled: delivered, or parked because Build will never accept it. */
export const receiptSettlement = (history: readonly StoredEvent[], receipt: Pick<BuildReceipt, "operationId" | "key">) =>
  history.findLast((row) => row.operationId === receipt.operationId && row.event.type === "build_receipt" && row.event.sequence === receipt.key)?.event as
    Extract<OperationEvent, { type: "build_receipt" }> | undefined;
/** Receipts still to send, in ledger order: unsettled, and not waiting for the fact they attach to. */
export function sendable(operation: LandingOperation, history: readonly StoredEvent[], recoveries: PublicationRecoveries): BuildReceipt[] {
  return owedReceipts(operation, history, recoveries).filter((receipt) => !receiptSettlement(history, receipt)
    && (receipt.after === undefined || receiptSettlement(history, { operationId: receipt.operationId, key: receipt.after })?.state === "delivered"));
}

/** Receipt delivery as recorded in the ledger, for the snapshot and each landing's outcome. */
export function deliveryState(log: OperationLog): BuildDeliveryState | null {
  const bound = log.buildBound();
  const control = log.events({ operationId: RUNNER_CONTROL_ID }).findLast((row) => row.event.type === "build_delivery");
  if (!bound.length && !control) return null;
  const recoveries = log.publicationRecoveries();
  let pending = 0, parked = 0, oldest: string | null = null;
  for (const { operation, history } of bound) for (const receipt of owedReceipts(operation, history, recoveries)) {
    const settled = receiptSettlement(history, receipt);
    // A run attached to a parked fact can never be sent; the parked fact already says why.
    const orphaned = receipt.after !== undefined && receiptSettlement(history, { operationId: receipt.operationId, key: receipt.after })?.state === "parked";
    if (settled?.state === "parked") parked++;
    else if (!settled && !orphaned) { pending++; if (oldest === null || receipt.occurredAt < oldest) oldest = receipt.occurredAt; }
  }
  const latest = control?.event.type === "build_delivery" ? control : undefined;
  return { state: latest?.event.type === "build_delivery" ? latest.event.state : "available", since: latest?.at ?? null,
    reason: latest?.event.type === "build_delivery" ? latest.event.reason ?? null : null, pending, oldestPendingAt: oldest, parked };
}

/**
 * Delivers owed receipts in ledger order, independently of landing and publication. A receipt Build refuses is
 * parked with its code and never blocks another; when Build gives no answer the drain backs off and resends the
 * same receipts, which Build replays, so a restart or a lost response delays delivery but never loses it.
 */
export function createReceiptDrain(input: { log: OperationLog; route: BuildRoute; initialBackoffMs?: number; maxBackoffMs?: number }) {
  const { log, route } = input;
  const initial = input.initialBackoffMs ?? 1_000, ceiling = input.maxBackoffMs ?? 300_000;
  let backoff = initial, timer: ReturnType<typeof setTimeout> | undefined, running: Promise<void> | undefined, again = false, closed = false;
  const latestDelivery = () => log.events({ operationId: RUNNER_CONTROL_ID }).findLast((row) => row.event.type === "build_delivery")?.event;
  // Recorded only on a change, so the ledger and the watch stream show when Build stopped and started answering.
  const mark = (state: "available" | "unavailable", reason?: string) => {
    const latest = latestDelivery();
    const current = latest?.type === "build_delivery" ? latest.state : "available";
    if (current !== state) log.append(RUNNER_CONTROL_ID, { type: "build_delivery", state, ...reason ? { reason } : {} });
  };
  async function pass(): Promise<void> {
    // A delivered attempt fact makes its runs sendable, so pass again until nothing more is.
    for (let delivered = true; delivered && !closed;) {
      delivered = false;
      const recoveries = log.publicationRecoveries();
      const owed = log.buildBound().flatMap(({ operation, history }) => sendable(operation, history, recoveries)).sort((a, b) => a.key - b.key);
      for (const receipt of owed) {
        if (closed) return;
        const answer = await route(receipt.action, receipt.input);
        if (answer.kind === "unavailable") {
          mark("unavailable", answer.reason);
          schedule(backoff);
          backoff = Math.min(backoff * 2, ceiling);
          return;
        }
        log.append(receipt.operationId, answer.kind === "accepted" ? { type: "build_receipt", sequence: receipt.key, state: "delivered" }
          : { type: "build_receipt", sequence: receipt.key, state: "parked", code: answer.code });
        delivered ||= answer.kind === "accepted";
      }
    }
    backoff = initial;
    mark("available");
  }
  function schedule(delayMs: number) {
    if (closed || timer) return;
    timer = setTimeout(() => { timer = undefined; wake(); }, delayMs);
    timer.unref?.();
  }
  /** Runs a pass now, or once the current one ends; while waiting out a backoff, the timer's pass comes first. */
  function wake(): void {
    if (closed) return;
    if (running) { again = true; return; }
    if (timer) return;
    running = pass().catch(() => schedule(backoff)).finally(() => { running = undefined; if (again) { again = false; wake(); } });
  }
  const unsubscribe = log.subscribe((row) => { if (["build_admitted", "integration_held", "integration_recovered", ...TERMINAL_EVENT_TYPES].includes(row.event.type)) wake(); });
  return {
    wake,
    async idle() { while (running) await running; },
    close() { closed = true; unsubscribe(); if (timer) clearTimeout(timer); },
  };
}
