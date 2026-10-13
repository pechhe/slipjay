import assert from "node:assert/strict";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { test } from "vite-plus/test";
import { createRunnerHandler } from "../src/lib/runner-api.ts";
import { candidateBookmark, RUNNER_API } from "../src/lib/runner-contract.ts";
import type { Operation, OperationEvent, StoredEvent, SubmitResponse } from "../src/lib/runner-contract.ts";
import { serveRunner } from "../src/lib/runner-http.ts";
import { openOperationLog } from "../src/lib/runner-log.ts";

const token = "test-secret";
const changeId = "k".repeat(32);
function submission(commitId = "commit-1", change = changeId) {
  return { repo: "owner/repo", changeId: change, commitId, bookmark: candidateBookmark(change), submittedBy: "author" };
}

async function fixture() {
  const log = openOperationLog(":memory:");
  const listeners = new Set<(event: StoredEvent) => void>();
  let submissions = 0;
  let onSubscribe: (() => void) | undefined;
  const handler = createRunnerHandler({
    log, token, runnerName: "test-runner",
    readLog: (id) => Promise.resolve(id === "missing-log" ? null : "command output\n"),
    onSubmitted: () => { submissions++; },
    subscribe(listener) {
      listeners.add(listener);
      onSubscribe?.();
      return () => { listeners.delete(listener); };
    },
  });
  const server = await serveRunner(handler, { host: "127.0.0.1", port: 0 });
  const request = (path: string, init: RequestInit = {}) => fetch(`${server.url}${RUNNER_API}${path}`, {
    ...init, headers: { authorization: `Bearer ${token}`, ...init.headers }, signal: init.signal ?? AbortSignal.timeout(10_000),
  });
  const submit = (body = submission()) => request("/operations", { method: "POST", body: JSON.stringify(body) });
  const append = (id: string, event: OperationEvent) => {
    const stored = log.append(id, event);
    for (const listener of listeners)
      listener(stored);
    return stored;
  };
  return {
    log, server, request, submit, append, listeners,
    get submissions() { return submissions; },
    set onSubscribe(callback: (() => void) | undefined) { onSubscribe = callback; },
    async close() { await server.close(); log.close(); },
  };
}

async function submitted(response: Response): Promise<SubmitResponse> {
  assert.equal(response.status, 200);
  return await response.json() as SubmitResponse;
}

async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<StoredEvent> {
  let text = "";
  while (!text.includes("\n\n")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    text += new TextDecoder().decode(chunk.value);
  }
  const line = text.split("\n").find((value) => value.startsWith("data: "));
  assert.ok(line);
  return JSON.parse(line.slice(6)) as StoredEvent;
}

test("HTTP runner refuses missing and wrong credentials, reports health and rejects invalid submissions", async () => {
  const f = await fixture();
  try {
    assert.ok(f.server.port > 0);
    for (const headers of [new Headers(), new Headers({ authorization: "Bearer wrong-token" }), new Headers({ authorization: `Bearer ${"x".repeat(token.length)}` })]) {
      const response = await fetch(`${f.server.url}${RUNNER_API}/health`, { headers });
      assert.equal(response.status, 401);
      assert.equal(typeof (await response.json() as { error: string }).error, "string");
    }
    assert.deepEqual(await (await f.request("/health")).json(), { ok: true, runner: "test-runner", queued: 0 });
    for (const field of ["repo", "changeId", "commitId", "bookmark", "submittedBy"]) {
      const response = await f.submit({ ...submission(), [field]: " " });
      assert.equal(response.status, 400);
    }
    for (const invalidChange of ["a".repeat(32), "k".repeat(11), "k".repeat(65)])
      assert.equal((await f.submit(submission("commit", invalidChange))).status, 400);
    assert.equal((await f.submit({ ...submission(), bookmark: "wrong/bookmark" })).status, 400);
    assert.equal((await f.request("/operations", { method: "POST", body: "{" })).status, 400);
    assert.equal(f.log.events().length, 0);
    assert.equal((await f.request("/unknown")).status, 404);
    for (const suffix of ["", "/events", "/log"])
      assert.equal((await f.request(`/operations/unknown${suffix}`)).status, 404);
    assert.equal((await f.request("/operations/unknown/cancel", { method: "POST" })).status, 404);
  } finally {
    await f.close();
  }
});

