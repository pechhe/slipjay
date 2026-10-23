import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { test } from "vite-plus/test";
import { createRunnerHandler } from "../../src/lib/runner/runner-api.ts";
import { candidateBookmark, RUNNER_API, RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import type { DeployResponse, Operation, OperationEvent, ReleaseResponse, ResetResponse, StoredEvent, SubmitRequest, SubmitResponse, VerificationResponse } from "../../src/lib/runner/runner-types.ts";
import { serveRunner } from "../../src/lib/runner/runner-http.ts";
import { openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { classifyEvent } from "../../src/lib/runner/failure-classification.ts";

const token = "test-secret";
const changeId = "k".repeat(32);
function submission(commitId = "commit-1", change = changeId) {
  return { repo: "owner/repo", changeId: change, commitId, bookmark: candidateBookmark(change), submittedBy: "author" };
}

async function fixture(logPath = ":memory:", retainSubmission?: Parameters<typeof createRunnerHandler>[0]["retainSubmission"]) {
  const log = openOperationLog(logPath, {}, { classify: classifyEvent });
  const listeners = new Set<(event: StoredEvent) => void>();
  let submissions = 0;
  let onSubscribe: (() => void) | undefined;
  let killOutcome: ReturnType<Parameters<typeof createRunnerHandler>[0]["kill"]> = { status: "idle" };
  let recoverHeld: Parameters<typeof createRunnerHandler>[0]["recoverHeld"];
  const handler = createRunnerHandler({
    log, token, runnerName: "test-runner", retainSubmission,
    readLog: (id) => Promise.resolve(id === "missing-log" ? null : "command output\n"),
    onSubmitted: () => { submissions++; },
    kill: () => killOutcome,
    recoverHeld: (repo) => recoverHeld?.(repo) ?? null,
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
  const submit = (body: SubmitRequest = submission()) => request("/operations", { method: "POST", body: JSON.stringify(body) });
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
    set killOutcome(outcome: typeof killOutcome) { killOutcome = outcome; },
    set recoverHeld(recover: typeof recoverHeld) { recoverHeld = recover; },
    async close() {
      await server.close();
      const capture = process.env.SLIPJAY_CAPTURE_PIPELINE_FIXTURES;
      if (capture) {
        await mkdir(capture, { recursive: true });
        await writeFile(join(capture, `api-${randomUUID()}.json`), JSON.stringify(log.events()));
      }
      log.close();
    },
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
    assert.deepEqual(await (await f.request("/health")).json(), { ok: true, runner: "test-runner", queued: 0, paused: false, held: [] });
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

test("watchers at one ledger position share a queue snapshot, and a new event refreshes it", async () => {
  const runner = await fixture();
  try {
    const build = runner.log.snapshot;
    let builds = 0;
    runner.log.snapshot = (...args) => { builds++; return build(...args); };
    const first = await (await runner.request("/queue")).text();
    const second = await (await runner.request("/queue")).text();
    assert.equal(builds, 1);
    assert.equal(second, first);
    runner.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    const after = await (await runner.request("/queue")).json() as { seq: number; paused: { by: string } | null };
    assert.equal(builds, 2);
    assert.equal(after.paused?.by, "owner");
    assert.ok(after.seq > (JSON.parse(first) as { seq: number }).seq);
  } finally { await runner.close(); }
});

test("client operations are attributed to their repository and never enter the work queue", async () => {
  const f = await fixture();
  try {
    const response = await f.request("/client-operations", {
      method: "POST", body: JSON.stringify({ repo: "Owner/Repo", workspace: "workspace-a", machine: "mac-a" }),
    });
    assert.equal(response.status, 200);
    const { id } = await response.json() as { id: string };
    assert.ok(id);
    assert.deepEqual(f.log.events({ operationId: id }).map((row) => row.event), [
      { type: "client_operation", repo: "owner/repo", workspace: "workspace-a", machine: "mac-a" },
    ]);
    assert.equal(f.log.operation(id), null);
    assert.deepEqual(f.log.openOperations(), []);
    assert.equal((await f.request("/health")).status, 200);
  } finally { await f.close(); }
});

test("client events are idempotent and reject unknown facts, extra fields and oversized bodies", async () => {
  const f = await fixture();
  try {
    const clientResponse = await f.request("/client-operations", {
      method: "POST", body: JSON.stringify({ repo: "owner/repo", workspace: "workspace-a", machine: "mac-a" }),
    });
    const { id } = await clientResponse.json() as { id: string };
    const post = (body: unknown) => f.request(`/operations/${id}/events`, { method: "POST", body: JSON.stringify(body) });
    const payload = { id: "fact-1", fact: { kind: "land_follow", reattached: true } };
    const first = await post(payload);
    const duplicate = await post(payload);
    assert.equal(first.status, 200);
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), await first.clone().json());
    assert.equal(f.log.events({ operationId: id }).filter((row) => row.event.type === "client" && row.event.id === "fact-1").length, 1);

    const claim = { kind: "pool_claim", workspace: "w", hit: true, spareCount: 2, durationMs: 900 };
    assert.equal((await post({ id: "claim-steps", fact: { ...claim, steps: { fetch: 100, claim: 20, jjNew: 300, fingerprint: 400, describe: 80 } } })).status, 200);
    for (const fact of [
      { kind: "unknown_fact", value: 1 },
      { kind: "land_follow", reattached: true, extra: "refused" },
      { ...claim, steps: { unpacking: 5 } },
      { ...claim, steps: { fetch: -1 } },
      { ...claim, steps: [100] },
    ]) assert.equal((await post({ id: "bad", fact })).status, 400);
    const oversized = JSON.stringify({ id: "too-large", fact: { kind: "ssh_forward_failure", reason: "x".repeat(9_000) } });
    assert.ok(new TextEncoder().encode(oversized).byteLength > 8_192);
    assert.equal((await f.request(`/operations/${id}/events`, { method: "POST", body: oversized })).status, 400);
    assert.equal(f.log.events({ operationId: id }).filter((row) => row.event.type === "client").length, 2);
  } finally { await f.close(); }
});

test("client operation and event routes still require bearer authentication", async () => {
  const f = await fixture();
  try {
    const noAuth = (path: string, body: unknown) => fetch(`${f.server.url}${RUNNER_API}${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal((await noAuth("/client-operations", { repo: "owner/repo", workspace: "workspace", machine: "machine" })).status, 401);
    const { id } = await (await f.request("/client-operations", {
      method: "POST", body: JSON.stringify({ repo: "owner/repo", workspace: "workspace", machine: "machine" }),
    })).json() as { id: string };
    assert.equal((await noAuth(`/operations/${id}/events`, { id: "fact", fact: { kind: "land_follow", reattached: true } })).status, 401);
  } finally { await f.close(); }
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
    assert.deepEqual(await (await f.request("/health")).json(), { ok: true, runner: "test-runner", queued: 1, paused: false, held: [] });
  } finally {
    await f.close();
  }
});

test("release submissions queue a release, reattach to the open release of the same candidate and reject malformed ones", async () => {
  const f = await fixture();
  try {
    const candidate = "c".repeat(40);
    const release = (body: unknown) => f.request("/releases", { method: "POST", body: JSON.stringify(body) });
    const body = { repo: "Owner/Repo", candidate, migrationsReady: false, submittedBy: "author" };
    const landing = await submitted(await f.submit());
    const first = await (await release(body)).json() as ReleaseResponse;
    assert.equal(first.reattached, false);
    assert.equal(first.operation.kind, "release");
    assert.equal(first.operation.commitId, candidate);
    assert.equal(first.operation.position, 1, "a release verifies in its own lane, not behind the landing");
    assert.equal(f.submissions, 2);
    const again = await (await release({ ...body, repo: "owner/repo" })).json() as ReleaseResponse;
    assert.equal(again.reattached, true);
    assert.equal(again.operation.id, first.operation.id);
    assert.equal(f.submissions, 2);
    for (const invalid of [{ ...body, candidate: "c".repeat(12) }, { ...body, migrationsReady: "yes" }, { ...body, repo: "" }])
      assert.equal((await release(invalid)).status, 400);
    f.append(landing.operation.id, { type: "stage", stage: "verifying" });
    assert.equal((await (await f.request(`/operations/${first.operation.id}`)).json() as { operation: Operation }).operation.waitingFor,
      undefined, "a running landing does not hold a release's verification");
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

test("cancelling queued work during a pause records paused_out", async () => {
  const f = await fixture();
  try {
    const { operation } = await submitted(await f.submit());
    assert.equal((await f.request("/runner/pause", { method: "POST", body: JSON.stringify({ by: "owner" }) })).status, 200);
    assert.equal((await f.request(`/operations/${operation.id}/cancel`, { method: "POST", body: JSON.stringify({ by: "author" }) })).status, 200);
    assert.equal(f.log.events({ operationId: operation.id }).findLast((row) => row.event.type === "classified")?.event.type, "classified");
    const fact = f.log.events({ operationId: operation.id }).findLast((row) => row.event.type === "classified")?.event;
    assert.equal(fact?.type === "classified" && fact.cause, "paused_out");
  } finally { await f.close(); }
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

test("owner controls kill the running operation until verification ends, and pause and resume the queue", async () => {
  const f = await fixture();
  try {
    const control = (action: string, body: unknown = { by: "owner-mac" }) => f.request(`/runner/${action}`, { method: "POST", body: JSON.stringify(body) });
    assert.equal((await control("kill", {})).status, 400);
    assert.deepEqual(await (await control("kill")).json(), { operation: null });
    const { operation } = await submitted(await f.submit());
    f.killOutcome = { status: "killed", operation };
    assert.equal((await (await control("kill")).json() as { operation: { id: string } }).operation.id, operation.id);
    f.killOutcome = { status: "refused", operation: { ...operation, stage: "publishing" } };
    const refused = await control("kill");
    assert.equal(refused.status, 409);
    assert.match((await refused.json() as { reason: string }).reason, /publishing is past verification/);

    const before = f.submissions;
    assert.deepEqual(await (await control("pause")).json(), { paused: true });
    assert.deepEqual(await (await control("pause")).json(), { paused: true });
    assert.equal((await (await f.request("/health")).json() as { paused: boolean }).paused, true);
    assert.equal((await (await f.request(`/operations/${operation.id}`)).json() as { operation: { stage: string } }).operation.stage, "paused");
    assert.deepEqual(await (await control("resume")).json(), { paused: false });
    assert.equal(f.submissions, before + 1, "resuming wakes the queue");
    assert.equal((await (await f.request(`/operations/${operation.id}`)).json() as { operation: { stage: string } }).operation.stage, "queued");
    assert.deepEqual(f.log.events({ operationId: RUNNER_CONTROL_ID }).map((stored) => stored.event), [
      { type: "paused", by: "owner-mac" }, { type: "resumed", by: "owner-mac" }]);
  } finally { await f.close(); }
});

test("runner HTTP adapter rejects public listen hosts", async () => {
  await assert.rejects(serveRunner(() => Promise.resolve(new Response()), { host: "0.0.0.0", port: 0 }), /loopback/);
});

test("a verification request queues a staging-green commit's pre-verification once and never supersedes another", async () => {
  const f = await fixture();
  try {
    const verify = (body: unknown) => f.request("/verifications", { method: "POST", body: JSON.stringify(body) });
    const deploy = async (commitId: string, green: boolean) => {
      const queued = await (await f.request("/deploys", { method: "POST", body: JSON.stringify({ repo: "Owner/Repo", environment: "staging", commitId, submittedBy: "author" }) })).json() as DeployResponse;
      if (green) f.append(queued.operation.id, { type: "deployed", record: { projects: [] } as never });
    };
    const older = "a".repeat(40);
    const newer = "b".repeat(40);
    await deploy(older, true);
    const body = { repo: "Owner/Repo", commitId: older, submittedBy: "author" };
    assert.equal((await verify({ ...body, commitId: newer })).status, 400, "staging is not green on it");
    const first = await (await verify(body)).json() as VerificationResponse;
    assert.equal(first.requested, true);
    assert.equal(first.operation.kind, "verification");
    assert.equal(first.operation.commitId, older);
    const again = await (await verify({ ...body, repo: "owner/repo" })).json() as VerificationResponse;
    assert.equal(again.requested, false);
    assert.equal(again.operation.id, first.operation.id);
    await deploy(newer, true);
    const second = await (await verify({ ...body, commitId: newer })).json() as VerificationResponse;
    assert.equal(second.requested, true);
    assert.equal(f.log.operation(first.operation.id)?.status, "queued", "a newer request does not supersede a queued pre-verification");
    // A newer green deploy superseded the queued one: planning again requests it afresh.
    f.append(first.operation.id, { type: "superseded", by: second.operation.id });
    const renewed = await (await verify(body)).json() as VerificationResponse;
    assert.equal(renewed.requested, true);
    assert.notEqual(renewed.operation.id, first.operation.id);
    for (const invalid of [{ ...body, commitId: "abc" }, { ...body, submittedBy: "" }, { ...body, repo: "" }])
      assert.equal((await verify(invalid)).status, 400);
  } finally {
    await f.close();
  }
});

test("deploy submissions queue a deploy, reattach to the open deploy of the same commit, supersede a queued older one and list records", async () => {
  const f = await fixture();
  try {
    const deploy = (body: unknown) => f.request("/deploys", { method: "POST", body: JSON.stringify(body) });
    const body = { repo: "Owner/Repo", environment: "staging", commitId: "a".repeat(40), submittedBy: "author" };
    const first = await (await deploy(body)).json() as DeployResponse;
    assert.equal(first.reattached, false);
    assert.equal(first.operation.kind, "deploy");
    assert.equal(first.operation.environment, "staging");
    assert.equal(f.submissions, 1);
    const again = await (await deploy({ ...body, repo: "owner/repo" })).json() as DeployResponse;
    assert.equal(again.reattached, true);
    assert.equal(again.operation.id, first.operation.id);
    const newer = await (await deploy({ ...body, commitId: "b".repeat(40) })).json() as DeployResponse;
    assert.equal(newer.reattached, false);
    assert.equal(f.log.operation(first.operation.id)?.status, "superseded");
    for (const invalid of [{ ...body, commitId: "abc" }, { ...body, environment: "Staging!" }, { ...body, submittedBy: "" }])
      assert.equal((await deploy(invalid)).status, 400);
    const appended = f.log.events().length;
    const production = await deploy({ ...body, environment: "production" });
    assert.equal(production.status, 400);
    assert.deepEqual(await production.json(), { error: "production deploys only through slipjay promote" });
    assert.equal(f.log.events().length, appended, "a production deploy appends nothing");
    const listed = await (await f.request("/deploys?repo=Owner/Repo&environment=staging")).json() as { operations: Operation[] };
    assert.deepEqual(listed.operations.map((op) => op.id), [newer.operation.id, first.operation.id]);
    assert.equal((await f.request("/deploys")).status, 400);
  } finally {
    await f.close();
  }
});

test("release listing returns a repository's release operations newest first and needs a repo", async () => {
  const f = await fixture();
  try {
    f.append("release-1", { type: "submitted", kind: "release", repo: "owner/repo", commitId: "a".repeat(40), migrationsReady: true, submittedBy: "author" });
    f.append("release-2", { type: "submitted", kind: "release", repo: "owner/repo", commitId: "b".repeat(40), migrationsReady: false, submittedBy: "author" });
    f.append("deploy-1", { type: "submitted", kind: "deploy", repo: "owner/repo", environment: "staging", commitId: "c".repeat(40), submittedBy: "author" });
    const listed = await (await f.request("/releases?repo=Owner/Repo")).json() as { operations: Operation[] };
    assert.deepEqual(listed.operations.map((op) => [op.id, op.kind]), [["release-2", "release"], ["release-1", "release"]]);
    assert.equal((await f.request("/releases")).status, 400);
  } finally {
    await f.close();
  }
});

test("reset submissions need a landed repository, reattach to its open reset and list newest first", async () => {
  const f = await fixture();
  try {
    const reset = (body: unknown) => f.request("/resets", { method: "POST", body: JSON.stringify(body) });
    const unlanded = await reset({ repo: "Owner/Repo", submittedBy: "author" });
    assert.equal(unlanded.status, 400);
    assert.match((await unlanded.json() as { error: string }).error, /owner\/repo has not landed on this runner yet/);
    f.append("landing", { type: "submitted", repo: "owner/repo", changeId, commitId: "a".repeat(40), bookmark: candidateBookmark(changeId), submittedBy: "author" });
    f.append("landing", { type: "landed", base: "base", commitId: "a".repeat(40), branch: "main", remote: "origin" });
    const first = await (await reset({ repo: "Owner/Repo", submittedBy: "author" })).json() as ResetResponse;
    assert.equal(first.reattached, false);
    assert.equal(first.operation.kind, "reset");
    assert.equal(first.operation.commitId, "a".repeat(40), "it is labelled with the last landed commit");
    assert.equal(f.submissions, 1);
    const again = await (await reset({ repo: "owner/repo", submittedBy: "other" })).json() as ResetResponse;
    assert.deepEqual([again.reattached, again.operation.id], [true, first.operation.id]);
    assert.equal(f.submissions, 1);
    f.append(first.operation.id, { type: "failed", stage: "resetting", reason: "Reset command failed" });
    const next = await (await reset({ repo: "owner/repo", submittedBy: "author" })).json() as ResetResponse;
    assert.equal(next.reattached, false);
    for (const invalid of [{ repo: "owner/repo" }, { repo: "", submittedBy: "author" }])
      assert.equal((await reset(invalid)).status, 400);
    const listed = await (await f.request("/resets?repo=Owner/Repo")).json() as { operations: Operation[] };
    assert.deepEqual(listed.operations.map((op) => op.id), [next.operation.id, first.operation.id]);
    assert.equal((await f.request("/resets")).status, 400);
  } finally {
    await f.close();
  }
});

test("global event feed sees API appends and exports bounded cursor ranges", async () => {
  const f = await fixture();
  try {
    const snapshot = await (await f.request("/queue")).json() as { version: number; seq: number };
    assert.equal(snapshot.version, 1);
    const response = await f.request(`/metrics/events?since=${snapshot.seq}`, { headers: { accept: "text/event-stream" } });
    const reader = response.body!.getReader();
    const created = await (await f.submit()).json() as SubmitResponse;
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: stored/); assert.match(first, /submitted/);
    const cancelled = await f.request(`/operations/${created.operation.id}/cancel`, { method: "POST", body: JSON.stringify({ by: "owner-mac" }) });
    assert.equal(cancelled.status, 200);
    const second = new TextDecoder().decode((await reader.read()).value);
    assert.match(second, /owner-mac/);
    await reader.cancel();
    const exported = await (await f.request("/metrics/events?since=0&limit=1")).json() as { events: StoredEvent[]; hasMore: boolean; nextSeq: number };
    assert.equal(exported.events.length, 1); assert.equal(exported.hasMore, true); assert.equal(exported.nextSeq, exported.events[0]!.seq);
    for (const query of ["since=-1", "since=1.2", "limit=0", "limit=1001", "since=9007199254740992"]) assert.equal((await f.request(`/metrics/events?${query}`)).status, 400);
  } finally { await f.close(); }
});

test("global feed closes a slow consumer and releases its durable subscription", async () => {
  const log = openOperationLog(":memory:");
  let active = 0;
  const subscribe = log.subscribe.bind(log);
  log.subscribe = (listener) => { active++; const stop = subscribe(listener); return () => { active--; stop(); }; };
  try {
    const handler = createRunnerHandler({ log, token, runnerName: "r", readLog: async () => null, onSubmitted() {}, kill: () => ({ status: "idle" }), subscribe });
    const request = () => new Request("http://localhost/v1/metrics/events?since=0", { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } });
    const response = await handler(request());
    assert.equal(active, 1);
    for (let n = 0; n < 1001; n++) log.append("control", { type: "paused", by: "owner" });
    assert.equal(active, 0);
    const replay = await handler(request());
    const reader = replay.body!.getReader();
    let count = 0;
    while (!(await reader.read()).done) count++;
    assert.equal(count, 1000);
    assert.equal(active, 0);
    const controller = new AbortController();
    const live = await handler(new Request("http://localhost/v1/metrics/events?since=1001", { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: controller.signal }));
    assert.equal(active, 1); controller.abort(); assert.equal(active, 0);
    await live.body!.cancel();
    await response.body!.cancel();
  } finally { log.close(); }
});

test("snapshot cursor replays the append between snapshot and stream and the subscription handover", async () => {
  const log = openOperationLog(":memory:");
  const subscribe = log.subscribe.bind(log);
  let injected = false;
  log.subscribe = (listener) => {
    const stop = subscribe(listener);
    if (!injected) { injected = true; log.append("control", { type: "paused", by: "during-subscribe" }); }
    return stop;
  };
  try {
    const handler = createRunnerHandler({ log, token, runnerName: "r", readLog: async () => null, onSubmitted() {}, kill: () => ({ status: "idle" }), subscribe });
    const snapshot = log.snapshot("r");
    log.append("control", { type: "paused", by: "between" });
    const response = await handler(new Request(`http://localhost/v1/metrics/events?since=${snapshot.seq}`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } }));
    const reader = response.body!.getReader();
    const decode = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value).split("data: ")[1]!) as StoredEvent;
    const first = await decode(); const second = await decode();
    assert.equal(first.seq, 1); assert.equal(second.seq, 2);
    log.append("control", { type: "resumed", by: "live" });
    assert.equal((await decode()).seq, 3);
    await reader.cancel();
    assert.equal((await handler(new Request("http://localhost/v1/metrics/events?since=99", { headers: { authorization: `Bearer ${token}` } }))).status, 409);
  } finally { log.close(); }
});

test("cancel rechecks state after a delayed request body", async () => {
  const log = openOperationLog(":memory:");
  try {
    const handler = createRunnerHandler({ log, token, runnerName: "r", readLog: async () => null, onSubmitted() {}, kill: () => ({ status: "idle" }), subscribe: log.subscribe });
    for (const stage of ["verifying", "publishing"] as const) {
      log.append(stage, { type: "submitted", ...submission() });
      let release!: () => void;
      let reading!: () => void;
      const started = new Promise<void>((resolve) => { reading = resolve; });
      const delayed = new Promise<void>((resolve) => { release = resolve; });
      const request = new Request(`http://localhost/v1/operations/${stage}/cancel`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
      Object.defineProperty(request, "text", { value: async () => { reading(); await delayed; return JSON.stringify({ by: "owner" }); } });
      const pending = handler(request);
      await started;
      log.append(stage, { type: "stage", stage });
      release();
      assert.equal((await pending).status, 409);
      assert.equal(log.events({ operationId: stage }).some((event) => event.event.type === "cancelled"), false);
    }
  } finally { log.close(); }
});


test("request replay survives terminal failure and a SQLite/server restart without a new attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "sj-request-"));
  const path = join(root, "ledger.sqlite");
  const body = { ...submission("a".repeat(40)), requestId: randomUUID() };
  let f = await fixture(path);
  try {
    const first = await submitted(await f.submit(body));
    f.append(first.operation.id, { type: "failed", stage: "verifying", reason: "fixture assertion failed" });
    await f.close();
    f = await fixture(path);
    const replay = await submitted(await f.submit(body));
    assert.equal(replay.operation.id, first.operation.id);
    assert.equal(replay.operation.status, "failed");
    assert.equal(replay.reattached, true);
    assert.equal(replay.requestId, body.requestId);
    assert.equal(f.submissions, 0);
    const conflict = await f.submit({ ...body, commitId: "b".repeat(40) });
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json() as { error: string }).error, /another candidate/);
    assert.equal(f.log.events().filter((row) => row.event.type === "submitted").length, 1);
    const retry = await submitted(await f.submit({ ...body, requestId: randomUUID() }));
    assert.notEqual(retry.operation.id, first.operation.id);
  } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
});

