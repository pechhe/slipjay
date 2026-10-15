import type { BuildAdmissionRecord, BuildRoute } from "./build-admission.ts";
import { RUNNER_CONTROL_ID } from "./runner-contract.ts";
import type { LandingOperation, OperationEvent, OperationLog, RunnerStage, StoredEvent } from "./runner-contract.ts";

/** Build's `failed` bundle (pechhe/slipjay#57), bounded: references to retained logs, never their content. */
type AttemptFailure = {
  stage: string; cause: string; command: string | null; excerpt: string | null;
  exit: { code: number | null; signal: string | null; timedOut: boolean; cancelled: boolean };
  checks: { passed: string[]; failed: string[]; skipped: string[]; incomplete: string[] };
  artifacts: string[]; truncated: boolean;
  recovery: "code_repair" | "infrastructure_retry" | "publication_unknown" | "cancelled";
};

/** Build's `recordAttempt` input for one runner event: every receipt repeats the admitted source tuple. */
export type BuildReceiptInput = {
  repository: string; operationId: string; sequence: number; occurredAt: string;
  specId: string; ticketIds: string[]; specBodyRevision: number | null; specBodyHash: string | null;
  candidateRevision: string; baseRevision: string | null; helperRevisions: string[]; repairsOperationId: string | null;
  event: "failed" | "published"; bindGeneration: number; verifiedRevision: string | null; publishedRevision: string | null; failure: AttemptFailure | null;
};

/** One receipt an admitted operation owes Build, named by its operation and the sequence of the fact it reports. */
export type BuildReceipt = { operationId: string; sequence: number; occurredAt: string; input: BuildReceiptInput };

/** Delivery as the runner snapshot reports it: receipts still owed, and whether Build is answering. */
export type BuildDeliveryState = {
  state: "available" | "unavailable"; since: string | null; reason: string | null;
  pending: number; oldestPendingAt: string | null; parked: number;
};

/** Build refuses a body over 256 KiB, and a refusal that size is permanent: keep every receipt well inside it. */
export const RECEIPT_MAX_BYTES = 200_000;
const bodyBytes = (input: BuildReceiptInput) => Buffer.byteLength(JSON.stringify({ action: "recordAttempt", input }));
const bounded = (values: string[], count: number, length: number) => [...new Set(values.map((value) => value.slice(0, length)))].slice(0, count);
/** Shrinks only the failure's free text and lists, reporting it as truncated, until the whole request fits. */
function fit(input: BuildReceiptInput): BuildReceiptInput {
  const failure = input.failure;
  if (!failure) return input;
  for (const [count, length, excerpt] of [[500, 500, 8000], [100, 200, 4000], [20, 100, 1000], [0, 0, 0]] as const) {
    const candidate = { ...input, failure: { ...failure, truncated: failure.truncated || count < 500 || excerpt < 8000,
      excerpt: failure.excerpt === null || excerpt === 0 ? null : failure.excerpt.slice(0, excerpt),
      checks: { passed: bounded(failure.checks.passed, count, length), failed: bounded(failure.checks.failed, count, length), skipped: [], incomplete: bounded(failure.checks.incomplete, count, length) } } };
    if (bodyBytes(candidate) <= RECEIPT_MAX_BYTES) return candidate;
  }
  return { ...input, failure: { ...failure, excerpt: null, truncated: true, command: null, cause: failure.cause.slice(0, 200), checks: { passed: [], failed: [], skipped: [], incomplete: [] }, artifacts: failure.artifacts.slice(0, 1) } };
}
const UNCERTAIN_STAGES: RunnerStage[] = ["integrating", "finalizing", "publishing"];

/**
 * The receipts an operation owes Build, from its own ledger. Only an admitted operation owes any: its
 * `submitted` fact was delivered by admission itself. This Ticket reports `failed` and `published`.
 */
export function owedReceipts(operation: LandingOperation, history: readonly StoredEvent[]): BuildReceipt[] {
  const events = history.filter((row) => row.operationId === operation.id);
  const submitted = events.find((row) => row.event.type === "submitted")?.event;
  if (submitted?.type !== "submitted" || submitted.kind !== undefined && submitted.kind !== "landing" || !submitted.admission) return [];
  if (!events.some((row) => row.event.type === "build_admitted")) return [];
  const record: BuildAdmissionRecord = submitted.admission;
  const base = (row: StoredEvent) => ({
    repository: operation.repo, operationId: operation.id, sequence: row.seq, occurredAt: row.at,
    specId: record.binding.specId, ticketIds: record.binding.ticketIds, specBodyRevision: record.binding.bodyRevision, specBodyHash: record.specBodyHash,
    candidateRevision: operation.commitId, helperRevisions: record.helperRevisions, repairsOperationId: record.repairsOperationId,
    bindGeneration: record.binding.bindGeneration,
  });
  const receipts: BuildReceipt[] = [];
  for (const row of events) {
    const event = row.event;
    if (event.type === "landed") {
      const verified = events.findLast((entry) => entry.seq < row.seq && entry.event.type === "verification_passed")?.event;
      receipts.push({ operationId: operation.id, sequence: row.seq, occurredAt: row.at, input: { ...base(row), event: "published", baseRevision: event.base,
        verifiedRevision: verified?.type === "verification_passed" ? verified.candidate : null, publishedRevision: event.commitId, failure: null } });
    } else if (event.type === "failed") {
      receipts.push({ operationId: operation.id, sequence: row.seq, occurredAt: row.at, input: fit({ ...base(row), event: "failed",
        baseRevision: verificationBase(events, row.seq), verifiedRevision: null, publishedRevision: null, failure: failureOf(operation, events, row, event) }) });
    }
  }
  return receipts;
}

