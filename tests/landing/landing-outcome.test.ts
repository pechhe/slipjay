import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { candidateBookmark, OWNER_KILL_REASON } from "../../src/lib/runner/runner-contract.ts";
import type { LandingOperation, LandingOutcome } from "../../src/lib/runner/runner-types.ts";
import { createRunnerHandler } from "../../src/lib/runner/runner-api.ts";
import { serveRunner } from "../../src/lib/runner/runner-http.ts";
import { readLandingOutcome } from "../../src/lib/runner/runner-client.ts";
import { choreLandingNote } from "../../src/lib/landing/landing-note.ts";
import { landingOutcome } from "../../src/lib/landing/landing-outcome.ts";
import { classifyEvent } from "../../src/lib/runner/failure-classification.ts";

const source = "a".repeat(40), base = "b".repeat(40), candidate = "c".repeat(40), changeId = "k".repeat(32);
function fixture(path = ":memory:") {
  const log = openOperationLog(path, {}, { classify: classifyEvent, landingOutcome });
  log.append("op_fixture", { type: "submitted", repo: "owner/repo", changeId, commitId: source, bookmark: candidateBookmark(changeId), submittedBy: "author" });
  return { log, append: (event: Parameters<typeof log.append>[1]) => log.append("op_fixture", event),
    outcome: () => (log.operation("op_fixture") as LandingOperation).outcome! };
}

test("historical gaps stay explicit; a live operation does not become a failure or handoff acknowledgement", () => {
  const f = fixture();
  try {
    const outcome = f.outcome();
    assert.equal(outcome.terminal, false);
    assert.equal(outcome.status, "queued");
    assert.equal(outcome.recovery.kind, "follow");
    assert.equal(outcome.recovery.automaticRetry, false);
    assert.equal(outcome.sourceCommitId, source);
    assert.equal(outcome.publication.state, "not-attempted");
    assert.equal(outcome.evidence.coverage, "partial");
    assert.ok(outcome.evidence.gaps.some((gap) => gap.includes("retained-source")));
    assert.equal(outcome.classification, undefined);
    assert.equal(outcome.evidence.logCommand, "slipjay runner log op_fixture");
  } finally { f.log.close(); }
});

test("attempt invalidation preserves passing history, and unavailable completions never count as passed", () => {
  const f = fixture();
  try {
    f.append({ type: "attempt_prepared", attempt: 1, source, base, candidate, overlap: true, checkout: "/fixture" });
    f.append({ type: "run_started", runId: "old", command: "bun test old", host: "fixture", attempt: 1 });
    f.append({ type: "run_finished", runId: "old", exitCode: 0, signal: null, timedOut: false, durationMs: 1, diagnosticCapture: "selected" });
    f.append({ type: "attempt_invalidated", attempt: 1, reason: "remote moved" });
    f.append({ type: "attempt_prepared", attempt: 2, source, base: "d".repeat(40), candidate: "e".repeat(40), overlap: false, checkout: "/fixture2" });
    for (const runId of ["lost", "exception", "signal", "timeout", "killed"])
      f.append({ type: "run_started", runId, command: `bun test ${runId}`, host: "fixture", attempt: 2 });
    f.append({ type: "run_finished", runId: "exception", exitCode: null, signal: null, timedOut: false, durationMs: 1 });
    f.append({ type: "run_finished", runId: "signal", exitCode: null, signal: "SIGTERM", timedOut: false, durationMs: 1 });
    f.append({ type: "run_finished", runId: "timeout", exitCode: 0, signal: null, timedOut: true, durationMs: 1 });
    f.append({ type: "run_finished", runId: "killed", exitCode: null, signal: "SIGTERM", timedOut: false, killed: true, durationMs: 1 });
    const outcome = f.outcome();
    assert.equal(outcome.attempt?.attempt, 2);
    assert.deepEqual(outcome.runs.map((run) => [run.runId, run.outcome, run.invalidated]), [
      ["old", "passed", true], ["lost", "incomplete", false], ["exception", "incomplete", false],
      ["signal", "failed", false], ["timeout", "failed", false], ["killed", "killed", false],
    ]);
    assert.equal(outcome.runs.find((run) => run.runId === "signal")?.timedOut, false);
  } finally { f.log.close(); }
});