test("concurrent matching request identities attach to one operation and invalid identities are refused", async () => {
  const f = await fixture();
  try {
    const body = { ...submission("a".repeat(40)), requestId: randomUUID() };
    const responses = await Promise.all([f.submit(body), f.submit(body)]);
    const results = await Promise.all(responses.map(submitted));
    assert.equal(results[0]!.operation.id, results[1]!.operation.id);
    assert.equal(f.submissions, 1);
    for (const requestId of ["short", "x".repeat(129), "x".repeat(16) + "/path", 123])
      assert.equal((await f.request("/operations", { method: "POST", body: JSON.stringify({ ...submission(), requestId }) })).status, 400);
  } finally { await f.close(); }
});


test("request replay preserves cancellation, supersession, publication and held integration", async () => {
  const f = await fixture();
  try {
    const endings: OperationEvent[][] = [
      [{ type: "cancelled", reason: "killed by the owner" }],
      [{ type: "superseded", by: "newer-attempt" }],
      [{ type: "landed", base: "base", commitId: "published", branch: "main", remote: "origin" }],
      [{ type: "stage", stage: "publishing" }, { type: "integrated", base: "base", commitId: "held" }],
    ];
    for (const [index, ending] of endings.entries()) {
      const body = { ...submission(String(index + 1).repeat(40), String.fromCharCode(107 + index).repeat(32)), requestId: randomUUID() };
      const first = await submitted(await f.submit(body));
      for (const event of ending) f.append(first.operation.id, event);
      const before = f.log.operation(first.operation.id);
      const replay = await submitted(await f.submit(body));
      assert.equal(replay.operation.id, first.operation.id);
      assert.deepEqual(replay.operation, before);
      assert.equal(replay.reattached, true);
    }
    assert.equal(f.submissions, endings.length);
  } finally { await f.close(); }
});

