import { timingSafeEqual } from "node:crypto";
import { candidateBookmark, repositoryKey, RUNNER_API, RUNNER_CONTROL_ID, TERMINAL_EVENT_TYPES } from "./runner-contract.ts";
import type { Operation, OperationLog, ReleaseRequest, RunnerControlRequest, RunnerHandler, StoredEvent, SubmitRequest } from "./runner-contract.ts";
import { newOperationId } from "./runner-log.ts";

export function createRunnerHandler(input: {
  log: OperationLog;
  token: string;
  runnerName: string;
  readLog(operationId: string): Promise<string | null>;
  /** Wakes the queue: after a submission, and when the owner resumes it. */
  onSubmitted(): void;
  kill(): { operation: Operation; killed: boolean } | null;
  subscribe(listener: (event: StoredEvent) => void): () => void;
}): RunnerHandler {
  const credential = Buffer.from(`Bearer ${input.token}`);
  return async (request) => {
    const authorization = Buffer.from(request.headers.get("authorization") ?? "");
    if (authorization.length !== credential.length || !timingSafeEqual(authorization, credential))
      return json({ error: "Unauthorized" }, 401);
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "GET" && path === `${RUNNER_API}/health`)
      return json({ ok: true, runner: input.runnerName, queued: input.log.openOperations().filter((op) => op.status === "queued").length, paused: input.log.paused() !== null });
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
        const outcome = input.kill();
        if (outcome && !outcome.killed)
          return json({ operation: outcome.operation, reason: `${outcome.operation.stage} is past verification and cannot be killed; it finishes on its own` }, 409);
        return json({ operation: outcome?.operation ?? null });
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
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      if (!validSubmission(body))
        return json({ error: "Invalid submission" }, 400);
      const repo = repositoryKey(body.repo);
      const existing = input.log.operationsForChange(repo, body.changeId).find((op) => op.status === "queued" || op.status === "running");
      if (existing?.commitId === body.commitId)
        return json({ operation: existing, reattached: true });
      if (existing?.status === "running")
        return json({ operation: existing }, 409);
      const id = newOperationId();
      if (existing)
        input.log.append(existing.id, { type: "superseded", by: id });
      input.log.append(id, { type: "submitted", repo, changeId: body.changeId, commitId: body.commitId, bookmark: body.bookmark, submittedBy: body.submittedBy });
      input.onSubmitted();
      return json({ operation: input.log.operation(id), reattached: false, ...existing ? { superseded: existing.id } : {} });
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
    const change = path.match(new RegExp(`^${RUNNER_API}/changes/([^/]+)$`));
    if (request.method === "GET" && change) {
      const repo = url.searchParams.get("repo");
      if (!repo)
        return json({ error: "repo is required" }, 400);
      return json({ operations: input.log.operationsForChange(repositoryKey(repo), decodeURIComponent(change[1]!)) });
    }
    const route = path.match(new RegExp(`^${RUNNER_API}/operations/([^/]+)(?:/(events|log|cancel))?$`));
    if (!route || (route[2] === "cancel" ? request.method !== "POST" : request.method !== "GET"))
      return json({ error: "Not found" }, 404);
    const id = decodeURIComponent(route[1]!);
    const operation = input.log.operation(id);
    if (!operation)
      return json({ error: "Unknown operation" }, 404);
    switch (route[2]) {
      case "cancel":
        if (operation.status !== "queued")
          return json({ operation }, 409);
        input.log.append(id, { type: "cancelled", reason: "cancelled by the author" });
        return json({ operation: input.log.operation(id) });
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

function validSubmission(body: unknown): body is SubmitRequest {
  if (typeof body !== "object" || body === null)
    return false;
  const value = body as Record<string, unknown>;
  if (!["repo", "changeId", "commitId", "bookmark", "submittedBy"].every((key) => typeof value[key] === "string" && value[key].trim().length > 0))
    return false;
  return /^[k-z]{12,64}$/.test(value.changeId as string) && value.bookmark === candidateBookmark(value.changeId as string);
}

function validControl(body: unknown): body is RunnerControlRequest {
  return typeof body === "object" && body !== null && typeof (body as Record<string, unknown>).by === "string" && ((body as Record<string, unknown>).by as string).trim().length > 0;
}

function validRelease(body: unknown): body is ReleaseRequest {
  if (typeof body !== "object" || body === null)
    return false;
  const value = body as Record<string, unknown>;
  return ["repo", "submittedBy"].every((key) => typeof value[key] === "string" && value[key].trim().length > 0)
    && typeof value.candidate === "string" && /^[a-f0-9]{40,64}$/.test(value.candidate) && typeof value.migrationsReady === "boolean";
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
