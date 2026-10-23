import type { BuildBinding, SubmissionHandoff } from "../landing/submission-handoff.ts";
import { isLandingSubmission } from "../runner/runner-contract.ts";
import type { OperationLog, StoredEvent } from "../runner/runner-types.ts";
import { BUILD_ITEM_UNAVAILABLE, BuildRefusal, readBuildItem } from "./tracker.ts";
import type { BuildReadAction, BuildReader } from "./tracker.ts";

/** The runner's dedicated credential for Build's runner route, from its `bws run` environment. */
export const BUILD_TOKEN_ENV = "YARDSMITH_SLIPJAY_BUILD_TOKEN";
/** How long the serialised submission handler waits for Build before treating it as unavailable. */
export const BUILD_ADMISSION_TIMEOUT_MS = 10_000;

/** Build's `admitAttempt` input: the `submitted` fact at its real ledger sequence, fenced by the author's bind. */
export type BuildAdmissionRequest = {
  repository: string; operationId: string; sequence: number; occurredAt: string;
  specId: string; ticketIds: string[]; specBodyRevision: number | null; specBodyHash: string | null;
  candidateRevision: string; baseRevision: null; helperRevisions: string[]; repairsOperationId: string | null;
  bindGeneration: number; sessionId: string; supersedesOperationId: string | null;
};

/** The numbers of the Spec and Tickets an admission names, read from Build by their ids. */
export type BuildAdmittedItems = { specNumber: number; ticketNumbers: number[] };

/** `items` for `specId` and `ticketIds`; throws unless Build answers for every one. */
export async function readAdmittedItems(read: BuildReader, specId: string, ticketIds: readonly string[]): Promise<BuildAdmittedItems> {
  const number = async (itemId: string) => {
    const item = await readBuildItem(read, { itemId });
    if (!item || !Number.isSafeInteger(item.number)) throw new Error(`Build has no item ${itemId}, which the admission names`);
    return item.number;
  };
  return { specNumber: await number(specId), ticketNumbers: await Promise.all(ticketIds.map(number)) };
}

/**
 * `admitted` puts the operation in Build's custody, with the numbers of the items it names; `refused` is Build's final answer with its code;
 * `unavailable` means Build gave no answer, so it may or may not have admitted: resending replays.
 */
export type BuildAdmission =
  | { outcome: "admitted"; sequence: number; sessionId: string; recordedAt: string | null; items?: BuildAdmittedItems }
  | { outcome: "refused"; code: string }
  | { outcome: "unavailable"; reason: string };

export type BuildAdmitter = (request: BuildAdmissionRequest) => Promise<BuildAdmission>;

/**
 * What a Build-bound `submitted` record keeps so its admission can be resent from the ledger alone, byte for
 * byte, by the handler or a later reconciliation. `supersedes` is the admitted operation it replaces in Build's custody.
 */
export type BuildAdmissionRecord = {
  binding: BuildBinding; specBodyHash: string | null; helperRevisions: string[]; repairsOperationId: string | null; supersedes: string | null;
};

/** Built only from what the author supplied: nothing about Build is inferred. */
export const admissionRecord = (handoff: SubmissionHandoff & { build: BuildBinding }, repairsOperationId: string | null, supersedes: string | null): BuildAdmissionRecord => ({
  binding: handoff.build, specBodyHash: handoff.spec?.bodySha256 ?? null,
  helperRevisions: [...new Set(handoff.helpers.map((helper) => helper.revision))], repairsOperationId, supersedes,
});

/** The admission fact for one `submitted` record at its real ledger sequence. */
export function admissionRequest(input: { repo: string; operationId: string; sequence: number; occurredAt: string; commitId: string; record: BuildAdmissionRecord }): BuildAdmissionRequest {
  const { binding, ...record } = input.record;
  return {
    repository: input.repo, operationId: input.operationId, sequence: input.sequence, occurredAt: input.occurredAt,
    specId: binding.specId, ticketIds: binding.ticketIds, specBodyRevision: binding.bodyRevision,
    specBodyHash: record.specBodyHash, candidateRevision: input.commitId, baseRevision: null,
    helperRevisions: record.helperRevisions, repairsOperationId: record.repairsOperationId,
    bindGeneration: binding.bindGeneration, sessionId: binding.sessionId, supersedesOperationId: record.supersedes,
  };
}

/** Whether a Build-bound landing's admission has an answer: admitted, refused as its outcome, or refused once closed. */
export function admissionSettled(history: readonly StoredEvent[]): boolean {
  const submitted = history.find((row) => row.event.type === "submitted");
  return history.some((row) => row.event.type === "build_admitted" || row.event.type === "declined" && row.event.build !== undefined
    || row.event.type === "build_receipt" && row.event.sequence === submitted?.seq);
}

/**
 * Offers a Build-bound landing's admission at its `submitted` sequence and records Build's answer, whether the
 * submission handler or the receipt drain sends it: Build replays a resent admission, and the first answer
 * recorded stands. Once admitted it replaces the queued candidates of its change, which waited for this answer.
 * A refusal ends it as declined; if it closed while unanswered, the refusal settles its admission instead.
 */