test("relanding a commit whose integration is held follows the hold's recovery instead of submitting again", async () => {
  const f = await fixture();
  try {
    const body = { ...submission("a".repeat(40)), requestId: randomUUID() };
    const first = await submitted(await f.submit(body));
    f.append(first.operation.id, { type: "stage", stage: "publishing" });
    f.append(first.operation.id, { type: "integrated", base: "base", commitId: "held" });
    f.append(first.operation.id, { type: "integration_held", repo: "owner/repo", commitId: "held", reason: "remote unavailable" });
    f.append(first.operation.id, { type: "failed", stage: "publishing", reason: "remote unavailable" });
    const recovery = f.log.append("recovery-op", { type: "submitted", kind: "recovery", repo: "owner/repo", commitId: "held", submittedBy: "runner:recovery" });
    assert.equal(recovery.operationId, "recovery-op");
    let asked = 0;
    f.recoverHeld = () => { asked++; return f.log.operation("recovery-op"); };
    // A later request identity for the same commit gets the recovery, not a second landing for Build to refuse.
    const again = await submitted(await f.submit({ ...body, requestId: randomUUID() }));
    assert.equal(again.operation.id, "recovery-op");
    assert.equal(again.reattached, true);
    assert.equal(asked, 1);
    // The original request identity, retried after its response was lost, follows the recovery rather than the failure it already got.
    const retried = await submitted(await f.submit(body));
    assert.equal(retried.operation.id, "recovery-op");
    assert.equal(asked, 2);
    assert.equal(f.log.operationsForChange("owner/repo", changeId).length, 1);
    // Another commit of the change is not the held one.
    f.recoverHeld = () => { throw new Error("must not recover for another commit"); };
    const other = await submitted(await f.submit({ ...submission("b".repeat(40)), requestId: randomUUID() }));
    assert.notEqual(other.operation.id, "recovery-op");
  } finally { await f.close(); }
});

