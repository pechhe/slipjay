import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "vite-plus/test";
import { buildAdmitter, buildRoute } from "../src/lib/build-admission.ts";
import type { BuildAdmission, BuildAdmissionRequest } from "../src/lib/build-admission.ts";
import { createRunnerHandler } from "../src/lib/runner-api.ts";
import { candidateBookmark, RUNNER_API } from "../src/lib/runner-contract.ts";
import type { Operation, SubmitRequest } from "../src/lib/runner-contract.ts";
import { openOperationLog } from "../src/lib/runner-log.ts";
import type { BuildBinding, SubmissionHandoff } from "../src/lib/submission-handoff.ts";

const token = "runner-secret";
const changeId = "k".repeat(32);
const binding: BuildBinding = { specId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", ticketIds: ["11111111-2222-4333-8444-555555555555"],
  bodyRevision: 4, bindGeneration: 2, sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" };
const handoff = (commitId: string, build: BuildBinding | null = binding): SubmissionHandoff => ({ version: 1, source: commitId, intent: "Bound work",
  scope: [], spec: null, helpers: [{ revision: "b".repeat(40), base: "c".repeat(40), scope: "tests" }, { revision: "b".repeat(40), base: "d".repeat(40), scope: "docs" }],
  checks: [], reviews: [], toolchain: [], gaps: [], ...build ? { build } : {} });
const submission = (commitId = "a".repeat(40), extra: Partial<SubmitRequest> = {}): SubmitRequest => ({ repo: "owner/repo", changeId, commitId,
  bookmark: candidateBookmark(changeId), submittedBy: "author", handoff: handoff(commitId), ...extra });

/** The handler with a controlled Build: each admission takes the next scripted answer. */
function fixture(answers: BuildAdmission[] | null) {
  const log = openOperationLog(":memory:");
  const offered: BuildAdmissionRequest[] = [];
  let woken = 0, unresolved = 0;
  const handler = createRunnerHandler({
    log, token, runnerName: "test-runner", readLog: () => Promise.resolve(""), onSubmitted: () => { woken++; }, onAdmissionUnresolved: () => { unresolved++; },
    kill: () => ({ status: "idle" }), subscribe: () => () => {},
    ...answers ? { admitBuild: (request: BuildAdmissionRequest) => { offered.push(request); return Promise.resolve(answers.shift() ?? { outcome: "unavailable", reason: "unscripted" }); } } : {},
  });
  const submit = async (body: SubmitRequest) => {
    const response = await handler(new Request(`http://runner${RUNNER_API}/operations`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() as { operation?: Operation; error?: string; retryable?: boolean; superseded?: string } };
  };
  return { log, offered, answers, submit, get woken() { return woken; }, get unresolved() { return unresolved; } };
}
const admitted = (request?: Partial<BuildAdmissionRequest>): BuildAdmission => ({ outcome: "admitted", sequence: request?.sequence ?? 0, sessionId: binding.sessionId, recordedAt: "2026-10-15T21:00:00.000Z" });

test("Build admits a bound submission at its submitted sequence before the queue may start it", async () => {
  const g = fixture([admitted()]);
  const { status, body } = await g.submit(submission());
  assert.equal(status, 200);
  const operation = body.operation!;
  assert.ok(operation.kind === "landing" && operation.admission === "admitted" && operation.status === "queued");
  assert.equal(operation.position, 1);
  const recorded = g.log.events({ operationId: operation.id });
  const submitted = recorded.find((row) => row.event.type === "submitted")!;
  assert.deepEqual(g.offered, [{ repository: "owner/repo", operationId: operation.id, sequence: submitted.seq, occurredAt: submitted.at,
    specId: binding.specId, ticketIds: binding.ticketIds, specBodyRevision: 4, specBodyHash: null, candidateRevision: "a".repeat(40), baseRevision: null,
    helperRevisions: ["b".repeat(40)], repairsOperationId: null, bindGeneration: 2, sessionId: binding.sessionId, supersedesOperationId: null }]);
  // Admission is recorded after `submitted`, and only then is the queue woken.
  assert.ok(recorded.findIndex((row) => row.event.type === "build_admitted") > recorded.indexOf(submitted));
  assert.equal(g.woken, 1);
  g.log.close();
});

test("Build's refusals end the operation without running it and name Build's code", async () => {
  for (const code of ["bind_generation_stale", "admission_session_invalid", "delivery_pending", "attempt_fact_conflict"]) {
    const f = fixture([{ outcome: "refused", code }]);
    const { status, body } = await f.submit(submission());
    assert.equal(status, 200);
    assert.equal(body.operation!.status, "declined");
    const result = body.operation!.result;
    assert.ok(result?.type === "declined" && result.build?.code === code && result.reason.includes(code));
    // Only another delivery in Build's custody is worth retrying unchanged later.
    assert.equal(result.build.retryable, code === "delivery_pending");
    if (code === "delivery_pending") assert.match(result.reason, /land again once it has finished/);
    assert.equal(f.log.openOperations().length, 0);
    f.log.close();
  }
});

test("Build unavailable leaves the submission unqueued, and resubmitting replays the same admission into one operation", async () => {
  const f = fixture([{ outcome: "unavailable", reason: "Build did not answer in time" }]);
  const requestId = "request-0123456789abcdef";
  const first = await f.submit(submission(undefined, { requestId }));
  assert.equal(first.status, 503);
  assert.equal(first.body.retryable, true);
  assert.match(first.body.error!, /did not answer in time.*slipjay land again/);
  const pending = f.log.operationsForChange("owner/repo", changeId);
  assert.equal(pending.length, 1);
  assert.ok(pending[0]!.admission === "pending" && pending[0]!.status === "queued" && pending[0]!.position === undefined && pending[0]!.waitingFor === "Build admission");
  assert.equal(f.woken, 0);
  // A lost response: the author resubmits the same request, and the runner resends the identical fact.
  f.answers!.push(admitted({ sequence: f.offered[0]!.sequence }));
  const second = await f.submit(submission(undefined, { requestId }));
  assert.equal(second.status, 200);
  assert.equal(second.body.operation!.id, pending[0]!.id);
  assert.ok(second.body.operation!.kind === "landing" && second.body.operation!.admission === "admitted");
  assert.deepEqual(f.offered[1], f.offered[0]);
  assert.equal(f.log.operationsForChange("owner/repo", changeId).length, 1);
  assert.equal(f.woken, 1);
  f.log.close();
});

test("without a request identity, the same pending candidate retries its admission instead of opening a second operation", async () => {
  const f = fixture([{ outcome: "unavailable", reason: "Build could not be reached" }, admitted()]);
  assert.equal((await f.submit(submission())).status, 503);
  const second = await f.submit(submission());
  assert.equal(second.status, 200);
  assert.deepEqual(f.offered[1], f.offered[0]);
  assert.equal(f.log.operationsForChange("owner/repo", changeId).length, 1);
  f.log.close();
});

test("a newer candidate names the queued one it supersedes, first resolving an admission that never got an answer", async () => {
  const answers: BuildAdmission[] = [admitted(), admitted()];
  const f = fixture(answers);
  const first = (await f.submit(submission("a".repeat(40)))).body.operation!;
  const second = await f.submit(submission("e".repeat(40)));
  assert.equal(second.status, 200);
  assert.equal(second.body.superseded, first.id);
  assert.equal(f.offered[1]!.supersedesOperationId, first.id);
  assert.equal(f.log.operation(first.id)!.status, "superseded");
  // Build admitted A but its answer was lost: B's submission resends A's admission first, so B names A.
  const g = fixture([{ outcome: "unavailable", reason: "Build could not be reached" }, admitted(), admitted()]);
  const unknown = await g.submit(submission("a".repeat(40)));
  assert.equal(unknown.status, 503);
  const a = unknown.body.operation!.id;
  const b = await g.submit(submission("e".repeat(40)));
  assert.equal(b.status, 200);
  assert.deepEqual(g.offered[1], g.offered[0]);
  assert.equal(g.offered[2]!.supersedesOperationId, a);
  assert.equal(g.log.operation(a)!.status, "superseded");
  // While A's admission stays unanswered, B is refused as retryable and A is left as it was.
  const h = fixture([{ outcome: "unavailable", reason: "Build could not be reached" }, { outcome: "unavailable", reason: "Build could not be reached" }]);
  const pendingA = (await h.submit(submission("a".repeat(40)))).body.operation!.id;
  const refusedB = await h.submit(submission("e".repeat(40)));
  assert.equal(refusedB.status, 503);
  assert.match(refusedB.body.error!, /earlier candidate's admission is unresolved/);
  assert.equal(h.log.operationsForChange("owner/repo", changeId).length, 1);
  assert.ok(h.log.operation(pendingA)!.kind === "landing" && (h.log.operation(pendingA) as { admission?: string }).admission === "pending");
  f.log.close(); g.log.close(); h.log.close();
});

test("a newer candidate replaces the admitted queued one only once Build admits it; refused or unanswered, that one keeps its place", async () => {
  // Refused (a stale bind): nothing is lost, and the admitted candidate still runs.
  const f = fixture([admitted(), { outcome: "refused", code: "bind_generation_stale" }]);
  const a = (await f.submit(submission("a".repeat(40)))).body.operation!.id;
  const stale = await f.submit(submission("e".repeat(40)));
  assert.equal(stale.body.operation!.status, "declined");
  assert.equal(stale.body.superseded, undefined);
  assert.equal(f.offered[1]!.supersedesOperationId, a);
  const kept = f.log.operation(a)!;
  assert.ok(kept.status === "queued" && kept.position === 1 && kept.waitingFor === undefined);
  // Unanswered: the admitted candidate neither runs nor is superseded until Build answers, and the drain is asked to keep offering.
  const g = fixture([admitted(), { outcome: "unavailable", reason: "Build could not be reached" }, admitted()]);
  const first = (await g.submit(submission("a".repeat(40)))).body.operation!.id;
  assert.equal((await g.submit(submission("e".repeat(40)))).status, 503);
  assert.equal(g.unresolved, 1);
  const waiting = g.log.operation(first)!;
  assert.ok(waiting.status === "queued" && waiting.position === undefined && waiting.waitingFor === "Build admission of a newer candidate");
  // Admitted on a later offer: only now is the earlier candidate superseded.
  const retried = await g.submit(submission("e".repeat(40)));
  assert.ok(retried.body.operation!.kind === "landing" && retried.body.operation!.admission === "admitted");
  assert.equal(g.log.operation(first)!.status, "superseded");
  f.log.close(); g.log.close();
});

test("a runner without Build configuration refuses bound submissions and still accepts unbound ones", async () => {
  const f = fixture(null);
  const refused = await f.submit(submission());
  assert.equal(refused.status, 400);
  assert.match(refused.body.error!, /build\.origin.*YARDSMITH_SLIPJAY_BUILD_TOKEN/);
  assert.equal(f.log.operationsForChange("owner/repo", changeId).length, 0);
  const plain = await f.submit(submission(undefined, { handoff: handoff("a".repeat(40), null) }));
  assert.equal(plain.status, 200);
  assert.equal(plain.body.operation!.kind === "landing" && plain.body.operation!.admission, undefined);
  assert.equal(f.woken, 1);
  f.log.close();
});

test("the Build route client maps answers, sends the runner credential and gives up after its bound", async () => {
  let reply: { status: number; body: unknown; delayMs?: number } = { status: 200, body: {} };
  // How Build answers the reads of the admitted items that follow an admission.
  let items: { status: number; body: unknown } | null = null;
  const seen: { authorization?: string; body: unknown }[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      const body = JSON.parse(text) as { action: string; input: { itemId?: string } };
      seen.push({ authorization: request.headers.authorization, body });
      const answer = body.action === "read" ? items ?? { status: 200, body: { status: "succeeded", value: { id: body.input.itemId, number: body.input.itemId === binding.specId ? 40 : 41, kind: "spec" } } } : reply;
      setTimeout(() => { response.writeHead(answer.status, { "content-type": "application/json" }); response.end(JSON.stringify(answer.body)); }, body.action === "read" ? 0 : reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const admit = buildAdmitter(buildRoute({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token, timeoutMs: 300 }));
    const ticketId = "cccccccc-dddd-4eee-8fff-000000000000";
    const request = { repository: "owner/repo", operationId: "op", sequence: 7, occurredAt: "2026-10-15T21:00:00.000Z", specId: binding.specId, ticketIds: [ticketId],
      specBodyRevision: null, specBodyHash: null, candidateRevision: "a".repeat(40), baseRevision: null, helperRevisions: [], repairsOperationId: null,
      bindGeneration: 2, sessionId: binding.sessionId, supersedesOperationId: null } satisfies BuildAdmissionRequest;
    reply = { status: 200, body: { status: "succeeded", value: { admission: { sessionId: binding.sessionId, sequence: 7, recordedAt: "2026-10-15T21:00:01.000Z" } } } };
    assert.deepEqual(await admit(request), { outcome: "admitted", sequence: 7, sessionId: binding.sessionId, recordedAt: "2026-10-15T21:00:01.000Z",
      items: { specNumber: 40, ticketNumbers: [41] } });
    assert.deepEqual(seen[0], { authorization: `Bearer ${token}`, body: { action: "admitAttempt", input: request } });
    assert.deepEqual(seen.slice(1).map((row) => row.body), [{ action: "read", input: { itemId: binding.specId } }, { action: "read", input: { itemId: ticketId } }]);
    // Admitted but its items unread, the admission is unresolved, and resending it replays.
    items = { status: 503, body: { status: "unavailable", code: "database_unavailable" } };
    assert.match(JSON.stringify(await admit(request)), /"outcome":"unavailable","reason":"the admitted items could not be read/);
    items = null;
    reply = { status: 200, body: { status: "duplicate", code: "replayed" } };
    assert.equal((await admit(request)).outcome, "admitted");
    reply = { status: 409, body: { status: "blocked", code: "delivery_pending" } };
    assert.deepEqual(await admit(request), { outcome: "refused", code: "delivery_pending" });
    reply = { status: 422, body: { status: "invalid", code: "attempt_ticket_invalid" } };
    assert.deepEqual(await admit(request), { outcome: "refused", code: "attempt_ticket_invalid" });
    reply = { status: 413, body: { status: "invalid", code: "runner_body_too_large" } };
    assert.deepEqual(await admit(request), { outcome: "refused", code: "runner_body_too_large" });
    reply = { status: 503, body: { status: "unavailable", code: "database_unavailable" } };
    assert.equal((await admit(request)).outcome, "unavailable");
    reply = { status: 401, body: { status: "unauthorised", code: "runner_unauthenticated" } };
    assert.deepEqual(await admit(request), { outcome: "unavailable", reason: "Build refused the runner's credential" });
    reply = { status: 200, body: { status: "succeeded", value: {} }, delayMs: 2_000 };
    const started = Date.now();
    assert.deepEqual(await admit(request), { outcome: "unavailable", reason: "Build did not answer in time" });
    assert.ok(Date.now() - started < 1_500);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a declared chore is queued without admission and keeps its title for the chore receipt; without Build configuration it is refused", async () => {
  const chore = { ...handoff("a".repeat(40), null), build: { unassociated: true as const } };
  const f = fixture([]);
  const { status, body } = await f.submit(submission(undefined, { handoff: chore }));
  assert.equal(status, 200);
  assert.equal(f.offered.length, 0);
  assert.ok(body.operation!.kind === "landing" && body.operation!.admission === undefined && body.operation!.position === 1);
  const submitted = f.log.events({ operationId: body.operation!.id }).find((row) => row.event.type === "submitted")!.event;
  assert.ok(submitted.type === "submitted" && submitted.kind === undefined);
  assert.deepEqual("chore" in submitted && submitted.chore, { title: "Bound work", helperRevisions: ["b".repeat(40)] });
  assert.equal(f.woken, 1);
  const g = fixture(null);
  assert.equal((await g.submit(submission(undefined, { handoff: chore }))).status, 400);
  f.log.close(); g.log.close();
});