export async function settleAdmission(log: OperationLog, admit: BuildAdmitter, operationId: string): Promise<{ resolved: true } | { resolved: false; reason: string }> {
  const submitted = log.events({ operationId }).find((row) => row.event.type === "submitted");
  if (!isLandingSubmission(submitted?.event) || !submitted.event.admission)
    throw new Error(`Operation ${operationId} has no Build admission to resolve`);
  const { repo, changeId, commitId, admission } = submitted.event;
  if (admissionSettled(log.events({ operationId }))) return { resolved: true };
  const answer = await admit(admissionRequest({ repo, operationId, sequence: submitted.seq, occurredAt: submitted.at, commitId, record: admission }));
  if (answer.outcome === "unavailable") return { resolved: false, reason: answer.reason };
  if (admissionSettled(log.events({ operationId }))) return { resolved: true };
  if (answer.outcome === "admitted") {
    log.append(operationId, { type: "build_admitted", sequence: answer.sequence, sessionId: answer.sessionId, recordedAt: answer.recordedAt, ...answer.items ? { items: answer.items } : {} });
    // Only candidates submitted before it: one admitted late after being cancelled never displaces a newer one.
    for (const earlier of log.operationsForChange(repo, changeId))
      if (earlier.status === "queued" && log.events({ operationId: earlier.id }).find((row) => row.event.type === "submitted")!.seq < submitted.seq)
        log.append(earlier.id, { type: "superseded", by: operationId });
  } else if (!log.operation(operationId)?.result) {
    const retryable = RETRYABLE_BUILD_REFUSALS.includes(answer.code);
    log.append(operationId, { type: "declined", paths: [], build: { code: answer.code, retryable },
      reason: `Build refused admission: ${answer.code}${retryable ? "; another delivery of this Spec is still in Build's custody: land again once it has finished" : ""}` });
  } else log.append(operationId, { type: "build_receipt", sequence: submitted.seq, state: "parked", code: answer.code });
  return { resolved: true };
}

/** Build's refusals the author can retry later unchanged: another delivery of the Spec is still in its custody. */
export const RETRYABLE_BUILD_REFUSALS: readonly string[] = ["delivery_pending"];

/**
 * One answer from Build's runner route. `accepted` is a recorded or replayed fact; `refused` is Build's domain
 * answer (409 conflict or block, 422 an input it will never accept) with its code; `unavailable` means no answer
 * that settles anything, so the same request is sent again later.
 */
export type BuildRouteAnswer =
  | { kind: "accepted"; value: unknown }
  | { kind: "refused"; code: string }
  | { kind: "unavailable"; reason: string };
export type BuildRoute = (action: "admitAttempt" | "recordAttempt" | "recordAttemptRun" | "recordChoreLanding" | BuildReadAction, input: unknown) => Promise<BuildRouteAnswer>;

/** Calls `POST {origin}/api/build/runner`; never throws, and never waits longer than `timeoutMs`. */
export function buildRoute(options: { origin: string; token: string; timeoutMs?: number; fetch?: (url: string, init: RequestInit) => Promise<Response> }): BuildRoute {
  const call = options.fetch ?? fetch;
  const url = new URL("/api/build/runner", options.origin).toString();
  return async (action, input) => {
    let response: Response;
    let body: { status?: unknown; code?: unknown; value?: unknown } | null;
    try {
      response = await call(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? BUILD_ADMISSION_TIMEOUT_MS),
        headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
        body: JSON.stringify({ action, input }) });
      body = await response.json().catch(() => null) as typeof body;
    } catch (error) {
      return { kind: "unavailable", reason: (error as Error).name === "TimeoutError" ? "Build did not answer in time" : "Build could not be reached" };
    }
    if (response.status === 200 && (body?.status === "succeeded" || body?.status === "duplicate")) return { kind: "accepted", value: body.value ?? null };
    // Build's domain answers, and its refusal of a request it will never accept (400 malformed, 413 too large).
    if ([400, 409, 413, 422].includes(response.status) && typeof body?.code === "string" && body.code.trim())
      return { kind: "refused", code: body.code.slice(0, 200) };
    // Build answers a read of an item that does not exist with its `unavailable` outcome, which its route sends as 503;
    // the body's code tells it from an outage, which never carries one.
    if (response.status === 503 && body?.status === "unavailable" && body.code === BUILD_ITEM_UNAVAILABLE) return { kind: "refused", code: BUILD_ITEM_UNAVAILABLE };
    if (response.status === 401 || response.status === 403) return { kind: "unavailable", reason: "Build refused the runner's credential" };
    return { kind: "unavailable", reason: `Build answered HTTP ${response.status}` };
  };
}

/** Build's read-only actions over its runner route, throwing unless Build answered. */
export function buildReader(route: BuildRoute): BuildReader {
  return async (action, input) => {
    const answer = await route(action, input);
    if (answer.kind === "accepted") return answer.value;
    if (answer.kind === "refused") throw new BuildRefusal(action, answer.code);
    throw new Error(`Build did not answer: ${answer.reason}`);
  };
}

/**
 * Admits through Build's runner route, then reads the numbers of the items admitted, so a landing's checks get them
 * without asking Build again. Unread, the admission is unresolved: Build replays it when it is sent again.
 */
export function buildAdmitter(route: BuildRoute): BuildAdmitter {
  return async (request) => {
    const answer = await route("admitAttempt", request);
    if (answer.kind === "unavailable") return { outcome: "unavailable", reason: answer.reason };
    if (answer.kind === "refused") return { outcome: "refused", code: answer.code };
    const recordedAt = (answer.value as { admission?: { recordedAt?: unknown } | null } | null)?.admission?.recordedAt;
    let items: BuildAdmittedItems;
    try { items = await readAdmittedItems(buildReader(route), request.specId, request.ticketIds); }
    catch (error) { return { outcome: "unavailable", reason: `the admitted items could not be read: ${(error as Error).message}` }; }
    return { outcome: "admitted", sequence: request.sequence, sessionId: request.sessionId, recordedAt: typeof recordedAt === "string" ? recordedAt : null, items };
  };
}