test("submission acknowledgement waits for retained source and retention failure never supersedes queued work", async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const retained = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const f = await fixture(":memory:", async (_id, body) => {
    if (++calls === 1) { started(); await retained; }
    else throw new Error("fixture storage failure");
    return { type: "source_retained", commitId: body.commitId, sourceRef: "refs/slipjay/fixture", manifestSha256: "a".repeat(64), handoffComplete: false };
  });
  try {
    const response = f.submit({ ...submission("a".repeat(40)), requestId: randomUUID() });
    await entered;
    assert.equal(f.log.openOperations().length, 0);
    assert.equal(f.submissions, 0);
    release();
    const accepted = await submitted(await response);
    const events = f.log.events({ operationId: accepted.operation.id });
    assert.ok(events.some((row) => row.event.type === "source_retained"));
    assert.ok(events.findIndex((row) => row.event.type === "source_retained") < events.findIndex((row) => row.event.type === "submission_request"));
    const failed = await f.submit({ ...submission("b".repeat(40)), requestId: randomUUID() });
    assert.equal(failed.status, 503);
    assert.equal(f.log.operation(accepted.operation.id)?.status, "queued");
    assert.equal(f.log.events().filter((row) => row.event.type === "submitted").length, 1);
    assert.equal(f.submissions, 1);
  } finally { release(); await f.close(); }
});

