import type { BuildBinding, SubmissionHandoff } from "./submission-handoff.ts";

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

/**
 * `admitted` puts the operation in Build's custody; `refused` is Build's final answer with its code;
 * `unavailable` means Build gave no answer, so it may or may not have admitted: resending replays.
 */
export type BuildAdmission =
  | { outcome: "admitted"; sequence: number; sessionId: string; recordedAt: string | null }
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

/** Build's refusals the author can retry later unchanged: another delivery of the Spec is still in its custody. */
export const RETRYABLE_BUILD_REFUSALS: readonly string[] = ["delivery_pending"];

/** Calls `POST {origin}/api/build/runner`; never throws, and never waits longer than `timeoutMs`. */
export function buildAdmitter(options: { origin: string; token: string; timeoutMs?: number; fetch?: typeof fetch }): BuildAdmitter {
  const call = options.fetch ?? fetch;
  const url = new URL("/api/build/runner", options.origin).toString();
  return async (request) => {
    let response: Response;
    let body: { status?: unknown; code?: unknown; value?: { admission?: { sequence?: unknown; sessionId?: unknown; recordedAt?: unknown } | null } } | null;
    try {
      response = await call(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? BUILD_ADMISSION_TIMEOUT_MS),
        headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
        body: JSON.stringify({ action: "admitAttempt", input: request }) });
      body = await response.json().catch(() => null) as typeof body;
    } catch (error) {
      return { outcome: "unavailable", reason: (error as Error).name === "TimeoutError" ? "Build did not answer in time" : "Build could not be reached" };
    }
    if (response.status === 200 && (body?.status === "succeeded" || body?.status === "duplicate")) {
      const admission = body.value?.admission;
      return { outcome: "admitted", sequence: request.sequence, sessionId: request.sessionId,
        recordedAt: typeof admission?.recordedAt === "string" ? admission.recordedAt : null };
    }
    // Build's domain answers: a conflict or block (409) or an input it will never accept (422).
    if ((response.status === 409 || response.status === 422) && typeof body?.code === "string" && body.code.trim())
      return { outcome: "refused", code: body.code.slice(0, 200) };
    if (response.status === 401 || response.status === 403) return { outcome: "unavailable", reason: "Build refused the runner's credential" };
    return { outcome: "unavailable", reason: `Build answered HTTP ${response.status}` };
  };
}