test("failed evidence carries cause version, diagnostics, attribution and bounded excerpt", () => {
  const f = fixture();
  try {
    f.append({ type: "identity", submitterKind: "agent", submitterId: "author", workspace: "fixture", machine: "test", spec: 57 });
    f.append({ type: "submission_request", requestId: "request-fixture-123", repo: "owner/repo", changeId, commitId: source, bookmark: candidateBookmark(changeId), submittedBy: "author" });
    f.append({ type: "source_retained", commitId: source, sourceRef: "refs/slipjay/submissions/fixture", manifestSha256: "d".repeat(64), handoffComplete: false });
    f.append({ type: "stage", stage: "verifying" });
    f.append({ type: "run_started", runId: "run", command: "bun test middle", host: "fixture", purpose: "gate" });
    f.append({ type: "run_finished", runId: "run", exitCode: 1, signal: null, timedOut: false, durationMs: 3,
      failingTests: ["middle failure"], diagnostics: ["src/middle.ts:12:3 failure"], diagnosticCapture: "incomplete" });
    f.append({ type: "failed", stage: "verifying", reason: "assertion failed", command: "bun test middle", output: "causal error\n" + "x".repeat(7000) });
    const outcome = f.outcome();
    assert.equal(outcome.identity?.spec, 57);
    assert.equal(outcome.requestId, "request-fixture-123");
    assert.equal(outcome.sourceRetention?.handoffComplete, false);
    assert.equal(outcome.classification?.ruleVersion, 1);
    assert.equal(outcome.classification?.cause, "gate");
    assert.ok(outcome.classification?.diagnostics.includes("src/middle.ts:12:3 failure"));
    assert.equal(outcome.failure?.excerpt?.length, 6000);
    assert.equal(outcome.failure?.excerptTruncated, true);
    assert.equal(outcome.recovery.kind, "inspect-failure");
    assert.equal(outcome.runs[0]?.outcome, "failed");
    assert.equal(outcome.asOfSeq, f.log.operation("op_fixture")?.lastSeq);
  } finally { f.log.close(); }
});

test("held or uncertain publication requires reconciliation after terminal failure", () => {
  for (const stage of ["integrating", "finalizing", "publishing"] as const) {
    const f = fixture();
    try {
      f.append({ type: "publication_intent", attempt: 1, base, candidate });
      f.append({ type: "integrated", base, commitId: candidate });
      f.append({ type: "integration_held", repo: "owner/repo", commitId: candidate, reason: "unconfirmed" });
      f.append({ type: "failed", stage, reason: "publication unknown" });
      assert.deepEqual(f.outcome().publication, { state: "unconfirmed", base, commitId: candidate });
      assert.equal(f.outcome().terminal, true);
      assert.equal(f.outcome().recovery.kind, "reconcile-publication");
      assert.equal(f.outcome().recovery.automaticRetry, false);
    } finally { f.log.close(); }
  }
  const f = fixture();
  try {
    f.append({ type: "failed", stage: "publishing", reason: "legacy unknown push" });
    assert.equal(f.outcome().publication.state, "unconfirmed");
  } finally { f.log.close(); }
});

test("publication proof wins; cancellation, supersession and refusal never authorize automatic retry", () => {
  for (const result of [
    { type: "landed", base, commitId: candidate, branch: "main", remote: "origin" },
    { type: "cancelled", reason: OWNER_KILL_REASON },
    { type: "superseded", by: "op_next" },
    { type: "declined", reason: "policy", paths: ["drizzle/x.sql"] },
  ] as const) {
    const f = fixture();
    try {
      f.append(result.type === "declined" ? { ...result, paths: [...result.paths] } : result);
      assert.equal(f.outcome().recovery.kind, result.type === "landed" ? "already-published" : result.type === "cancelled" ? "owner-stopped" : result.type === "superseded" ? "superseded" : "policy-refusal");
      assert.equal(f.outcome().publication.state, result.type === "landed" ? "published" : "not-attempted");
      assert.equal(f.outcome().recovery.automaticRetry, false);
    } finally { f.log.close(); }
  }
});

test("later failure cannot erase recorded publication or authorize publishing the candidate twice", () => {
  const f = fixture();
  try {
    f.append({ type: "landed", base, commitId: candidate, branch: "main", remote: "origin" });
    f.append({ type: "failed", stage: "publishing", reason: "later receipt failure" });
    assert.equal(f.outcome().status, "failed");
    assert.equal(f.outcome().publication.state, "published");
    assert.equal(f.outcome().recovery.kind, "already-published");
    assert.equal(f.outcome().failure?.reason, "later receipt failure");
  } finally { f.log.close(); }
});