test("retention rechecks a queued predecessor that starts or is cancelled during capture", async () => {
  for (const transition of ["running", "cancelled"] as const) {
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const f = await fixture(":memory:", async (_id, body) => {
      if (++calls === 2) { started(); await wait; }
      return { type: "source_retained", commitId: body.commitId, sourceRef: "refs/slipjay/fixture", manifestSha256: "a".repeat(64), handoffComplete: false };
    });
    try {
      const first = await submitted(await f.submit(submission("a".repeat(40))));
      const next = f.submit({ ...submission("b".repeat(40)), requestId: randomUUID() });
      await entered;
      f.append(first.operation.id, transition === "running" ? { type: "stage", stage: "verifying" } : { type: "cancelled", reason: "owner cancelled" });
      release();
      const response = await next;
      assert.equal(response.status, transition === "running" ? 409 : 200);
      assert.equal(f.log.operation(first.operation.id)?.status, transition);
      assert.equal(f.log.events({ operationId: first.operation.id }).some((row) => row.event.type === "superseded"), false);
      if (transition === "running") {
        assert.equal((await response.json() as { operation: Operation }).operation.id, first.operation.id);
        assert.equal(f.submissions, 1);
      } else assert.equal(f.submissions, 2);
    } finally { release(); await f.close(); }
  }
});


