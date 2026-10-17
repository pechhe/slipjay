import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import type { BuildAdmissionRequest, BuildRoute, BuildRouteAnswer } from "../src/lib/build-admission.ts";
import { createReceiptDrain } from "../src/lib/build-receipts.ts";
import type { BuildChoreInput, BuildReceiptInput, BuildRunInput } from "../src/lib/build-receipts.ts";
import { candidateBookmark, RUNNER_CONTROL_ID } from "../src/lib/runner-contract.ts";
import type { OperationLog } from "../src/lib/runner-contract.ts";
import { newOperationId, openOperationLog } from "../src/lib/runner-log.ts";

const binding = { specId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", ticketIds: ["11111111-2222-4333-8444-555555555555"], bodyRevision: 3, bindGeneration: 2,
  sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" };
const admission = { binding, specBodyHash: "f".repeat(64), helperRevisions: [], repairsOperationId: null, supersedes: null };

/** One landing in the ledger, admitted by Build unless `bound` says otherwise, ending as `end` says. */
function landing(log: OperationLog, change: string, end: "landed" | "failed" | "open", bound: "admitted" | "pending" | "refused" | "unbound" = "admitted") {
  const id = newOperationId();
  const commitId = change.repeat(40).slice(0, 40);
  log.append(id, { type: "submitted", repo: "owner/repo", changeId: change.repeat(32).slice(0, 32), commitId, bookmark: candidateBookmark(change.repeat(32).slice(0, 32)),
    submittedBy: "author", ...bound === "unbound" ? {} : { admission } });
  if (bound === "refused") { log.append(id, { type: "declined", reason: "Build refused admission: bind_generation_stale", paths: [], build: { code: "bind_generation_stale", retryable: false } }); return id; }
  if (bound === "admitted") log.append(id, { type: "build_admitted", sequence: 1, sessionId: binding.sessionId, recordedAt: null });
  log.append(id, { type: "stage", stage: "verifying" });
  log.append(id, { type: "verification_base", base: "b".repeat(40) });
  log.append(id, { type: "run_started", runId: `${id}-gate`, command: "vp test", host: "test" });
  log.append(id, { type: "run_finished", runId: `${id}-gate`, exitCode: end === "failed" ? 1 : 0, signal: null, timedOut: false, durationMs: 5 });
  if (end === "landed") {
    log.append(id, { type: "verification_passed", base: "b".repeat(40), candidate: "c".repeat(40) });
    log.append(id, { type: "landed", base: "b".repeat(40), commitId: "d".repeat(40), branch: "main", remote: "origin" });
  } else if (end === "failed") log.append(id, { type: "failed", stage: "verifying", reason: "gate failed", command: "vp test", output: "1 failing" });
  return id;
}

/** A controlled Build: records each fact once per (operation, sequence), and answers as `answer` (and `admit`) says. */
function fakeBuild(answer: (input: BuildReceiptInput, call: number) => BuildRouteAnswer | "lost" = () => ({ kind: "accepted", value: null }),
  admit: (input: BuildAdmissionRequest) => BuildRouteAnswer = () => ({ kind: "accepted", value: { admission: { recordedAt: null } } })) {
  const sent: BuildReceiptInput[] = [];
  const admissions: BuildAdmissionRequest[] = [];
  const recorded = new Map<string, BuildReceiptInput>();
  const runs: BuildRunInput[] = [], chores: BuildChoreInput[] = [];
  const route: BuildRoute = (action, input) => {
    // Build reads a run's source from the attempt fact it attaches to, so that fact must exist first.
    if (action === "recordAttemptRun") {
      const run = input as BuildRunInput;
      if (![...recorded.values()].some((fact) => fact.operationId === run.operationId && fact.sequence === run.sequence)) return Promise.resolve({ kind: "unavailable", reason: "run_attempt_unavailable" });
      runs.push(run);
      return Promise.resolve({ kind: "accepted", value: null });
    }
    if (action === "recordChoreLanding") { chores.push(input as BuildChoreInput); return Promise.resolve({ kind: "accepted", value: null }); }
    if (action === "admitAttempt") { admissions.push(input as BuildAdmissionRequest); return Promise.resolve(admit(input as BuildAdmissionRequest)); }
    // The admitter reads the numbers of the items it admitted.
    if (action === "read") return Promise.resolve({ kind: "accepted", value: { id: (input as { itemId: string }).itemId, number: 1, kind: "spec" } });
    assert.equal(action, "recordAttempt");
    const receipt = input as BuildReceiptInput;
    sent.push(receipt);
    const reply = answer(receipt, sent.length);
    if (reply === "lost" || reply.kind === "accepted") recorded.set(`${receipt.operationId}:${receipt.sequence}`, receipt);
    return Promise.resolve(reply === "lost" ? { kind: "unavailable", reason: "Build did not answer in time" } : reply);
  };
  return { route, sent, recorded, runs, chores, admissions };
}
/** Settled attempt facts of `id`; its runs' settlements, keyed by their `run_started` sequence, are left out. */
const settled = (log: OperationLog, id: string) => {
  const events = log.events({ operationId: id });
  const runs = new Set(events.filter((row) => row.event.type === "run_started").map((row) => row.seq));
  return events.filter((row) => row.event.type === "build_receipt" && !runs.has(row.event.sequence)).map((row) => row.event);
};
const until = (condition: () => unknown) => vi.waitFor(() => assert.ok(condition()), { timeout: 10_000, interval: 10 });

test("receipts carry the admitted source tuple and each fact's own sequence and revisions", async () => {
  const log = openOperationLog(":memory:");
  const landed = landing(log, "a", "landed");
  const failed = landing(log, "e", "failed");
  const build = fakeBuild();
  const drain = createReceiptDrain({ log, route: build.route });
  drain.wake(); await drain.idle();
  const [published, failure] = build.sent;
  const landedRow = log.events({ operationId: landed }).find((row) => row.event.type === "landed")!;
  assert.deepEqual(published, { repository: "owner/repo", operationId: landed, sequence: landedRow.seq, occurredAt: landedRow.at, specId: binding.specId,
    ticketIds: binding.ticketIds, specBodyRevision: 3, specBodyHash: "f".repeat(64), candidateRevision: "a".repeat(40), baseRevision: "b".repeat(40),
    helperRevisions: [], repairsOperationId: null, event: "published", bindGeneration: 2, verifiedRevision: "c".repeat(40), publishedRevision: "d".repeat(40), failure: null });
  assert.equal(failure!.event, "failed");
  assert.equal(failure!.candidateRevision, "e".repeat(40));
  assert.deepEqual(failure!.failure, { stage: "verifying", cause: "gate failed", command: "vp test", excerpt: "1 failing",
    exit: { code: 1, signal: null, timedOut: false, cancelled: false }, checks: { passed: [], failed: ["vp test"], skipped: [], incomplete: [] },
    artifacts: [`slipjay runner log ${failed}`], truncated: false, recovery: "code_repair" });
  assert.deepEqual(settled(log, landed), [{ type: "build_receipt", sequence: landedRow.seq, state: "delivered" }]);
  drain.close(); log.close();
});

test("Build down then up: receipts wait, the outage is visible, and they catch up in ledger order", async () => {
  const log = openOperationLog(":memory:");
  let down = true;
  const build = fakeBuild(() => down ? { kind: "unavailable", reason: "Build answered HTTP 503" } : { kind: "accepted", value: null });
  const ids = [landing(log, "a", "landed"), landing(log, "e", "failed"), landing(log, "f", "landed")];
  const drain = createReceiptDrain({ log, route: build.route, initialBackoffMs: 20, maxBackoffMs: 40 });
  drain.wake(); await drain.idle();
  const outage = log.snapshot("test").build!;
  assert.equal(outage.state, "unavailable");
  assert.equal(outage.reason, "Build answered HTTP 503");
  // Three attempt facts, and the gate run of each, which waits for its fact.
  assert.equal(outage.pending, 6);
  assert.ok(outage.oldestPendingAt);
  // Watch clients see the outage as a runner-wide event.
  assert.ok(log.events({ operationId: RUNNER_CONTROL_ID }).some((row) => row.event.type === "build_delivery" && row.event.state === "unavailable"));
  down = false;
  await until(() => log.snapshot("test").build!.pending === 0);
  assert.equal(log.snapshot("test").build!.state, "available");
  // While down, each pass stops at the first receipt; once up, the last three sends delivered everything.
  assert.ok(build.sent.slice(0, -3).every((receipt) => receipt.operationId === ids[0]));
  const delivered = build.sent.slice(-3);
  assert.deepEqual(delivered.map((receipt) => receipt.operationId), ids);
  assert.ok(delivered.every((receipt, index) => index === 0 || receipt.sequence > delivered[index - 1]!.sequence));
  drain.close(); log.close();
});

test("a restart mid-drain resumes from the ledger, and a lost response is resent without a second effect", async () => {
  const log = openOperationLog(":memory:");
  const first = landing(log, "a", "landed");
  const second = landing(log, "e", "landed");
  // The first answer is lost after Build recorded it; then the runner stops before resending.
  const build = fakeBuild((_input, call) => call === 1 ? "lost" : { kind: "accepted", value: null });
  const before = createReceiptDrain({ log, route: build.route, initialBackoffMs: 60_000 });
  before.wake(); await before.idle();
  before.close();
  assert.deepEqual(settled(log, first), []);
  const after = createReceiptDrain({ log, route: build.route });
  after.wake(); await after.idle();
  assert.deepEqual(build.sent.map((receipt) => receipt.operationId), [first, first, second]);
  assert.deepEqual(build.sent[1], build.sent[0]);
  assert.equal(build.recorded.size, 2);
  assert.equal(settled(log, first).length, 1);
  assert.equal(settled(log, second).length, 1);
  // Nothing is owed any more: a further pass sends nothing.
  after.wake(); await after.idle();
  assert.equal(build.sent.length, 3);
  after.close(); log.close();
});

test("a receipt Build refuses is parked with its code and does not hold back another operation's", async () => {
  const log = openOperationLog(":memory:");
  const poison = landing(log, "a", "landed");
  const healthy = landing(log, "e", "landed");
  const build = fakeBuild((input) => input.operationId === poison ? { kind: "refused", code: "attempt_fact_invalid" } : { kind: "accepted", value: null });
  const drain = createReceiptDrain({ log, route: build.route });
  drain.wake(); await drain.idle();
  assert.deepEqual(settled(log, poison).map((event) => event.type === "build_receipt" && [event.state, event.code]), [["parked", "attempt_fact_invalid"]]);
  assert.deepEqual(settled(log, healthy).map((event) => event.type === "build_receipt" && event.state), ["delivered"]);
  assert.equal(log.snapshot("test").build!.parked, 1);
  const outcome = log.operation(poison)!;
  assert.ok(outcome.kind === "landing" && outcome.outcome?.build?.receipts === "parked");
  drain.wake(); await drain.idle();
  assert.equal(build.sent.length, 2);
  drain.close(); log.close();
});

test("a published landing whose receipt is still owed reads as landed with its receipt pending", async () => {
  const log = openOperationLog(":memory:");
  const id = landing(log, "a", "landed");
  const operation = log.operation(id)!;
  assert.ok(operation.kind === "landing");
  assert.equal(operation.status, "landed");
  assert.equal(operation.outcome!.recovery.kind, "already-published");
  assert.deepEqual(operation.outcome!.build, { admission: "admitted", receipts: "pending" });
  log.close();
});

test("refused and unbound operations send nothing", async () => {
  const log = openOperationLog(":memory:");
  const refused = landing(log, "a", "open", "refused");
  landing(log, "f", "landed", "unbound");
  const build = fakeBuild();
  const drain = createReceiptDrain({ log, route: build.route });
  drain.wake(); await drain.idle();
  assert.deepEqual([build.sent, build.admissions], [[], []]);
  const declined = log.operation(refused)!;
  assert.ok(declined.kind === "landing" && declined.outcome?.build?.admission === "refused");
  assert.deepEqual(log.snapshot("test").build, { state: "available", since: null, reason: null, pending: 0, oldestPendingAt: null, parked: 0 });
  drain.close(); log.close();
});

test("an admission Build never answered is offered until it is, even once its operation closed, so Build's custody is settled", async () => {
  const log = openOperationLog(":memory:");
  /** Submitted for admission, whose answer was lost; then cancelled by its owner or simply left queued. */
  const unanswered = (change: string, cancelled: boolean) => {
    const id = newOperationId();
    log.append(id, { type: "submitted", repo: "owner/repo", changeId: change.repeat(32), commitId: change.repeat(40), bookmark: candidateBookmark(change.repeat(32)), submittedBy: "author", admission });
    if (cancelled) log.append(id, { type: "cancelled", reason: "cancelled by the author" });
    return id;
  };
  const cancelled = unanswered("a", true), refusedLate = unanswered("e", true), abandoned = unanswered("f", false);
  let down = true, settledWakes = 0;
  const build = fakeBuild(undefined, (input) => down ? { kind: "unavailable", reason: "Build could not be reached" }
    : input.operationId === refusedLate ? { kind: "refused", code: "bind_generation_stale" } : { kind: "accepted", value: { admission: { recordedAt: null } } });
  const drain = createReceiptDrain({ log, route: build.route, initialBackoffMs: 5, maxBackoffMs: 20, onAdmissionSettled: () => { settledWakes++; } });
  drain.wake(); await drain.idle();
  // While Build is down, every unanswered admission is owed and visible.
  assert.deepEqual([log.snapshot("test").build?.state, log.snapshot("test").build?.pending], ["unavailable", 3]);
  down = false;
  await until(() => log.snapshot("test").build?.pending === 0);
  const submittedSeq = (id: string) => log.events({ operationId: id }).find((row) => row.event.type === "submitted")!.seq;
  assert.ok([cancelled, refusedLate, abandoned].every((id) => build.admissions.some((request) => request.operationId === id && request.sequence === submittedSeq(id))));
  // The cancelled one Build admitted now reports how it ended, which releases Build's custody.
  await until(() => build.sent.some((receipt) => receipt.operationId === cancelled));
  assert.deepEqual(build.sent.filter((receipt) => receipt.operationId === cancelled).map((receipt) => [receipt.event, receipt.failure?.recovery]), [["failed", "cancelled"]]);
  // The one Build refused after it closed is settled once and owes nothing more.
  assert.deepEqual(log.events({ operationId: refusedLate }).filter((row) => row.event.type === "build_receipt").map((row) => row.event),
    [{ type: "build_receipt", sequence: submittedSeq(refusedLate), state: "parked", code: "bind_generation_stale" }]);
  // The one left queued is admitted without its author, and the queue is woken to start it.
  const left = log.operation(abandoned)!;
  assert.ok(left.kind === "landing" && left.admission === "admitted" && left.status === "queued");
  assert.equal(settledWakes, 3);
  const offered = build.admissions.length;
  drain.wake(); await drain.idle();
  assert.equal(build.admissions.length, offered);
  drain.close(); log.close();
});

test("new terminal facts wake the drain without another landing or an author", async () => {
  const log = openOperationLog(":memory:");
  const build = fakeBuild();
  const drain = createReceiptDrain({ log, route: build.route });
  const id = landing(log, "a", "landed");
  await until(() => settled(log, id).length === 1);
  drain.close(); log.close();
});

test("a failure with hundreds of long commands is bounded inside Build's body limit and reports its truncation", async () => {
  const log = openOperationLog(":memory:");
  const id = newOperationId();
  log.append(id, { type: "submitted", repo: "owner/repo", changeId: "k".repeat(32), commitId: "a".repeat(40), bookmark: candidateBookmark("k".repeat(32)), submittedBy: "author", admission });
  log.append(id, { type: "build_admitted", sequence: 1, sessionId: binding.sessionId, recordedAt: null });
  // Quotes double in JSON, so 300 distinct commands of 490 of them are far beyond 256 KiB unbounded.
  for (let index = 0; index < 300; index++) {
    log.append(id, { type: "run_started", runId: `r${index}`, command: `${index} ${'"'.repeat(490)}`, host: "test" });
    log.append(id, { type: "run_finished", runId: `r${index}`, exitCode: 0, signal: null, timedOut: false, durationMs: 1 });
  }
  log.append(id, { type: "failed", stage: "verifying", reason: "gate failed", output: "x".repeat(20_000) });
  const build = fakeBuild();
  const drain = createReceiptDrain({ log, route: build.route });
  drain.wake(); await drain.idle();
  assert.equal(build.sent.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify({ action: "recordAttempt", input: build.sent[0] })) <= 200_000);
  assert.equal(build.sent[0]!.failure!.truncated, true);
  assert.deepEqual(settled(log, id).map((event) => event.type === "build_receipt" && event.state), ["delivered"]);
  drain.close(); log.close();
});
