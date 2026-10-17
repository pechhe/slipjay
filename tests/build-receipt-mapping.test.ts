import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import type { BuildAdmissionRecord, BuildRoute } from "../src/lib/build-admission.ts";
import { createReceiptDrain, owedReceipts } from "../src/lib/build-receipts.ts";
import type { BuildReceipt, BuildReceiptInput, BuildRunInput } from "../src/lib/build-receipts.ts";
import { candidateBookmark, OWNER_KILL_REASON, RUNNER_CONTROL_ID } from "../src/lib/runner-contract.ts";
import type { LandingOperation, OperationEvent, OperationLog } from "../src/lib/runner-contract.ts";
import { newOperationId, openOperationLog } from "../src/lib/runner-log.ts";

const spec = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const tickets = ["11111111-2222-4333-8444-555555555555", "66666666-7777-4888-9999-aaaaaaaaaaaa"];
const record = (overrides: Partial<BuildAdmissionRecord["binding"]> = {}, repairsOperationId: string | null = null): BuildAdmissionRecord => ({
  binding: { specId: spec, ticketIds: tickets, bodyRevision: 5, bindGeneration: 3, sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", ...overrides },
  specBodyHash: "f".repeat(64), helperRevisions: ["e".repeat(40)], repairsOperationId, supersedes: null });

/** A landing whose ledger is exactly `events`, after a `submitted` row carrying `submitted`. */
function operation(log: OperationLog, submitted: { admission?: BuildAdmissionRecord; chore?: { title: string; helperRevisions: string[] } }, events: OperationEvent[], admitted = Boolean(submitted.admission)) {
  const id = newOperationId();
  const change = "k".repeat(32);
  log.append(id, { type: "submitted", repo: "owner/repo", changeId: change, commitId: "a".repeat(40), bookmark: candidateBookmark(change), submittedBy: "author", ...submitted });
  if (admitted) log.append(id, { type: "build_admitted", sequence: 1, sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", recordedAt: null });
  for (const event of events) log.append(id, event);
  return id;
}
const owed = (log: OperationLog, id: string): BuildReceipt[] => owedReceipts(log.operation(id) as LandingOperation, log.events({ operationId: id }), log.publicationRecoveries());
const attempts = (receipts: BuildReceipt[]) => receipts.flatMap((receipt) => receipt.action === "recordAttempt" ? [receipt.input] : []);
const runs = (receipts: BuildReceipt[]) => receipts.flatMap((receipt) => receipt.action === "recordAttemptRun" ? [receipt.input] : []);
const run = (runId: string, command: string, finish: Partial<Extract<OperationEvent, { type: "run_finished" }>> | null): OperationEvent[] => [
  { type: "run_started", runId, command, host: "test" },
  ...finish ? [{ type: "run_finished" as const, runId, exitCode: 0, signal: null, timedOut: false, durationMs: 1, ...finish }] : []];
const tuple = (input: BuildReceiptInput) => [input.repository, input.operationId, input.specId, input.ticketIds, input.specBodyRevision, input.specBodyHash,
  input.candidateRevision, input.bindGeneration, input.helperRevisions, input.repairsOperationId];

test("held, unknown publication and its later confirmation keep one source tuple, and the confirmation is not lost behind the failure", () => {
  const log = openOperationLog(":memory:");
  const id = operation(log, { admission: record() }, [
    { type: "stage", stage: "verifying" }, { type: "verification_base", base: "b".repeat(40), candidate: "c".repeat(40) },
    ...run("gate", "vp test", {}), { type: "verification_passed", base: "b".repeat(40), candidate: "c".repeat(40) },
    { type: "integrated", base: "b".repeat(40), commitId: "d".repeat(40) },
    { type: "integration_held", repo: "owner/repo", commitId: "d".repeat(40), reason: "push refused" },
    { type: "integration_held", repo: "owner/repo", commitId: "d".repeat(40), reason: "push refused again" },
    { type: "failed", stage: "publishing", reason: "Integration publication failed" },
  ]);
  // A later landing finds the held integration on the remote.
  log.append(newOperationId(), { type: "integration_recovered", repo: "owner/repo", commitId: "d".repeat(40) });
  const facts = attempts(owed(log, id));
  assert.deepEqual(facts.map((fact) => fact.event), ["held", "failed", "published"]);
  assert.equal(facts[1]!.failure!.recovery, "publication_unknown");
  assert.deepEqual(facts.map((fact) => [fact.verifiedRevision, fact.publishedRevision]), [["c".repeat(40), null], ["c".repeat(40), null], ["c".repeat(40), "d".repeat(40)]]);
  // The author's source stays the candidate revision; the verified candidate and base are reported apart from it.
  for (const fact of facts) assert.deepEqual(tuple(fact), tuple(facts[0]!));
  assert.equal(facts[0]!.candidateRevision, "a".repeat(40));
  assert.ok(facts[0]!.sequence < facts[1]!.sequence && facts[1]!.sequence < facts[2]!.sequence);
  log.close();
});

test("a settings landing that skipped its checks is published without a verified revision", () => {
  const log = openOperationLog(":memory:");
  const base = "b".repeat(40), candidate = "c".repeat(40);
  const id = operation(log, { admission: record() }, [
    { type: "verification_base", base, candidate },
    { type: "verification_skipped", base, candidate, fields: ["spares"], reason: "settings landing" },
    { type: "verification_passed", base, candidate },
    { type: "landed", base, commitId: "d".repeat(40), branch: "main", remote: "origin" },
  ]);
  const receipts = owed(log, id);
  assert.deepEqual(attempts(receipts).map((fact) => [fact.event, fact.verifiedRevision, fact.publishedRevision]), [["published", null, "d".repeat(40)]]);
  // Build learns why from a run that is not evidence.
  const [skip] = runs(receipts);
  assert.equal(skip?.outcome, "incomplete");
  assert.match(skip?.knownGaps[0] ?? "", /skipped for a settings landing \(spares\): settings landing/);

  // Held, then failed at publication: no receipt claims the skipped candidate was verified.
  const held = operation(log, { admission: record() }, [
    { type: "verification_base", base, candidate },
    { type: "verification_skipped", base, candidate, fields: ["spares"], reason: "settings landing" },
    { type: "verification_passed", base, candidate },
    { type: "integrated", base, commitId: "d".repeat(40) },
    { type: "integration_held", repo: "owner/repo", commitId: "d".repeat(40), reason: "push refused" },
    { type: "failed", stage: "publishing", reason: "Integration publication failed" },
  ]);
  const failed = owed(log, held);
  assert.deepEqual(attempts(failed).map((fact) => [fact.event, fact.verifiedRevision]), [["held", null], ["failed", null]]);
  assert.equal(runs(failed).length, 1);
  log.close();
});

test("a confirmation counts only in the integration's own repository, and only once it follows the failure", () => {
  const log = openOperationLog(":memory:");
  const unknown: OperationEvent[] = [{ type: "verification_passed", base: "b".repeat(40), candidate: "c".repeat(40) },
    { type: "integrated", base: "b".repeat(40), commitId: "d".repeat(40) }, { type: "failed", stage: "publishing", reason: "Integration publication failed" }];
  // A fork holding the same commit, and an earlier confirmation in this repository, say nothing about this failure.
  log.append(newOperationId(), { type: "integration_recovered", repo: "owner/repo", commitId: "d".repeat(40) });
  const id = operation(log, { admission: record() }, unknown);
  log.append(newOperationId(), { type: "integration_recovered", repo: "fork/repo", commitId: "d".repeat(40) });
  assert.deepEqual(attempts(owed(log, id)).map((fact) => fact.event), ["failed"]);
  log.append(RUNNER_CONTROL_ID, { type: "integration_recovered", repo: "owner/repo", commitId: "d".repeat(40) });
  const confirmation = log.events({ operationId: RUNNER_CONTROL_ID }).at(-1)!;
  const facts = attempts(owed(log, id));
  assert.deepEqual(facts.map((fact) => fact.event), ["failed", "published"]);
  assert.equal(facts[1]!.sequence, confirmation.seq);
  log.close();
});

test("a declared chore whose publication was unknown is reported once its repository confirms it", () => {
  const log = openOperationLog(":memory:");
  const chore = operation(log, { chore: { title: "Bump dependencies", helperRevisions: [] } }, [
    { type: "verification_passed", base: "b".repeat(40), candidate: "c".repeat(40) },
    { type: "integrated", base: "b".repeat(40), commitId: "d".repeat(40) }, { type: "failed", stage: "publishing", reason: "Integration publication failed" }]);
  assert.deepEqual(owed(log, chore), []);
  log.append(newOperationId(), { type: "integration_recovered", repo: "fork/repo", commitId: "d".repeat(40) });
  assert.deepEqual(owed(log, chore), []);
  log.append(RUNNER_CONTROL_ID, { type: "integration_recovered", repo: "owner/repo", commitId: "d".repeat(40) });
  const confirmation = log.events({ operationId: RUNNER_CONTROL_ID }).at(-1)!;
  const receipts = owed(log, chore);
  assert.equal(receipts.length, 1);
  assert.ok(receipts[0]!.action === "recordChoreLanding");
  assert.deepEqual([receipts[0]!.key, receipts[0]!.input.sequence, receipts[0]!.input.baseRevision, receipts[0]!.input.verifiedRevision, receipts[0]!.input.publishedRevision],
    [confirmation.seq, confirmation.seq, "b".repeat(40), "c".repeat(40), "d".repeat(40)]);
  log.close();
});

test("cancel, kill, supersede, policy refusal and infrastructure failures each name how they recover", () => {
  const log = openOperationLog(":memory:");
  const recovery = (events: OperationEvent[]) => attempts(owed(log, operation(log, { admission: record() }, events)))[0]!.failure!.recovery;
  assert.equal(recovery([{ type: "cancelled", reason: "owner cancelled" }]), "cancelled");
  assert.equal(recovery([{ type: "superseded", by: "op_next" }]), "superseded");
  assert.equal(recovery([{ type: "declined", reason: "migration landing", paths: ["schema"] }]), "policy_refusal");
  assert.equal(recovery([{ type: "stage", stage: "verifying" }, ...run("gate", "vp test", { exitCode: null, signal: "SIGKILL", killed: true }),
    { type: "failed", stage: "verifying", reason: OWNER_KILL_REASON, command: "vp test" }]), "cancelled");
  assert.equal(recovery([{ type: "stage", stage: "installing" }, ...run("deps", "bun install", { exitCode: 1 }),
    { type: "failed", stage: "installing", reason: "Network unreachable", command: "bun install" }]), "infrastructure_retry");
  assert.equal(recovery([{ type: "stage", stage: "verifying" }, ...run("gate", "vp test", { exitCode: 1, failingTests: ["adds"] }),
    { type: "failed", stage: "verifying", reason: "Required verification failed", command: "vp test" }]), "code_repair");
  log.close();
});

test("commands are reported as named runs with their real outcome, never as test counts, once their attempt fact exists", () => {
  const log = openOperationLog(":memory:");
  const id = operation(log, { admission: record() }, [
    { type: "stage", stage: "verifying" }, { type: "verification_base", base: "b".repeat(40), candidate: "c".repeat(40) },
    ...run("lint", "vp check", {}), ...run("gate", "vp test", { exitCode: 1, failingTests: ["adds numbers"] }),
    ...run("killed", "slow", { exitCode: null, signal: "SIGKILL", killed: true }), ...run("lost", "never finished", null),
    { type: "failed", stage: "verifying", reason: "Required verification failed", command: "vp test" },
  ]);
  const receipts = owed(log, id);
  const terminal = attempts(receipts)[0]!;
  const reported = runs(receipts);
  assert.deepEqual(reported.map((entry) => [entry.clientRef, entry.command, entry.outcome]),
    [["lint", "vp check", "passed"], ["gate", "vp test", "failed"], ["killed", "slow", "cancelled"], ["lost", "never finished", "incomplete"]]);
  assert.ok(reported.every((entry) => entry.sequence === terminal.sequence));
  assert.ok(receipts.filter((receipt) => receipt.action === "recordAttemptRun").every((receipt) => receipt.after === terminal.sequence));
  assert.deepEqual(reported[1]!.checks, [{ name: "adds numbers", outcome: "failed" }]);
  assert.deepEqual(reported[3]!.endedAt, null);
  assert.ok(reported[3]!.knownGaps.length);
  assert.deepEqual(terminal.failure!.checks, { passed: ["vp check"], failed: ["vp test"], skipped: [], incomplete: ["never finished", "slow"] });
  log.close();
});

test("a pass with no recorded verified candidate is incomplete with its gap named, since Build cannot accept it as evidence", () => {
  const log = openOperationLog(":memory:");
  // A row from before verification recorded its candidate.
  const id = operation(log, { admission: record() }, [{ type: "stage", stage: "verifying" }, { type: "verification_base", base: "b".repeat(40) },
    ...run("lint", "vp check", {}), { type: "failed", stage: "verifying", reason: "Required verification failed" }]);
  const [lint] = runs(owed(log, id));
  assert.equal(lint!.outcome, "incomplete");
  assert.match(lint!.knownGaps.join(" "), /no verified candidate/);
  log.close();
});

test("repair linkage comes only from the repair the author proposed, never from queue-prefix ancestry", () => {
  const log = openOperationLog(":memory:");
  const prepared: OperationEvent = { type: "attempt_prepared", attempt: 1, source: "a".repeat(40), base: "b".repeat(40), candidate: "c".repeat(40),
    predecessor: { operationId: "op_ahead_in_queue", attempt: 1, candidate: "9".repeat(40) }, overlap: false, checkout: "/tmp/x" };
  const ancestry = operation(log, { admission: record() }, [prepared, { type: "cancelled", reason: "stop" }]);
  assert.equal(attempts(owed(log, ancestry))[0]!.repairsOperationId, null);
  const repair = operation(log, { admission: record({}, "op_failed_earlier") }, [prepared, { type: "cancelled", reason: "stop" }]);
  assert.equal(attempts(owed(log, repair))[0]!.repairsOperationId, "op_failed_earlier");
  log.close();
});

test("no-Ticket, multi-Ticket and unknown-body-revision scope pass through unchanged, with one terminal fact per operation", () => {
  const log = openOperationLog(":memory:");
  const landed: OperationEvent[] = [{ type: "verification_passed", base: "b".repeat(40), candidate: "c".repeat(40) },
    { type: "landed", base: "b".repeat(40), commitId: "d".repeat(40), branch: "main", remote: "origin" }];
  for (const binding of [{ ticketIds: [] }, { ticketIds: tickets }, { ticketIds: [], bodyRevision: null }]) {
    const facts = attempts(owed(log, operation(log, { admission: record(binding) }, landed)));
    assert.equal(facts.length, 1);
    assert.deepEqual([facts[0]!.ticketIds, facts[0]!.specBodyRevision], [binding.ticketIds, "bodyRevision" in binding ? null : 5]);
  }
  log.close();
});

test("only a declared chore is reported as one: replay cannot make another, and an unbound or unpublished landing makes none", async () => {
  const log = openOperationLog(":memory:");
  const published: OperationEvent[] = [{ type: "verification_passed", base: "b".repeat(40), candidate: "c".repeat(40) },
    { type: "landed", base: "b".repeat(40), commitId: "d".repeat(40), branch: "main", remote: "origin" }];
  const chore = operation(log, { chore: { title: "Bump dependencies", helperRevisions: [] } }, published);
  operation(log, { chore: { title: "Abandoned", helperRevisions: [] } }, [{ type: "cancelled", reason: "stop" }]);
  operation(log, {}, published);
  const sent: { action: string; input: unknown }[] = [];
  const route: BuildRoute = (action, input) => { sent.push({ action, input }); return Promise.resolve({ kind: "accepted", value: null }); };
  const drain = createReceiptDrain({ log, route });
  drain.wake(); await drain.idle();
  drain.wake(); await drain.idle();
  const landedRow = log.events({ operationId: chore }).find((row) => row.event.type === "landed")!;
  assert.deepEqual(sent, [{ action: "recordChoreLanding", input: { unassociated: true, repository: "owner/repo", operationId: chore, sequence: landedRow.seq,
    occurredAt: landedRow.at, candidateRevision: "a".repeat(40), baseRevision: "b".repeat(40), verifiedRevision: "c".repeat(40), helperRevisions: [],
    publishedRevision: "d".repeat(40), title: "Bump dependencies" } }]);
  const outcome = log.operation(chore)!;
  assert.ok(outcome.kind === "landing" && outcome.outcome?.build?.admission === "unassociated" && outcome.outcome.build.receipts === "delivered");
  drain.close(); log.close();
});

test("the drain delivers runs only after their attempt fact, and a parked fact strands none of them as pending", async () => {
  const log = openOperationLog(":memory:");
  const id = operation(log, { admission: record() }, [{ type: "stage", stage: "verifying" }, { type: "verification_base", base: "b".repeat(40), candidate: "c".repeat(40) },
    ...run("gate", "vp test", { exitCode: 1 }), { type: "failed", stage: "verifying", reason: "gate failed", command: "vp test" }]);
  const parked = operation(log, { admission: record() }, [{ type: "stage", stage: "verifying" }, ...run("gate2", "vp test", { exitCode: 1 }),
    { type: "failed", stage: "verifying", reason: "gate failed", command: "vp test" }]);
  const order: string[] = [];
  const route: BuildRoute = (action, input) => {
    const operationId = (input as { operationId: string }).operationId;
    order.push(`${action}:${operationId === id ? "id" : "parked"}`);
    return Promise.resolve(action === "recordAttempt" && operationId === parked ? { kind: "refused", code: "attempt_fact_invalid" } : { kind: "accepted", value: null });
  };
  const drain = createReceiptDrain({ log, route });
  drain.wake(); await drain.idle();
  assert.deepEqual(order, ["recordAttempt:id", "recordAttempt:parked", "recordAttemptRun:id"]);
  const state = log.snapshot("test").build!;
  assert.deepEqual([state.pending, state.parked], [0, 1]);
  assert.equal(log.events({ operationId: RUNNER_CONTROL_ID }).filter((row) => row.event.type === "build_delivery").length, 0);
  assert.deepEqual((runs(owed(log, id))[0] as BuildRunInput).outcome, "failed");
  drain.close(); log.close();
});
