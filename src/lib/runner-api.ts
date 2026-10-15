import { validSubmissionHandoff, handoffDigest } from "./submission-handoff.ts";
import { timingSafeEqual } from "node:crypto";
import { candidateBookmark, repositoryKey, RUNNER_API, RUNNER_CONTROL_ID, TERMINAL_EVENT_TYPES } from "./runner-contract.ts";
import type { ArtifactChunk, CommandArtifact, ClientFact, DeployRequest, KillOutcome, Operation, OperationLog, ReleaseRequest, ResetRequest, RunnerControlRequest, RunnerHandler, StoredEvent, SubmitRequest } from "./runner-contract.ts";
import { newOperationId } from "./runner-log.ts";

export function createRunnerHandler(input: {
  log: OperationLog;
  token: string;
  runnerName: string;
  readLog(operationId: string): Promise<string | null>;
  readManifest?(operation: Extract<Operation, { kind: "landing" }>): Promise<unknown>;
  readArtifact?(operationId: string, runId: string, reference: Extract<CommandArtifact, { status: "retained" }>, offset: number, limit: number): Promise<ArtifactChunk>;
  /** Wakes the queue: after a submission, and when the owner resumes it. */
  onSubmitted(): void;
  /** Pin source and a manifest before acknowledgement; never runs in a mutable runner checkout. */
  retainSubmission?(operationId: string, request: SubmitRequest): Promise<Extract<import("./runner-contract.ts").OperationEvent, { type: "source_retained" }>>;
  kill(operationId?: string): KillOutcome;
  /** A queued operation was cancelled: its candidate bookmark is the queue's to delete. */
  onCancelled?(operation: Operation): void;
  subscribe(listener: (event: StoredEvent) => void): () => void;
}): RunnerHandler {
  let landingAdmission = Promise.resolve();
  const credential = Buffer.from(`Bearer ${input.token}`);
  return async (request) => {
    const authorization = Buffer.from(request.headers.get("authorization") ?? "");
    if (authorization.length !== credential.length || !timingSafeEqual(authorization, credential))
      return json({ error: "Unauthorized" }, 401);
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "POST" && path === `${RUNNER_API}/client-operations`) {
      const body = await boundedJson(request);
      if (!body || !boundedString(body.repo) || !/^[\w.-]+\/[\w.-]+$/.test(body.repo) || !boundedString(body.workspace) || !boundedString(body.machine)) return json({ error: "Invalid client operation" }, 400);
      const id = newOperationId();
      input.log.append(id, { type: "client_operation", repo: repositoryKey(body.repo), workspace: body.workspace, machine: body.machine });
      return json({ id });
    }
    const clientRoute = path.match(new RegExp(`^${RUNNER_API}/operations/([^/]+)/events$`));
    if (request.method === "POST" && clientRoute) {
      const id = decodeURIComponent(clientRoute[1]!);
      if (!input.log.operation(id) && !input.log.events({ operationId: id }).some((row) => row.event.type === "client_operation")) return json({ error: "Unknown operation" }, 404);
      const body = await boundedJson(request);
      if (!body || !boundedString(body.id) || !validClientFact(body.fact)) return json({ error: "Invalid client event" }, 400);
      return json({ event: input.log.append(id, { type: "client", id: body.id, fact: body.fact }) });
    }
    if (request.method === "GET" && path === `${RUNNER_API}/health`)
      return json({ ok: true, runner: input.runnerName, queued: input.log.openOperations().filter((op) => op.status === "queued").length, paused: input.log.paused() !== null, held: input.log.snapshot(input.runnerName).held });
    if (request.method === "GET" && path === `${RUNNER_API}/queue`) return json(input.log.snapshot(input.runnerName));
    if (request.method === "GET" && path === `${RUNNER_API}/metrics/events`) {
      const raw = url.searchParams.get("since") ?? "0";
      const bound = url.searchParams.get("limit") ?? "1000";
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || !/^\d+$/.test(bound) || Number(bound) < 1 || Number(bound) > 1000)
        return json({ error: "Invalid cursor or limit" }, 400);
      const since = Number(raw);
      if (since > input.log.latestSeq()) return json({ error: "Cursor is ahead of runner log" }, 409);
      if (request.headers.get("accept")?.includes("text/event-stream")) return globalEventStream(input.log, since, request.signal);
      const events = input.log.events({ afterSeq: since, limit: Number(bound) + 1 });
      const hasMore = events.length > Number(bound);
      if (hasMore) events.pop();
      return json({ events, nextSeq: events.at(-1)?.seq ?? since, hasMore });
    }
    const control = path.match(new RegExp(`^${RUNNER_API}/runner/(kill|pause|resume)$`));
    if (request.method === "POST" && control) {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      if (!validControl(body))
        return json({ error: "Invalid control request" }, 400);
      if (control[1] === "kill") {
        const outcome = input.kill(body.operation);
        if (outcome.status === "refused")
          return json({ operation: outcome.operation, reason: `${outcome.operation.stage} is past verification and cannot be killed; it finishes on its own` }, 409);
        if (outcome.status === "not_running")
          return json({ operation: outcome.operation, reason: outcome.operation ? `is not running (${outcome.operation.status}); nothing was killed` : "is not a known operation; nothing was killed" }, 409);
        if (outcome.status === "ambiguous")
          return json({ operations: outcome.operations, reason: `${outcome.operations.length} operations are running; kill names one: ${outcome.operations.map((operation) => operation.id).join(", ")}` }, 409);
        return json({ operation: outcome.status === "killed" ? outcome.operation : null });
      }
      const pausing = control[1] === "pause";
      if (pausing !== (input.log.paused() !== null))
        input.log.append(RUNNER_CONTROL_ID, pausing ? { type: "paused", by: body.by } : { type: "resumed", by: body.by });
      if (!pausing)
        input.onSubmitted();
      return json({ paused: pausing });
    }
    if (request.method === "POST" && path === `${RUNNER_API}/operations`) {
      let body: unknown;
      try {
        body = await boundedJson(request, 73728);
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      if (!validSubmission(body))
        return json({ error: "Invalid submission" }, 400);
      // Retention adds an await: serialize admission through the append, including deduplication.
      const preceding = landingAdmission;
      let release!: () => void;
      landingAdmission = new Promise<void>((resolve) => { release = resolve; });
      await preceding;
      try {
        const repo = repositoryKey(body.repo);
        const requestFact = body.requestId ? { type: "submission_request" as const, requestId: body.requestId, repo,
          changeId: body.changeId, commitId: body.commitId, bookmark: body.bookmark, submittedBy: body.submittedBy,
          ...body.handoff ? { handoffSha256: handoffDigest(body.handoff) } : {} } : undefined;
        const prior = body.requestId ? input.log.submission(repo, body.requestId) : null;
        if (prior) {
          if ((["changeId", "commitId", "bookmark", "submittedBy", "handoffSha256"] as const).some((key) => prior.request[key] !== requestFact![key]))
            return json({ error: "Submission request identity is already bound to another candidate" }, 409);
          return json({ operation: prior.operation, reattached: true, requestId: body.requestId });
        }
        const existing = input.log.operationsForChange(repo, body.changeId).find((op) => op.status === "queued" || op.status === "running");
        if (existing?.commitId === body.commitId) {
          const original = input.log.events({ operationId: existing.id }).find((row) => row.event.type === "submitted")?.event;
          if (original?.type === "submitted" && (original.kind === undefined || original.kind === "landing") && original.handoffSha256 !== handoffDigest(body.handoff))
            return json({ error: "Open candidate already has different handoff evidence" }, 409);
          if (requestFact) input.log.append(existing.id, requestFact);
          return json({ operation: existing, reattached: true, ...body.requestId ? { requestId: body.requestId } : {} });
        }
        if (existing?.status === "running")
          return json({ operation: existing }, 409);
        const id = newOperationId();
        let retained: Awaited<ReturnType<NonNullable<typeof input.retainSubmission>>> | undefined;
        try { retained = await input.retainSubmission?.(id, body); }
        catch { return json({ error: "Source retention did not complete; submission was not acknowledged" }, 503); }
        // A queued predecessor may have started or been cancelled while capture awaited I/O.
        const active = input.log.operationsForChange(repo, body.changeId).find((op) => op.status === "queued" || op.status === "running");
        if (active?.status === "running") return json({ operation: active }, 409);
        if (active) input.log.append(active.id, { type: "superseded", by: id });
        input.log.append(id, { type: "submitted", repo, changeId: body.changeId, commitId: body.commitId, bookmark: body.bookmark, submittedBy: body.submittedBy,
          ...body.handoff ? { handoffSha256: handoffDigest(body.handoff) } : {} });
        if (retained) input.log.append(id, retained);
        if (body.identity) input.log.append(id, body.identity);
        if (requestFact) input.log.append(id, requestFact);
        input.onSubmitted();
        return json({ operation: input.log.operation(id), reattached: false, ...body.requestId ? { requestId: body.requestId } : {}, ...active ? { superseded: active.id } : {} });
      } finally { release(); }
    }
    if (request.method === "POST" && path === `${RUNNER_API}/releases`) {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      if (!validRelease(body))
        return json({ error: "Invalid release" }, 400);
      const repo = repositoryKey(body.repo);
      // A rerun confirm follows the open release of its candidate; the queue coalesces the rest.
      const existing = input.log.openOperations(repo).find((op) => op.kind === "release" && op.commitId === body.candidate);
      if (existing)
        return json({ operation: existing, reattached: true });
      const id = newOperationId();
      input.log.append(id, { type: "submitted", kind: "release", repo, commitId: body.candidate, migrationsReady: body.migrationsReady, submittedBy: body.submittedBy });
      input.onSubmitted();
      return json({ operation: input.log.operation(id), reattached: false });
    }
    if (request.method === "POST" && path === `${RUNNER_API}/deploys`) {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      if (!validDeploy(body))
        return json({ error: "Invalid deploy" }, 400);
      if (body.environment === "production")
        return json({ error: "production deploys only through slipjay promote" }, 400);
      const repo = repositoryKey(body.repo);
      const open = input.log.openOperations(repo).filter((op) => op.kind === "deploy" && op.environment === body.environment);
      const same = open.find((op) => op.commitId === body.commitId);
      if (same)
        return json({ operation: same, reattached: true });
      const id = newOperationId();
      // A queued deploy of an older commit would only be overwritten by this one.
      for (const stale of open.filter((op) => op.status === "queued"))
        input.log.append(stale.id, { type: "superseded", by: id });
      input.log.append(id, { type: "submitted", kind: "deploy", repo, environment: body.environment, commitId: body.commitId, submittedBy: body.submittedBy });
      input.onSubmitted();
      return json({ operation: input.log.operation(id), reattached: false });
    }
    if (request.method === "POST" && path === `${RUNNER_API}/resets`) {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      if (!validReset(body))
        return json({ error: "Invalid reset" }, 400);
      const repo = repositoryKey(body.repo);
      const open = input.log.openOperations(repo).find((op) => op.kind === "reset");
      if (open)
        return json({ operation: open, reattached: true });
      // The reset runs in the integration tip's source; the last landed commit only labels the operation.
      const landed = input.log.lastLanded(repo);
      if (!landed)
        return json({ error: `${repo} has not landed on this runner yet, so it has no checkout to reset from` }, 400);
      const id = newOperationId();
      input.log.append(id, { type: "submitted", kind: "reset", repo, commitId: landed.commitId, submittedBy: body.submittedBy });
      input.onSubmitted();
      return json({ operation: input.log.operation(id), reattached: false });
    }
    if (request.method === "GET" && path === `${RUNNER_API}/resets`) {
      const repo = url.searchParams.get("repo");
      if (!repo)
        return json({ error: "repo is required" }, 400);
      return json({ operations: input.log.resets(repositoryKey(repo)) });
    }
    if (request.method === "GET" && path === `${RUNNER_API}/deploys`) {
      const repo = url.searchParams.get("repo");
      if (!repo)
        return json({ error: "repo is required" }, 400);
      return json({ operations: input.log.deployments(repositoryKey(repo), url.searchParams.get("environment") ?? undefined) });
    }
    if (request.method === "GET" && path === `${RUNNER_API}/releases`) {
      const repo = url.searchParams.get("repo");
      if (!repo)
        return json({ error: "repo is required" }, 400);
      return json({ operations: input.log.releases(repositoryKey(repo)) });
    }
    const change = path.match(new RegExp(`^${RUNNER_API}/changes/([^/]+)$`));
    if (request.method === "GET" && change) {
      const repo = url.searchParams.get("repo");
      if (!repo)
        return json({ error: "repo is required" }, 400);
      return json({ operations: input.log.operationsForChange(repositoryKey(repo), decodeURIComponent(change[1]!)) });
    }
    const artifact = path.match(new RegExp(`^${RUNNER_API}/operations/([^/]+)/artifacts/([^/]+)$`));
    if (artifact && request.method === "GET") {
      const operationId = decodeURIComponent(artifact[1]!), runId = decodeURIComponent(artifact[2]!);
      const operation = input.log.operation(operationId);
      if (!operation) return json({ error: "Unknown operation" }, 404);
      const reference = operation.runs.find((run) => run.runId === runId)?.artifact;
      if (!reference || reference.status !== "retained") return json({ error: "Command artifact unavailable", reason: reference?.status === "unavailable" ? reference.reason : "not-recorded" }, 410);
      const rawOffset = url.searchParams.get("offset") ?? "0", rawLimit = url.searchParams.get("limit") ?? "16384";
      if (!/^\d+$/.test(rawOffset) || !Number.isSafeInteger(Number(rawOffset)) || Number(rawOffset) > reference.bytes
        || !/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 16384) return json({ error: "Invalid artifact range" }, 400);
      if (!input.readArtifact) return json({ error: "Artifact retrieval unavailable" }, 503);
      try { return json(await input.readArtifact(operationId, runId, reference, Number(rawOffset), Number(rawLimit))); }
      catch { return json({ error: "Retained artifact is missing or does not match ledger evidence" }, 410); }
    }
    const route = path.match(new RegExp(`^${RUNNER_API}/operations/([^/]+)(?:/(events|log|outcome|handoff|cancel))?$`));
    if (!route || (route[2] === "cancel" ? request.method !== "POST" : request.method !== "GET"))
      return json({ error: "Not found" }, 404);
    const id = decodeURIComponent(route[1]!);
    const operation = input.log.operation(id);
    if (!operation)
      return json({ error: "Unknown operation" }, 404);
    switch (route[2]) {
      case "handoff":
        if (operation.kind !== "landing") return json({ error: "Handoff supports landing operations only" }, 409);
        if (!input.readManifest) return json({ error: "Handoff retrieval is unavailable" }, 501);
        try { return json({ manifest: await input.readManifest(operation) }); }
        catch { return json({ error: "Retained handoff is missing or does not match ledger evidence" }, 410); }
      case "outcome":
        return operation.kind === "landing" ? json({ outcome: operation.outcome }) : json({ error: "Outcome v1 supports landing operations only" }, 409);
      case "cancel": {
        let body: unknown = {};
        try { const text = await request.text(); if (text) body = JSON.parse(text); } catch { return json({ error: "Invalid JSON body" }, 400); }
        if (!body || typeof body !== "object" || Array.isArray(body) || ("by" in body && (typeof body.by !== "string" || !body.by.trim() || body.by.length > 200))) return json({ error: "Invalid cancel actor" }, 400);
        const current = input.log.operation(id);
        if (!current) return json({ error: "Unknown operation" }, 404);
        if (current.status !== "queued") return json({ operation: current }, 409);
        input.log.append(id, { type: "cancelled", reason: "cancelled by the author", ...("by" in body ? { by: body.by as string } : {}) });
        // Appended first, so the queue never starts it; nobody follows a cancel they asked for.
        input.onCancelled?.(current);
        return json({ operation: input.log.operation(id) });
      }
      case "log": {
        const log = await input.readLog(id);
        return log === null ? json({ error: "Log not found" }, 404) : new Response(log, { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      case "events": {
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!Number.isSafeInteger(after) || after < 0)
          return json({ error: "after must be a non-negative integer" }, 400);
        return eventStream(input, id, after, request.signal);
      }
      default:
        return json({ operation });
    }
  };
}

const boundedString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 300;
async function boundedJson(request: Request, maximumBytes = 8192): Promise<Record<string, unknown> | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}
function validClientFact(value: unknown): value is ClientFact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fact = value as Record<string, unknown>;
  const duration = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 30 * 86400_000;
  const integer = (value: unknown, max: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
  const keys: Record<string, string[]> = { workspace_start: ["kind", "workspace", "machine", "startedAt"], pool_claim: ["kind", "workspace", "hit", "spareCount", "durationMs"], land_follow: ["kind", "reattached"], ssh_forward_failure: ["kind", "reason", "observedAt"], preview_start: ["kind", "workspace", "port"] };
  if (typeof fact.kind !== "string" || !keys[fact.kind] || Object.keys(fact).some((key) => !keys[fact.kind as string]!.includes(key))) return false;
  switch (fact.kind) {
    case "workspace_start": return boundedString(fact.workspace) && boundedString(fact.machine) && typeof fact.startedAt === "string" && /^\d{4}-\d\d-\d\dT/.test(fact.startedAt) && Number.isFinite(Date.parse(fact.startedAt));
    case "pool_claim": return boundedString(fact.workspace) && typeof fact.hit === "boolean" && integer(fact.spareCount, 8) && duration(fact.durationMs);
    case "land_follow": return typeof fact.reattached === "boolean";
    case "ssh_forward_failure": return boundedString(fact.reason) && typeof fact.observedAt === "string" && /^\d{4}-\d\d-\d\dT/.test(fact.observedAt) && Number.isFinite(Date.parse(fact.observedAt));
    case "preview_start": return boundedString(fact.workspace) && integer(fact.port, 65535) && fact.port !== 0;
    default: return false;
  }
}

