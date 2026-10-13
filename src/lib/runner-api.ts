import { timingSafeEqual } from "node:crypto";
import { candidateBookmark, RUNNER_API } from "./runner-contract.ts";
import type { OperationLog, RunnerHandler, StoredEvent, SubmitRequest } from "./runner-contract.ts";
import { newOperationId } from "./runner-log.ts";

export function createRunnerHandler(input: {
  log: OperationLog;
  token: string;
  runnerName: string;
  readLog(operationId: string): Promise<string | null>;
  onSubmitted(): void;
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
      return json({ ok: true, runner: input.runnerName, queued: input.log.openOperations().filter((op) => op.status === "queued").length });
    if (request.method === "POST" && path === `${RUNNER_API}/operations`) {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      if (!validSubmission(body))
        return json({ error: "Invalid submission" }, 400);
      const existing = input.log.operationsForChange(body.repo, body.changeId).find((op) => op.status === "queued" || op.status === "running");
      if (existing?.commitId === body.commitId)
        return json({ operation: existing, reattached: true });
      if (existing?.status === "running")
        return json({ operation: existing }, 409);
      const id = newOperationId();
      if (existing)
        input.log.append(existing.id, { type: "superseded", by: id });
      input.log.append(id, { type: "submitted", repo: body.repo, changeId: body.changeId, commitId: body.commitId, bookmark: body.bookmark, submittedBy: body.submittedBy });
      input.onSubmitted();
      return json({ operation: input.log.operation(id), reattached: false, ...existing ? { superseded: existing.id } : {} });
    }
    const change = path.match(new RegExp(`^${RUNNER_API}/changes/([^/]+)$`));
    if (request.method === "GET" && change) {
      const repo = url.searchParams.get("repo");
      if (!repo)
        return json({ error: "repo is required" }, 400);
      return json({ operations: input.log.operationsForChange(repo, decodeURIComponent(change[1]!)) });
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

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function terminal(stored: StoredEvent): boolean {
  return ["landed", "failed", "declined", "superseded", "cancelled"].includes(stored.event.type);
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
