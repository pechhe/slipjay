import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import type { BuildAdmissionRequest, BuildRoute, BuildRouteAnswer } from "../../src/lib/build/build-admission.ts";
import { createReceiptDrain, requeueParked } from "../../src/lib/build/build-receipts.ts";
import type { BuildChoreInput, BuildReceiptInput, BuildRunInput } from "../../src/lib/build/build-receipts.ts";
import { candidateBookmark, RECEIPT_KEY_EVENT_TYPES, RECEIPT_SETTLEMENT_EVENT_TYPES, RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import type { OperationLog } from "../../src/lib/runner/runner-types.ts";
import { newOperationId, openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { deliveryState, owedReceipts, receiptsOwedTo } from "../../src/lib/build/build-receipts.ts";
import { landingOutcome } from "../../src/lib/landing/landing-outcome.ts";
import { classifyEvent } from "../../src/lib/runner/failure-classification.ts";

/** The ledger as the runner composes it: receipts read outcomes and their classifications, and the snapshot reports delivery. */
const openLog = (path = ":memory:") => openOperationLog(path, {}, { classify: classifyEvent, landingOutcome, deliveryState });

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
    if (action === "recordChoreLanding") { const chore = input as BuildChoreInput; chores.push(chore);
      // Build answers with the attempt it recorded, which names the chore item it created; a read then has its number.
      return Promise.resolve({ kind: "accepted", value: { specId: `chore:${chore.operationId}` } }); }
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
  const log = openLog(":memory:");
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
  const log = openLog(":memory:");
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
  const log = openLog(":memory:");
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
  const log = openLog(":memory:");
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

test("a requeued parked receipt is delivered as a first delivery once Build accepts it", async () => {
  const log = openLog(":memory:");
  const parked = landing(log, "a", "landed");
  let fixed = false;
  const build = fakeBuild((input) => input.operationId === parked && !fixed ? { kind: "refused", code: "invalid_action_input" } : { kind: "accepted", value: null });
  const drain = createReceiptDrain({ log, route: build.route });
  drain.wake(); await drain.idle();
  assert.equal(log.snapshot("test").build!.parked, 1);
  fixed = true;
  const landedSeq = log.events({ operationId: parked }).find((row) => row.event.type === "landed")!.seq;
  assert.deepEqual(requeueParked(log, parked, "operator"), [{ sequence: landedSeq, code: "invalid_action_input" }]);
  // The requeue wakes the drain itself; the gate run waiting on the parked fact follows it.
  await until(() => log.snapshot("test").build!.pending === 0 && build.runs.length === 1);
  const first = build.sent[0]!, resent = build.sent.at(-1)!;
  assert.deepEqual(resent, first);
  assert.deepEqual(settled(log, parked).map((event) => event.type === "build_receipt" && event.state), ["parked", "requeued", "delivered"]);
  assert.equal(log.snapshot("test").build!.parked, 0);
  const outcome = log.operation(parked)!;
  assert.ok(outcome.kind === "landing" && outcome.outcome?.build?.receipts === "delivered");
  // Nothing parked is left to resend.
  assert.deepEqual(requeueParked(log, parked, "operator"), []);
  drain.close(); log.close();
});

test("a resend Build refuses again stays parked with the new code and holds back no other receipt", async () => {
  const log = openLog(":memory:");
  const parked = landing(log, "a", "landed");
  let code = "invalid_action_input";
  const build = fakeBuild((input) => input.operationId === parked ? { kind: "refused", code } : { kind: "accepted", value: null });
  const drain = createReceiptDrain({ log, route: build.route });
  drain.wake(); await drain.idle();
  code = "attempt_fact_invalid";
  const healthy = landing(log, "e", "landed");
  requeueParked(log, parked, "operator");
  await until(() => settled(log, parked).length === 3 && settled(log, healthy).length === 1);
  assert.deepEqual(settled(log, parked).map((event) => event.type === "build_receipt" && [event.state, event.code]), [["parked", "invalid_action_input"], ["requeued", "invalid_action_input"], ["parked", "attempt_fact_invalid"]]);
  assert.deepEqual(settled(log, healthy).map((event) => event.type === "build_receipt" && event.state), ["delivered"]);
  assert.equal(log.snapshot("test").build!.parked, 1);
  drain.close(); log.close();
});

test("a refused admission and an unknown or unparked operation have nothing to resend", () => {
  const log = openLog(":memory:");
  const refused = landing(log, "a", "open", "refused");
  const delivered = landing(log, "e", "landed");
  assert.deepEqual(requeueParked(log, refused, "operator"), []);
  assert.deepEqual(requeueParked(log, delivered, "operator"), []);
  assert.deepEqual(requeueParked(log, "op_unknown", "operator"), []);
  log.close();
});

test("a published landing whose receipt is still owed reads as landed with its receipt pending", async () => {
  const log = openLog(":memory:");
  const id = landing(log, "a", "landed");
  const operation = log.operation(id)!;
  assert.ok(operation.kind === "landing");
  assert.equal(operation.status, "landed");
  assert.equal(operation.outcome!.recovery.kind, "already-published");
  assert.deepEqual(operation.outcome!.build, { admission: "admitted", receipts: "pending" });
  log.close();
});

test("an attempt that owes a receipt for its integration's later settlement stays protected", async () => {
  const log = openLog(":memory:");
  // An admitted attempt that integrated, then failed with its publication unknown.
  const id = newOperationId(), commitId = "f".repeat(40);
  log.append(id, { type: "submitted", repo: "owner/repo", changeId: "a".repeat(32), commitId, bookmark: candidateBookmark("a".repeat(32)), submittedBy: "author", admission });
  log.append(id, { type: "build_admitted", sequence: 1, sessionId: binding.sessionId, recordedAt: null });
  log.append(id, { type: "stage", stage: "integrating" });
  log.append(id, { type: "integrated", base: "b".repeat(40), commitId });
  log.append(id, { type: "failed", stage: "publishing", reason: "Publication unknown" });
  // A later record settles that commit unpublished: the failed attempt owes that reconciliation, not the record.
  const recovery = newOperationId();
  log.append(recovery, { type: "submitted", kind: "recovery", repo: "owner/repo", commitId, submittedBy: "runner:recovery" });
  log.append(recovery, { type: "integration_released", repo: "owner/repo", commitId, reason: "push failed" });
  assert.deepEqual([...receiptsOwedTo(log)], [id], "the attempt whose integration was settled owes the receipt");
  const build = fakeBuild();
  const drain = createReceiptDrain({ log, route: build.route });
  drain.wake(); await drain.idle(); drain.close();
  assert.deepEqual([...receiptsOwedTo(log)], [], "delivered, nothing keeps the attempt whole");
  log.close();
});

test("every receipt the projection owes is keyed by an event type the ledger knows settles receipts", () => {
  const log = openLog(":memory:");
  landing(log, "a", "landed");
  landing(log, "b", "failed");
  const settings = landing(log, "c", "landed");
  log.append(settings, { type: "verification_skipped", base: "b".repeat(40), candidate: "c".repeat(40), fields: ["process"], reason: "only the process setting changed" });
  const held = landing(log, "e", "open");
  log.append(held, { type: "integration_held", repo: "owner/repo", commitId: "e".repeat(40), reason: "push failed" });
  // `unsettledReceipts()` finds candidates by that list, so a key type missing from it loses a receipt to the window.
  const owed = log.buildBound().flatMap(({ operation, history }) => owedReceipts(operation, history, log.integrationSettlements()));
  const types = new Map(log.events().map((row) => [row.seq, row.event.type]));
  assert.ok(owed.length >= 6, `${owed.length} receipts`);
  const keys: readonly string[] = [...RECEIPT_KEY_EVENT_TYPES, ...RECEIPT_SETTLEMENT_EVENT_TYPES];
  for (const receipt of owed) assert.ok(keys.includes(types.get(receipt.key)!), `${types.get(receipt.key)} keys a receipt`);
  log.close();
});

test("the attempts whose receipts Build has not taken are the ones its ledger must keep whole", async () => {
  const log = openLog(":memory:");
  const first = landing(log, "a", "landed"), second = landing(log, "b", "failed");
  assert.deepEqual([...receiptsOwedTo(log)].sort(), [first, second].sort(), "an undelivered attempt fact and its runs are owed");
  const build = fakeBuild();
  const drain = createReceiptDrain({ log, route: build.route });
  drain.wake(); await drain.idle(); drain.close();
  assert.deepEqual([...receiptsOwedTo(log)], [], "once Build has taken them, nothing keeps the attempt's history alive");
  log.close();
});

test("refused and unbound operations send nothing", async () => {
  const log = openLog(":memory:");
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
  const log = openLog(":memory:");
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
  const log = openLog(":memory:");
  const build = fakeBuild();
  const drain = createReceiptDrain({ log, route: build.route });
  const id = landing(log, "a", "landed");
  await until(() => settled(log, id).length === 1);
  drain.close(); log.close();
});

test("an unavailable cancelled admission does not strand unrelated published receipts", async () => {
  const log = openLog();
  const cancelled = landing(log, "a", "open", "pending");
  log.append(cancelled, { type: "cancelled", reason: "cancelled by the author" });
  const published = landing(log, "e", "landed");
  let readsFail = true;
  const build = fakeBuild();
  const route: BuildRoute = (action, input) => action === "read" && readsFail
    ? Promise.resolve({ kind: "unavailable", reason: "item read timed out" }) : build.route(action, input);
  const drain = createReceiptDrain({ log, route, initialBackoffMs: 10, maxBackoffMs: 20 });
  try {
    drain.wake(); await drain.idle();
    const publishedOperation = log.operation(published), cancelledOperation = log.operation(cancelled);
    assert.ok(publishedOperation?.kind === "landing" && cancelledOperation?.kind === "landing");
    assert.equal(publishedOperation.outcome?.build?.receipts, "delivered");
    assert.equal(cancelledOperation.admission, "pending");
    assert.equal(log.snapshot("test").build?.state, "unavailable");
    assert.match(log.snapshot("test").build?.reason ?? "", /item read timed out/);
    const publishedSends = build.sent.filter((receipt) => receipt.operationId === published).length;
    readsFail = false;
    await until(() => log.snapshot("test").build?.pending === 0);
    assert.equal(log.snapshot("test").build?.state, "available");
    assert.ok(build.sent.some((receipt) => receipt.operationId === cancelled && receipt.failure?.recovery === "cancelled"));
    drain.wake(); await drain.idle();
    assert.equal(build.sent.filter((receipt) => receipt.operationId === published).length, publishedSends);
    assert.equal(settled(log, published).length, 1);
  } finally { drain.close(); log.close(); }
});

test("an older admission whose items cannot be read does not hold back a newer admission", async () => {
  const log = openLog();
  const pending = (change: string, specId: string) => {
    const id = newOperationId();
    log.append(id, { type: "submitted", repo: "owner/repo", changeId: change.repeat(32), commitId: change.repeat(40),
      bookmark: candidateBookmark(change.repeat(32)), submittedBy: "author", admission: { ...admission, binding: { ...binding, specId } } });
    return id;
  };
  const older = pending("a", "older-spec"), newer = pending("b", "newer-spec");
  const build = fakeBuild();
  const route: BuildRoute = (action, input) => action === "read" && (input as { itemId: string }).itemId === "older-spec"
    ? Promise.resolve({ kind: "unavailable", reason: "older item read timed out" }) : build.route(action, input);
  let settledWakes = 0;
  const drain = createReceiptDrain({ log, route, onAdmissionSettled: () => { settledWakes++; } });
  try {
    drain.wake(); await drain.idle();
    const first = log.operation(older)!, second = log.operation(newer)!;
    assert.ok(first.kind === "landing" && second.kind === "landing");
    assert.equal(first.status, "queued");
    assert.equal(first.admission, "pending");
    assert.match(first.waitingFor ?? "", /older item read timed out/);
    assert.equal(second.status, "queued");
    assert.equal(second.admission, "admitted");
    assert.equal(second.position, 1);
    assert.equal(settledWakes, 1);
    assert.deepEqual(build.admissions.map((request) => request.operationId), [older, newer]);
    assert.equal(log.snapshot("test").build?.state, "unavailable");
    assert.equal(log.snapshot("test").build?.pending, 1);
  } finally { drain.close(); log.close(); }
});

test("a total outage tries every admission and only the first receipt in each backed-off pass", async () => {
  vi.useFakeTimers();
  const log = openLog();
  landing(log, "a", "open", "pending");
  landing(log, "b", "open", "pending");
  landing(log, "e", "landed");
  landing(log, "f", "landed");
  const unavailable = { kind: "unavailable" as const, reason: "Build answered HTTP 503" };
  const build = fakeBuild(() => unavailable, () => unavailable);
  const drain = createReceiptDrain({ log, route: build.route, initialBackoffMs: 20, maxBackoffMs: 40 });
  try {
    drain.wake(); await drain.idle();
    assert.deepEqual([build.admissions.length, build.sent.length], [2, 1]);
    drain.wake(); await drain.idle();
    assert.deepEqual([build.admissions.length, build.sent.length], [2, 1]);
    await vi.advanceTimersByTimeAsync(20); await drain.idle();
    assert.deepEqual([build.admissions.length, build.sent.length], [4, 2]);
    await vi.advanceTimersByTimeAsync(39); await drain.idle();
    assert.deepEqual([build.admissions.length, build.sent.length], [4, 2]);
    await vi.advanceTimersByTimeAsync(1); await drain.idle();
    assert.deepEqual([build.admissions.length, build.sent.length], [6, 3]);
    assert.equal(log.snapshot("test").build?.state, "unavailable");
  } finally { drain.close(); log.close(); vi.useRealTimers(); }
});

test("a failure with hundreds of long commands is bounded inside Build's body limit and reports its truncation", async () => {
  const log = openLog(":memory:");
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

test("a delivered chore receipt records the Build number Build's answer names; a Spec landing's receipt records none", async () => {
  const log = openLog(":memory:");
  const chore = newOperationId();
  const change = "b".repeat(32), published = "d".repeat(40);
  log.append(chore, { type: "submitted", repo: "owner/repo", changeId: change, commitId: "a".repeat(40), bookmark: candidateBookmark(change), submittedBy: "author",
    chore: { title: "Tidy the readme", helperRevisions: [] } });
  log.append(chore, { type: "landed", base: "c".repeat(40), commitId: published, branch: "main", remote: "origin" });
  const landedRow = log.events({ operationId: chore }).find((row) => row.event.type === "landed")!;
  const spec = landing(log, "e", "landed");
  const build = fakeBuild();
  const drain = createReceiptDrain({ log, route: build.route });
  drain.wake(); await drain.idle();
  assert.deepEqual(build.chores.map((input) => input.publishedRevision), [published]);
  // The fake Build answers a read of the chore item with number 1: the ledger keeps the number, not only delivery.
  assert.deepEqual(settled(log, chore), [{ type: "build_receipt", sequence: landedRow.seq, state: "delivered", chore: { number: 1 } }]);
  assert.ok(settled(log, spec).every((event) => !("chore" in event && event.chore)));
  assert.equal((log.operation(chore) as { outcome?: { build?: { chore?: { number: number } } } }).outcome?.build?.chore?.number, 1);
  drain.close(); log.close();
});

test("a chore's number unread because Build did not answer leaves the receipt owed until it is read; a refused read delivers it without one", async () => {
  const publish = (log: ReturnType<typeof openOperationLog>) => {
    const id = newOperationId(), change = "b".repeat(32);
    log.append(id, { type: "submitted", repo: "owner/repo", changeId: change, commitId: "a".repeat(40), bookmark: candidateBookmark(change), submittedBy: "author",
      chore: { title: "Tidy the readme", helperRevisions: [] } });
    log.append(id, { type: "landed", base: "c".repeat(40), commitId: "d".repeat(40), branch: "main", remote: "origin" });
    return id;
  };
  const log = openLog(":memory:");
  const id = publish(log);
  const build = fakeBuild();
  let reads = 0;
  const route: typeof build.route = (action, input) => action === "read" && reads++ === 0 ? Promise.resolve({ kind: "unavailable", reason: "Build is down" }) : build.route(action, input);
  const drain = createReceiptDrain({ log, route, initialBackoffMs: 1 });
  drain.wake(); await drain.idle();
  assert.deepEqual(settled(log, id), [], "unread, the receipt stays owed");
  // The backoff timer runs the next pass: wait for the receipt to settle rather than for a fixed time.
  for (let waited = 0; !settled(log, id).length && waited < 5_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(settled(log, id).map((event) => event.type === "build_receipt" && event.state === "delivered" && event.chore?.number), [1]);
  drain.close(); log.close();

  const refusing = openLog(":memory:");
  const refused = publish(refusing);
  const other = fakeBuild();
  const refusedDrain = createReceiptDrain({ log: refusing, route: (action, input) => action === "read" ? Promise.resolve({ kind: "refused", code: "item_unavailable" }) : other.route(action, input) });
  refusedDrain.wake(); await refusedDrain.idle();
  assert.deepEqual(settled(refusing, refused).map((event) => event.type === "build_receipt" && event.state === "delivered" && !event.chore), [true]);
  refusedDrain.close(); refusing.close();
});

const provenance = {
  migrations: { paths: ["schema.ts"] },
  toolchain: { runtime: { name: "bun", version: "1.4.4", sha256: "a".repeat(64) }, lockfiles: [{ path: "bun.lock", blob: "b".repeat(40) }] },
  fixture: { unavailable: "the repository declares no provenance.fixturePaths" },
};

test("ledger provenance is copied unchanged into failures and reconciliation failures", () => {
  const log = openLog();
  try {
    const id = landing(log, "e", "open");
    log.append(id, { type: "integrated", base: "b".repeat(40), commitId: "c".repeat(40) });
    log.append(id, { type: "provenance", value: provenance });
    log.append(id, { type: "failed", stage: "publishing", reason: "push failed" });
    log.append(newOperationId(), { type: "integration_released", repo: "owner/repo", commitId: "c".repeat(40), reason: "released" });
    const receipts = owedReceipts(log.operation(id) as import("../../src/lib/runner/runner-types.ts").LandingOperation, log.events({ operationId: id }), log.integrationSettlements());
    const failures = receipts.flatMap(row => row.action === "recordAttempt" && row.input.failure ? [row.input.failure] : []);
    assert.equal(failures.length, 2);
    assert.deepEqual(failures.map(failure => failure.provenance), [provenance, provenance]);
  } finally { log.close(); }
});

test("fit shrinks provenance lists before removing existing failure detail and stays below the receipt limit", () => {
  const log = openLog();
  try {
    const id = landing(log, "e", "open");
    for (let n = 0; n < 300; n++) {
      log.append(id, { type: "run_started", runId: `extra${n}`, command: `${n} ${"x".repeat(480)}`, host: "test" });
      log.append(id, { type: "run_finished", runId: `extra${n}`, exitCode: 0, signal: null, timedOut: false, durationMs: 1 });
    }
    const paths = Array.from({ length: 100 }, (_, n) => `${n}/${"x".repeat(490)}`).sort();
    log.append(id, { type: "provenance", value: { ...provenance, migrations: { paths }, fixture: { paths: paths.slice(0, 50).map(path => ({ path, tree: "a".repeat(40) })) } } });
    log.append(id, { type: "failed", stage: "verifying", reason: "gate failed", output: "x".repeat(8000) });
    const row = owedReceipts(log.operation(id) as import("../../src/lib/runner/runner-types.ts").LandingOperation, log.events({ operationId: id }), log.integrationSettlements())[0]!;
    assert.equal(row.action, "recordAttempt");
    if (row.action !== "recordAttempt") throw new Error("expected attempt");
    assert.ok(Buffer.byteLength(JSON.stringify({ action: row.action, input: row.input })) <= 200_000);
    const failure = row.input.failure!;
    assert.equal(failure.excerpt?.length, 8000);
    assert.equal(failure.checks.passed.length, 301);
    assert.equal(failure.truncated, true);
    assert.ok(failure.provenance && "paths" in failure.provenance.migrations);
    assert.equal(failure.provenance.migrations.truncated, true);
    assert.ok(failure.provenance.migrations.paths.length < 100);
  } finally { log.close(); }
});

// Forge compares the semantic attempt fields and canonical JSON of the failure. The only
// tolerated enrichment is adding provenance to a failure that previously had none.
const canonicalJson = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function sameAttemptFact(recorded: BuildReceiptInput, incoming: BuildReceiptInput) {
  if (canonicalJson({ ...recorded, failure: null }) !== canonicalJson({ ...incoming, failure: null })) return false;
  if (canonicalJson(recorded.failure) === canonicalJson(incoming.failure)) return true;
  if (!recorded.failure || recorded.failure.provenance || !incoming.failure?.provenance) return false;
  const { provenance: _added, ...failure } = incoming.failure;
  return canonicalJson(recorded.failure) === canonicalJson(failure);
}

test("legacy failure bytes replay after a dropped delivered row and a changed integration policy, then drain the runs", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const root = await mkdtemp(join(tmpdir(), "receipt-replay-"));
  const path = join(root, "events.sqlite");
  let log = openLog(path);
  let drain: ReturnType<typeof createReceiptDrain> | undefined;
  try {
    await writeFile(join(root, "slipjay.json"), JSON.stringify({ version: 1 }));
    const id = landing(log, "e", "failed");
    const operation = log.operation(id) as import("../../src/lib/runner/runner-types.ts").LandingOperation;
    const original = owedReceipts(operation, log.events({ operationId: id }), log.integrationSettlements())[0]!;
    assert.equal(original.action, "recordAttempt");
    if (original.action !== "recordAttempt") throw new Error("expected attempt");
    const bytes = JSON.stringify(original.input);
    const expectedFailure = { stage: "verifying", cause: "gate failed", command: "vp test", excerpt: "1 failing",
      exit: { code: 1, signal: null, timedOut: false, cancelled: false }, checks: { passed: [], failed: ["vp test"], skipped: [], incomplete: [] },
      artifacts: [`slipjay runner log ${id}`], truncated: false, recovery: "code_repair" };
    assert.equal(bytes, JSON.stringify({ ...original.input, failure: expectedFailure }));
    const recorded = structuredClone(original.input);
    const enriched = { ...recorded, failure: { ...recorded.failure!, provenance } };
    assert.ok(sameAttemptFact(recorded, enriched));
    assert.equal(sameAttemptFact(enriched, { ...enriched, failure: { ...enriched.failure, provenance: { ...provenance, migrations: { paths: ["other"] } } } }), false);
    let allowRuns = false, replayed = 0, runs = 0;
    const route: BuildRoute = async (action, input) => {
      if (action === "recordAttempt") {
        if (!sameAttemptFact(recorded, input as BuildReceiptInput)) return { kind: "refused", code: "attempt_fact_conflict", retryable: false };
        assert.equal(JSON.stringify(input), bytes);
        replayed++;
        return { kind: "accepted", value: recorded };
      }
      assert.equal(action, "recordAttemptRun");
      if (!allowRuns) return { kind: "unavailable", reason: "interrupted before run delivery" };
      runs++;
      return { kind: "accepted", value: null };
    };
    drain = createReceiptDrain({ log, route, initialBackoffMs: 60_000 });
    drain.wake(); await drain.idle(); drain.close();
    assert.equal(replayed, 1); assert.equal(runs, 0);
    log.close();
    const db = new DatabaseSync(path);
    db.prepare("DELETE FROM events WHERE operation_id = ? AND json_extract(data, '$.type') = 'build_receipt' AND json_extract(data, '$.sequence') = ?").run(id, original.key);
    db.close();
    // No receipt projection is allowed to consult the integration policy on resend.
    await writeFile(join(root, "slipjay.json"), JSON.stringify({ version: 1, provenance: { fixturePaths: ["new-fixture"] } }));
    log = openLog(path); allowRuns = true;
    drain = createReceiptDrain({ log, route });
    drain.wake(); await drain.idle();
    assert.equal(replayed, 2); assert.equal(runs, 1);
    assert.equal(log.snapshot("test").build?.pending, 0);
  } finally { drain?.close(); log.close(); await rm(root, { recursive: true, force: true }); }
});