test("submissions create, reattach, supersede queued work and conflict with running work", async () => {
  const f = await fixture();
  try {
    const first = await submitted(await f.submit());
    assert.equal(first.reattached, false);
    assert.equal(first.operation.status, "queued");
    assert.equal(first.operation.position, 1);
    const again = await submitted(await f.submit());
    assert.equal(again.reattached, true);
    assert.equal(again.operation.id, first.operation.id);
    const recased = await submitted(await f.submit({ ...submission(), repo: "Owner/Repo" }));
    assert.equal(recased.operation.id, first.operation.id);
    assert.equal(f.log.operationsForChange("owner/repo", changeId).length, 1);
    assert.equal(f.submissions, 1);
    const replacement = await submitted(await f.submit(submission("commit-2")));
    assert.equal(replacement.superseded, first.operation.id);
    assert.notEqual(replacement.operation.id, first.operation.id);
    assert.equal(f.log.operation(first.operation.id)?.status, "superseded");
    assert.deepEqual(f.log.operation(first.operation.id)?.result, { type: "superseded", by: replacement.operation.id });
    assert.equal(f.submissions, 2);
    assert.deepEqual(await (await f.request(`/operations/${replacement.operation.id}`)).json(), { operation: replacement.operation });
    assert.equal(await (await f.request(`/operations/${replacement.operation.id}/log`)).text(), "command output\n");
    f.log.append("missing-log", { type: "submitted", ...submission("missing", "z".repeat(32)) });
    assert.equal((await f.request("/operations/missing-log/log")).status, 404);
    f.append(replacement.operation.id, { type: "stage", stage: "verifying" });
    const conflict = await f.submit(submission("commit-3"));
    assert.equal(conflict.status, 409);
    const body = await conflict.json() as { operation: Operation };
    assert.equal(body.operation.id, replacement.operation.id);
    assert.equal(body.operation.status, "running");
    assert.equal(f.log.operationsForChange("owner/repo", changeId).length, 2);
    assert.equal(f.submissions, 2);
    assert.equal((await submitted(await f.submit(submission("commit-2")))).reattached, true);
    const changes = await (await f.request(`/changes/${changeId}?repo=Owner/Repo`)).json() as { operations: Operation[] };
    assert.deepEqual(changes.operations.map((op) => op.id), [replacement.operation.id, first.operation.id]);
    assert.equal((await f.request(`/changes/${changeId}`)).status, 400);
    assert.deepEqual(await (await f.request("/health")).json(), { ok: true, runner: "test-runner", queued: 1 });
  } finally {
    await f.close();
  }
});

test("SSE replays after a sequence, streams live events and closes at a terminal event", async () => {
  const f = await fixture();
  try {
    const { operation } = await submitted(await f.submit());
    const stage = f.append(operation.id, { type: "stage", stage: "verifying" });
    const response = await f.request(`/operations/${operation.id}/events?after=${operation.lastSeq}`);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body!.getReader();
    assert.deepEqual(await nextEvent(reader), stage);
    const other = f.log.append("other", { type: "submitted", ...submission("other") });
    for (const listener of f.listeners)
      listener(other);
    const landed = f.append(operation.id, { type: "landed", base: "old", commitId: "new", branch: "main", remote: "origin" });
    assert.deepEqual(await nextEvent(reader), landed);
    assert.equal((await reader.read()).done, true);
    assert.equal(f.listeners.size, 0);
    const replay = await f.request(`/operations/${operation.id}/events`);
    const text = await replay.text();
    const events = text.trim().split("\n\n").map((line) => JSON.parse(line.slice(6)) as StoredEvent);
    assert.deepEqual(events, f.log.events({ operationId: operation.id }));
    assert.equal(await (await f.request(`/operations/${operation.id}/events?after=${landed.seq}`)).text(), "");
    assert.equal((await f.request(`/operations/${operation.id}/events?after=bad`)).status, 400);
  } finally {
    await f.close();
  }
});

test("SSE deduplicates events received between subscribing and replay", async () => {
  const f = await fixture();
  try {
    const { operation } = await submitted(await f.submit());
    f.onSubscribe = () => {
      f.append(operation.id, { type: "progress", line: "during subscribe" });
      f.append(operation.id, { type: "failed", stage: "fetching", reason: "test failure" });
    };
    const response = await f.request(`/operations/${operation.id}/events`);
    const events = (await response.text()).trim().split("\n\n").map((line) => JSON.parse(line.slice(6)) as StoredEvent);
    assert.deepEqual(events, f.log.events({ operationId: operation.id }));
    assert.equal(f.listeners.size, 0);
  } finally {
    await f.close();
  }
});

test("cancel closes only queued work and closed changes can be submitted again", async () => {
  const f = await fixture();
  try {
    const { operation } = await submitted(await f.submit());
    const cancelled = await f.request(`/operations/${operation.id}/cancel`, { method: "POST" });
    assert.equal(cancelled.status, 200);
    const body = await cancelled.json() as { operation: Operation };
    assert.equal(body.operation.status, "cancelled");
    assert.deepEqual(body.operation.result, { type: "cancelled", reason: "cancelled by the author" });
    assert.equal((await f.request(`/operations/${operation.id}/cancel`, { method: "POST" })).status, 409);
    const next = await submitted(await f.submit());
    assert.equal(next.reattached, false);
    assert.notEqual(next.operation.id, operation.id);
    f.append(next.operation.id, { type: "stage", stage: "verifying" });
    const conflict = await f.request(`/operations/${next.operation.id}/cancel`, { method: "POST" });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { operation: f.log.operation(next.operation.id) });
  } finally {
    await f.close();
  }
});

test("runner HTTP adapter rejects public listen hosts", async () => {
  await assert.rejects(serveRunner(() => Promise.resolve(new Response()), { host: "0.0.0.0", port: 0 }), /loopback/);
});