test("handoff admission binds immutable author evidence and refuses changed replay, invalid snapshots and oversized bodies", async () => {
  const f = await fixture();
  try {
    const handoff = { version: 1 as const, source: "a".repeat(40), intent: "Repair a failed gate", scope: ["src"], spec: null,
      helpers: [], checks: [], reviews: [], toolchain: [], gaps: ["Independent review missing"] };
    const body = { ...submission(handoff.source), requestId: "handoff-request-identity", handoff };
    const first = await submitted(await f.submit(body));
    assert.equal((await submitted(await f.submit(body))).operation.id, first.operation.id);
    assert.equal((await f.submit({ ...body, handoff: { ...handoff, intent: "changed" } })).status, 409);
    assert.equal((await f.submit({ ...body, requestId: "another-request-identity", handoff: { ...handoff, intent: "changed" } })).status, 409);
    assert.equal((await f.submit({ ...body, handoff: { ...handoff, source: "b".repeat(40) } })).status, 400);
    assert.equal((await f.request("/operations", { method: "POST", body: JSON.stringify({ ...body, padding: "x".repeat(75000) }) })).status, 400);
    assert.equal(f.submissions, 1);
    assert.equal((await f.request(`/operations/${first.operation.id}/handoff`)).status, 501);
    assert.equal((await f.request(`/operations/${first.operation.id}/source`)).status, 501);
    const legacyChange = "z".repeat(32);
    const withoutRequestId = { ...submission(handoff.source, legacyChange), handoff };
    await submitted(await f.submit(withoutRequestId));
    assert.equal((await f.submit({ ...withoutRequestId, handoff: { ...handoff, intent: "changed" } })).status, 409);
  } finally { await f.close(); }
});