function verificationBase(events: readonly StoredEvent[], before: number): string | null {
  const row = events.findLast((entry) => entry.seq < before && (entry.event.type === "verification_base" || entry.event.type === "attempt_prepared"));
  return row?.event.type === "verification_base" || row?.event.type === "attempt_prepared" ? row.event.base : null;
}

function failureOf(operation: LandingOperation, events: readonly StoredEvent[], row: StoredEvent, event: Extract<OperationEvent, { type: "failed" }>): AttemptFailure {
  const run = operation.runs.findLast((entry) => event.command !== undefined && entry.command === event.command) ?? operation.runs.at(-1);
  const outcome = (entry: LandingOperation["runs"][number]) => !entry.finishedAt || entry.killed ? "incomplete"
    : entry.exitCode === 0 && !entry.signal && !entry.timedOut ? "passed" : "failed";
  const classification = events.findLast((entry) => entry.seq <= row.seq && entry.event.type === "classified")?.event;
  const cause = classification?.type === "classified" ? classification.cause : undefined;
  // Publication may have happened when the failure came at or after integration: Build keeps custody until it is known.
  const uncertain = UNCERTAIN_STAGES.includes(event.stage) || events.some((entry) => entry.seq < row.seq && (entry.event.type === "integrated" || entry.event.type === "integration_held"));
  const recovery: AttemptFailure["recovery"] = uncertain ? "publication_unknown" : cause === "killed" ? "cancelled"
    : cause === "infrastructure" || cause === "paused_out" ? "infrastructure_retry" : "code_repair";
  const output = event.output ?? null;
  return {
    stage: event.stage, cause: event.reason.slice(0, 2000), command: event.command?.slice(0, 2000) ?? null, excerpt: output?.slice(0, 8000) ?? null,
    exit: { code: run?.exitCode ?? null, signal: run?.signal ?? null, timedOut: run?.timedOut ?? false, cancelled: run?.killed ?? false },
    checks: { passed: bounded(operation.runs.filter((entry) => outcome(entry) === "passed").map((entry) => entry.command), 500, 500),
      failed: bounded(operation.runs.filter((entry) => outcome(entry) === "failed").map((entry) => entry.command), 500, 500), skipped: [],
      incomplete: bounded(operation.runs.filter((entry) => outcome(entry) === "incomplete").map((entry) => entry.command), 500, 500) },
    artifacts: [`slipjay runner log ${operation.id}`, ...operation.runs.filter((entry) => entry.artifact?.status === "retained")
      .map((entry) => `slipjay runner artifact ${operation.id} ${entry.runId}`)].slice(0, 100),
    truncated: (output?.length ?? 0) > 8000, recovery,
  };
}

/** Whether a receipt has been settled: delivered, or parked because Build will never accept it. */
export const receiptSettlement = (history: readonly StoredEvent[], receipt: Pick<BuildReceipt, "operationId" | "sequence">) =>
  history.findLast((row) => row.operationId === receipt.operationId && row.event.type === "build_receipt" && row.event.sequence === receipt.sequence)?.event as
    Extract<OperationEvent, { type: "build_receipt" }> | undefined;

/** Receipt delivery as recorded in the ledger, for the snapshot and each landing's outcome. */
export function deliveryState(log: OperationLog): BuildDeliveryState | null {
  const bound = log.buildBound();
  const control = log.events({ operationId: RUNNER_CONTROL_ID }).findLast((row) => row.event.type === "build_delivery");
  if (!bound.length && !control) return null;
  let pending = 0, parked = 0, oldest: string | null = null;
  for (const { operation, history } of bound) for (const receipt of owedReceipts(operation, history)) {
    const settled = receiptSettlement(history, receipt);
    if (settled?.state === "parked") parked++;
    else if (!settled) { pending++; if (oldest === null || receipt.occurredAt < oldest) oldest = receipt.occurredAt; }
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
    const owed = log.buildBound().flatMap(({ operation, history }) => owedReceipts(operation, history).filter((receipt) => !receiptSettlement(history, receipt)))
      .sort((a, b) => a.sequence - b.sequence);
    for (const receipt of owed) {
      if (closed) return;
      const answer = await route("recordAttempt", receipt.input);
      if (answer.kind === "unavailable") {
        mark("unavailable", answer.reason);
        schedule(backoff);
        backoff = Math.min(backoff * 2, ceiling);
        return;
      }
      log.append(receipt.operationId, answer.kind === "accepted" ? { type: "build_receipt", sequence: receipt.sequence, state: "delivered" }
        : { type: "build_receipt", sequence: receipt.sequence, state: "parked", code: answer.code });
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
  const unsubscribe = log.subscribe((row) => { if (["build_admitted", "landed", "failed"].includes(row.event.type)) wake(); });
  return {
    wake,
    async idle() { while (running) await running; },
    close() { closed = true; unsubscribe(); if (timer) clearTimeout(timer); },
  };
}