function validSubmission(body: unknown): body is SubmitRequest {
  if (typeof body !== "object" || body === null)
    return false;
  const value = body as Record<string, unknown>;
  if (value.handoff !== undefined && (!validSubmissionHandoff(value.handoff) || value.handoff.source !== value.commitId)) return false;
  if (value.requestId !== undefined && (typeof value.requestId !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(value.requestId)
    || typeof value.commitId !== "string" || !/^[a-f0-9]{40}$/.test(value.commitId)
    || typeof value.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(value.repo))) return false;
  if (value.identity !== undefined) {
    if (!value.identity || typeof value.identity !== "object" || Array.isArray(value.identity)) return false;
    const identity = value.identity as Record<string, unknown>;
    if (identity.type !== "identity" || !["person", "agent", "unknown"].includes(String(identity.submitterKind)) || !["submitterId", "workspace", "machine"].every((key) => boundedString(identity[key]))) return false;
    if (["harness", "sessionId"].some((key) => identity[key] !== undefined && !boundedString(identity[key]))) return false;
    if (["ticket", "spec"].some((key) => identity[key] !== undefined && (!Number.isSafeInteger(identity[key]) || Number(identity[key]) <= 0))) return false;
    if (Object.keys(identity).some((key) => !["type", "submitterKind", "submitterId", "workspace", "machine", "harness", "sessionId", "ticket", "spec"].includes(key))) return false;
  }
  if (!["repo", "changeId", "commitId", "bookmark", "submittedBy"].every((key) => typeof value[key] === "string" && value[key].trim().length > 0))
    return false;
  return /^[k-z]{12,64}$/.test(value.changeId as string) && value.bookmark === candidateBookmark(value.changeId as string);
}