test("API, client and actual CLI retrieve identical durable outcome after restart without a submission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slipjay-outcome-"));
  const path = join(dir, "log.sqlite");
  const original = fixture(path);
  original.append({ type: "failed", stage: "verifying", reason: "fixture failure" });
  const expected = original.outcome();
  original.log.close();
  const log = openOperationLog(path, {}, { classify: classifyEvent, landingOutcome });
  let submissions = 0;
  const server = await serveRunner(createRunnerHandler({ log, token: "fixture-token", runnerName: "fixture", readLog: async () => "retained",
    onSubmitted: () => { submissions++; }, kill: () => ({ status: "idle" }), subscribe: log.subscribe }), { host: "127.0.0.1", port: 0 });
  try {
    const env = { ...process.env, SLIPJAY_RUNNER_TOKEN: "fixture-token", SLIPJAY_RUNNER: server.url };
    const response = await fetch(`${server.url}/v1/operations/op_fixture/outcome`, { headers: { authorization: "Bearer fixture-token" } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { outcome: LandingOutcome }).outcome, expected);
    assert.deepEqual(await readLandingOutcome(server.url, "op_fixture", env), expected);
    const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
    const { stdout, stderr } = await promisify(execFile)("bun", [cli, "runner", "outcome", "op_fixture"], { env, timeout: 20_000 });
    assert.deepEqual(JSON.parse(stdout), expected);
    assert.equal(stderr, "");
    assert.equal(submissions, 0);
    assert.equal(log.operationsForChange("owner/repo", changeId).length, 1);
    assert.equal((await fetch(`${server.url}/v1/operations/op_fixture/outcome`)).status, 401);
    await assert.rejects(readLandingOutcome(server.url, "missing", env), /404/);
    log.append("op_release", { type: "submitted", kind: "release", repo: "owner/repo", commitId: candidate, migrationsReady: false, submittedBy: "author" });
    await assert.rejects(readLandingOutcome(server.url, "op_release", env), /409/);
  } finally { await server.close(); log.close(); await rm(dir, { recursive: true, force: true }); }
});

/** A landing of one declared kind, published, in its own ledger: what `slipjay land`'s final output reads. */
function publish(kind: "chore" | "spec") {
  const id = kind === "chore" ? "op_chore" : "op_spec";
  const log = openOperationLog(":memory:", {}, { classify: classifyEvent, landingOutcome });
  log.append(id, kind === "chore"
    ? { type: "submitted", repo: "owner/repo", changeId, commitId: source, bookmark: candidateBookmark(changeId), submittedBy: "author",
        chore: { title: "Tidy the readme", helperRevisions: [] } }
    : { type: "submitted", repo: "owner/repo", changeId, commitId: source, bookmark: candidateBookmark(changeId), submittedBy: "author",
        admission: { binding: { specId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", ticketIds: [], bodyRevision: 0, bindGeneration: 1,
          sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" }, specBodyHash: null, helperRevisions: [], repairsOperationId: null, supersedes: null } });
  if (kind === "spec") log.append(id, { type: "build_admitted", sequence: 1, sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", recordedAt: null });
  log.append(id, { type: "landed", base, commitId: candidate, branch: "main", remote: "origin" });
  const landedSeq = log.events({ operationId: id }).find((row) => row.event.type === "landed")!.seq;
  return { log, id, landedSeq, settle: (event: Parameters<typeof log.append>[1]) => log.append(id, event),
    outcome: () => (log.operation(id) as LandingOperation).outcome! };
}

test("a chore landing's output names its Build chore and the attach action; a landing under a Spec adds nothing", () => {
  const chore = publish("chore");
  try {
    // Published, but Build's own item number arrives with the receipt, which may not have been delivered yet.
    assert.deepEqual(chore.outcome().build, { admission: "unassociated", receipts: "pending" });
    assert.equal(choreLandingNote(chore.outcome().build, candidate, "op_x"),
      `landed ${candidate.slice(0, 12)} as a chore, in no Spec; attach it with weave_forge_associate_landing (Build has not recorded the chore's number yet: slipjay runner outcome op_x shows it once it has)`);
    chore.settle({ type: "build_receipt", sequence: chore.landedSeq, state: "delivered", chore: { number: 3721 } });
    assert.deepEqual(chore.outcome().build, { admission: "unassociated", receipts: "delivered", chore: { number: 3721 } });
    assert.equal(choreLandingNote(chore.outcome().build, candidate, "op_x"),
      `landed ${candidate.slice(0, 12)} as a chore: Build #3721 is in no Spec; attach it with weave_forge_associate_landing`);
    assert.equal(chore.outcome().build?.chore?.number, 3721);
  } finally { chore.log.close(); }
  const spec = publish("spec");
  try {
    spec.settle({ type: "build_receipt", sequence: spec.landedSeq, state: "delivered" });
    assert.deepEqual(spec.outcome().build, { admission: "admitted", receipts: "delivered" });
    assert.equal(choreLandingNote(spec.outcome().build, candidate, "op_x"), null);
  } finally { spec.log.close(); }
});