function validControl(body: unknown): body is RunnerControlRequest {
  const fields = body as Record<string, unknown>;
  return typeof body === "object" && body !== null && typeof fields.by === "string" && fields.by.trim().length > 0
    && (fields.operation === undefined || (typeof fields.operation === "string" && /^op_[0-9a-z]+_[0-9a-f]+$/.test(fields.operation)));
}

function validRelease(body: unknown): body is ReleaseRequest {
  if (typeof body !== "object" || body === null)
    return false;
  const value = body as Record<string, unknown>;
  return ["repo", "submittedBy"].every((key) => typeof value[key] === "string" && value[key].trim().length > 0)
    && typeof value.candidate === "string" && /^[a-f0-9]{40,64}$/.test(value.candidate) && typeof value.migrationsReady === "boolean";
}

function validReset(body: unknown): body is ResetRequest {
  if (typeof body !== "object" || body === null)
    return false;
  const value = body as Record<string, unknown>;
  return ["repo", "submittedBy"].every((key) => typeof value[key] === "string" && value[key].trim().length > 0);
}

function validDeploy(body: unknown): body is DeployRequest {
  if (typeof body !== "object" || body === null)
    return false;
  const value = body as Record<string, unknown>;
  return ["repo", "submittedBy"].every((key) => typeof value[key] === "string" && value[key].trim().length > 0)
    && typeof value.environment === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(value.environment)
    && typeof value.commitId === "string" && /^[a-f0-9]{40,64}$/.test(value.commitId);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function terminal(stored: StoredEvent): boolean {
  return (TERMINAL_EVENT_TYPES as readonly string[]).includes(stored.event.type);
}

function eventStream(input: Parameters<typeof createRunnerHandler>[0], id: string, after: number, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let replaying = true;
      let lastSeq = after;
      const buffered: StoredEvent[] = [];
      let unsubscribe = () => {};
      let timer: ReturnType<typeof setInterval> | undefined;
      const finish = () => {
        if (closed)
          return;
        closed = true;
        cleanup();
        controller.close();
      };
      cleanup = () => {
        if (timer !== undefined)
          clearInterval(timer);
        unsubscribe();
        signal.removeEventListener("abort", finish);
      };
      const send = (stored: StoredEvent) => {
        if (closed || stored.operationId !== id || stored.seq <= lastSeq)
          return;
        lastSeq = stored.seq;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(stored)}\n\n`));
        if (terminal(stored))
          finish();
      };
      unsubscribe = input.subscribe((stored) => {
        if (stored.operationId !== id || closed)
          return;
        if (replaying)
          buffered.push(stored);
        else
          send(stored);
      });
      for (const stored of input.log.events({ operationId: id, afterSeq: after }))
        send(stored);
      replaying = false;
      for (const stored of buffered.sort((a, b) => a.seq - b.seq))
        send(stored);
      if (input.log.operation(id)?.result)
        finish();
      if (!closed) {
        timer = setInterval(() => controller.enqueue(encoder.encode(": keepalive\n\n")), 15_000);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted)
          finish();
      }
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

/** Durable cursors only: heartbeats do not append events or advance the cursor. */
function globalEventStream(log: OperationLog, since: number, signal: AbortSignal): Response {
  let cleanup = () => {};
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastSeq = since;
      let replaying = true;
      const buffered: StoredEvent[] = [];
      let timer: ReturnType<typeof setInterval> | undefined;
      let unsubscribe = () => {};
      const finish = () => { if (closed) return; closed = true; cleanup(); controller.close(); };
      let cleaned = false;
      cleanup = () => { if (cleaned) return; cleaned = true; unsubscribe(); if (timer) clearInterval(timer); signal.removeEventListener("abort", finish); };
      const send = (stored: StoredEvent) => {
        if (closed || stored.seq <= lastSeq) return;
        // A slow reader reconnects and replays from its own last consumed cursor.
        if ((controller.desiredSize ?? 0) <= 0) { finish(); return; }
        lastSeq = stored.seq;
        controller.enqueue(encoder.encode(`event: stored\ndata: ${JSON.stringify(stored)}\n\n`));
      };
      unsubscribe = log.subscribe((stored) => {
        if (closed) return;
        if (replaying) { if (buffered.length >= 1000) finish(); else buffered.push(stored); }
        else send(stored);
      });
      for (const stored of log.events({ afterSeq: since, limit: 1001 })) send(stored);
      replaying = false;
      for (const stored of buffered) send(stored);
      if (!closed) {
        timer = setInterval(() => {
          if ((controller.desiredSize ?? 0) <= 0) { finish(); return; }
          controller.enqueue(encoder.encode(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString(), seq: lastSeq })}\n\n`));
        }, 15_000);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      } else cleanup();
    },
    cancel() { cleanup(); },
  }, { highWaterMark: 1000 });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
