import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { candidateBookmark, RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import type { OperationEvent } from "../../src/lib/runner/runner-types.ts";
import { LEDGER_FACT_MS, LEDGER_HISTORY_MS, newOperationId, openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { classifyEvent } from "../../src/lib/runner/failure-classification.ts";

const openLog = (path = ":memory:") => openOperationLog(path, {}, { classify: classifyEvent });
const DAY = 24 * 60 * 60 * 1000;
/** A clock far enough ahead that everything this test appended is outside the ledger's window. */
const beyondWindow = () => new Date(Date.now() + LEDGER_HISTORY_MS + 10 * DAY);

function submission(changeId: string, commitId: string): OperationEvent {
  return { type: "submitted", repo: "owner/repo", changeId, commitId, bookmark: candidateBookmark(changeId), submittedBy: "author" };
}

test("a closed operation past the window keeps what reads across operations depend on", () => {
  const log = openLog();
  try {
    const id = newOperationId();
    log.append(id, submission("c".repeat(32), "commit-1"));
    log.append(id, { type: "stage", stage: "verifying" });
    log.append(id, { type: "run_started", runId: "run-1", command: "bun run check", host: "localhost" });
    log.append(id, { type: "run_finished", runId: "run-1", exitCode: 0, signal: null, timedOut: false, durationMs: 10 });
    log.append(id, { type: "integrated", base: "old", commitId: "commit-1" });
    log.append(id, { type: "verification_passed", base: "old", candidate: "commit-1" });
    log.append(id, { type: "landed", base: "old", commitId: "commit-1", branch: "main", remote: "origin" });

    assert.deepEqual(log.forgetHistory(beyondWindow()), { events: 4, operations: 1 });
    assert.deepEqual(log.events({ operationId: id }).map((row) => row.event.type), ["submitted", "integrated", "verification_passed", "landed"]);
    // What a later landing, deploy, audit or promotion reads from this repository's history.
    assert.deepEqual(log.landings("owner/repo").map(({ commitId, gate }) => ({ commitId, gate })), [{ commitId: "commit-1", gate: "green" }]);
    assert.equal(log.lastLanded("owner/repo")?.commitId, "commit-1");
    assert.equal(log.operation(id)?.status, "landed");
    // Nothing is left to forget, so a second pass is a no-op.
    assert.deepEqual(log.forgetHistory(beyondWindow()), { events: 0, operations: 0 });
  } finally { log.close(); }
});

test("an operation stays whole while it is open, inside the window, or its retained source has not expired", () => {
  const log = openLog();
  try {
    const open = newOperationId();
    log.append(open, submission("a".repeat(32), "open-commit"));
    log.append(open, { type: "run_started", runId: "run-open", command: "bun install", host: "localhost" });

    const retained = newOperationId();
    log.append(retained, submission("b".repeat(32), "held-commit"));
    log.append(retained, { type: "source_retained", commitId: "held-commit", sourceRef: "refs/slipjay/source/held", manifestSha256: "0".repeat(64), handoffComplete: false });
    log.append(retained, { type: "run_started", runId: "run-retained", command: "bun install", host: "localhost" });
    log.append(retained, { type: "failed", stage: "verifying", reason: "gate failed" });

    const renewed = newOperationId();
    log.append(renewed, submission("d".repeat(32), "expired-commit"));
    log.append(renewed, { type: "source_retained", commitId: "expired-commit", sourceRef: "refs/slipjay/source/expired", manifestSha256: "1".repeat(64), handoffComplete: false });
    log.append(renewed, { type: "evidence_expired", policy: "published" });
    log.append(renewed, { type: "run_started", runId: "run-expired", command: "bun install", host: "localhost" });
    log.append(renewed, { type: "failed", stage: "verifying", reason: "gate failed" });

    log.forgetHistory(beyondWindow());
    const types = (id: string) => log.events({ operationId: id }).map((row) => row.event.type);
    assert.ok(types(open).includes("run_started"), "an open operation keeps everything");
    assert.ok(types(retained).includes("run_started"), "unexpired retained source keeps its operation whole");
    assert.ok(!types(renewed).includes("run_started"), "expired evidence lets the explanation go");
    assert.deepEqual(types(renewed), ["submitted", "evidence_expired", "classified", "failed"]);

    // Inside the window nothing is touched at all.
    const inside = newOperationId();
    log.append(inside, submission("e".repeat(32), "recent-commit"));
    log.append(inside, { type: "run_started", runId: "run-recent", command: "bun install", host: "localhost" });
    log.append(inside, { type: "landed", base: "old", commitId: "recent-commit", branch: "main", remote: "origin" });
    assert.deepEqual(log.forgetHistory(), { events: 0, operations: 0 });
    assert.ok(types(inside).includes("run_started"));
  } finally { log.close(); }
});

test("an operation the caller still owes a read keeps its whole history", () => {
  const log = openLog();
  try {
    const owed = newOperationId();
    log.append(owed, submission("h".repeat(32), "owed-commit"));
    log.append(owed, { type: "run_started", runId: "run-owed", command: "bun run check", host: "localhost" });
    log.append(owed, { type: "landed", base: "old", commitId: "owed-commit", branch: "main", remote: "origin" });
    assert.deepEqual(log.forgetHistory(beyondWindow(), new Set([owed])), { events: 0, operations: 0 });
    assert.ok(log.events({ operationId: owed }).some((row) => row.event.type === "run_started"));
    assert.equal(log.forgetHistory(beyondWindow()).events, 2, "unnamed next time, the run and its queue snapshot go");
  } finally { log.close(); }
});

test("past the fact horizon even an operation's lasting facts go, unless something still owes them", () => {
  const log = openLog();
  try {
    const old = newOperationId();
    log.append(old, submission("i".repeat(32), "old-commit"));
    log.append(old, { type: "verification_passed", base: "old", candidate: "old-commit" });
    log.append(old, { type: "landed", base: "old", commitId: "old-commit", branch: "main", remote: "origin" });
    const owed = newOperationId();
    log.append(owed, submission("j".repeat(32), "owed-commit"));
    log.append(owed, { type: "landed", base: "old", commitId: "owed-commit", branch: "main", remote: "origin" });
    const horizon = new Date(Date.now() + LEDGER_FACT_MS + LEDGER_HISTORY_MS);
    // Inside the horizon its facts stay, even though the window has passed.
    log.forgetHistory(new Date(Date.now() + LEDGER_FACT_MS - 10 * DAY));
    assert.equal(log.lastLanded("owner/repo")?.commitId, "owed-commit");
    assert.equal(log.forgetHistory(horizon, new Set([owed])).operations, 1);
    assert.deepEqual(log.events({ operationId: old }), [], "a year on, the operation and its facts are gone");
    assert.equal(log.operation(old), null);
    assert.ok(log.events({ operationId: owed }).length > 0, "what a caller still owes stays whole");
    assert.equal(log.lastLanded("owner/repo")?.commitId, "owed-commit", "and reads still find it");
  } finally { log.close(); }
});

test("a settlement another operation owes survives the horizon, so a released hold does not come back", () => {
  const log = openLog();
  try {
    const commitId = "k".repeat(40);
    // An attempt the caller still owes a receipt: kept whole. Its hold is settled by a recovery operation.
    const attempt = newOperationId();
    log.append(attempt, submission("k".repeat(32), commitId));
    log.append(attempt, { type: "integration_held", repo: "owner/repo", commitId, reason: "push failed" });
    const recovery = newOperationId();
    log.append(recovery, { type: "submitted", kind: "recovery", repo: "owner/repo", commitId, submittedBy: "runner:recovery" });
    log.append(recovery, { type: "integration_released", repo: "owner/repo", commitId, reason: "push failed" });
    assert.deepEqual(log.held(), [], "the hold is released");
    log.forgetHistory(new Date(Date.now() + LEDGER_FACT_MS + LEDGER_HISTORY_MS), new Set([attempt]));
    assert.deepEqual(log.held(), [], "the settlement outlives the horizon while what it settled is kept");
    assert.ok(log.events({ operationId: recovery }).length > 0);
  } finally { log.close(); }
});

test("a repository's newest landing outlives the horizon, and older ones do not", () => {
  const log = openLog();
  try {
    const older = newOperationId();
    log.append(older, submission("l".repeat(32), "older-commit"));
    log.append(older, { type: "landed", base: "old", commitId: "older-commit", branch: "main", remote: "origin" });
    const newest = newOperationId();
    log.append(newest, submission("m".repeat(32), "newest-commit"));
    log.append(newest, { type: "landed", base: "old", commitId: "newest-commit", branch: "main", remote: "origin" });
    log.forgetHistory(new Date(Date.now() + LEDGER_FACT_MS + LEDGER_HISTORY_MS));
    assert.deepEqual(log.events({ operationId: older }), [], "an older landing is forgotten");
    assert.equal(log.lastLanded("owner/repo")?.commitId, "newest-commit", "the newest landing is what a deploy, reset or audit reads");
  } finally { log.close(); }
});

test("the newest landing of every repository outlives the horizon when its landed event names no repository", () => {
  const log = openLog();
  try {
    const first = newOperationId();
    log.append(first, submission("o".repeat(32), "first-commit"));
    log.append(first, { type: "landed", base: "old", commitId: "first-commit", branch: "main", remote: "origin" });
    const second = newOperationId();
    log.append(second, { type: "submitted", repo: "owner/other", changeId: "p".repeat(32), commitId: "second-commit",
      bookmark: candidateBookmark("p".repeat(32)), submittedBy: "author" });
    log.append(second, { type: "landed", base: "old", commitId: "second-commit", branch: "main", remote: "origin" });
    log.forgetHistory(new Date(Date.now() + LEDGER_FACT_MS + LEDGER_HISTORY_MS));
    assert.equal(log.lastLanded("owner/repo")?.commitId, "first-commit");
    assert.equal(log.lastLanded("owner/other")?.commitId, "second-commit", "a historic landed event names its repository only through its submission");
  } finally { log.close(); }
});

test("two expired attempts that name each other's commit expire together, while a kept operation still holds one", () => {
  const log = openLog();
  try {
    // Each attempt integrated the commit the other one submitted: neither is needed by anything else.
    const first = newOperationId(), second = newOperationId();
    log.append(first, submission("q".repeat(32), "alpha-commit"));
    log.append(first, { type: "integrated", base: "old", commitId: "beta-commit" });
    log.append(first, { type: "failed", stage: "integrating", reason: "gate failed" });
    log.append(second, submission("r".repeat(32), "beta-commit"));
    log.append(second, { type: "integrated", base: "old", commitId: "alpha-commit" });
    log.append(second, { type: "failed", stage: "integrating", reason: "gate failed" });
    const horizon = new Date(Date.now() + LEDGER_FACT_MS + LEDGER_HISTORY_MS);
    // Kept, the first still names the second, so the second keeps the facts that name it.
    log.forgetHistory(horizon, new Set([first]));
    assert.equal(log.operation(second)?.status, "failed");
    // Released, they name only each other, so both go rather than keep each other forever.
    log.forgetHistory(horizon);
    assert.equal(log.operation(first), null);
    assert.equal(log.operation(second), null);
  } finally { log.close(); }
});

test("a candidate a survivor keeps protects what it names, so a chain of settlements survives", () => {
  const log = openLog();
  try {
    // Kept A names commit X; expired B also names X and holds Y; expired recovery C releases Y.
    const held = newOperationId();
    log.append(held, submission("s".repeat(32), "x-commit"));
    log.append(held, { type: "integrated", base: "old", commitId: "x-commit" });
    const middle = newOperationId();
    log.append(middle, submission("t".repeat(32), "x-commit"));
    log.append(middle, { type: "integration_held", repo: "owner/repo", commitId: "y-commit", reason: "push failed" });
    log.append(middle, { type: "failed", stage: "integrating", reason: "gate failed" });
    const settling = newOperationId();
    log.append(settling, { type: "submitted", kind: "recovery", repo: "owner/repo", commitId: "y-commit", submittedBy: "runner:recovery" });
    log.append(settling, { type: "integration_released", repo: "owner/repo", commitId: "y-commit", reason: "push failed" });
    log.forgetHistory(new Date(Date.now() + LEDGER_FACT_MS + LEDGER_HISTORY_MS), new Set([held]));
    assert.notEqual(log.operation(middle), null, "the held attempt survives because a kept operation names its commit");
    assert.notEqual(log.operation(settling), null, "and the settlement it owes survives with it");
    assert.deepEqual(log.held(), [], "so the released hold does not come back");
  } finally { log.close(); }
});

test("the runner's own control events keep the newest pause, resume and delivery state past the horizon", () => {
  const log = openLog();
  try {
    log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "owner" });
    log.append(RUNNER_CONTROL_ID, { type: "integration_recovered", repo: "owner/repo", commitId: "n".repeat(40) });
    log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    log.append(RUNNER_CONTROL_ID, { type: "build_delivery", state: "available" });
    log.forgetHistory(new Date(Date.now() + LEDGER_FACT_MS + LEDGER_HISTORY_MS));
    assert.deepEqual(log.events({ operationId: RUNNER_CONTROL_ID }).map((row) => row.event.type), ["resumed", "paused", "build_delivery"],
      "the newest pause, resume and delivery state stay; the settlement nothing names goes");
    assert.equal(log.paused()?.by, "owner");
  } finally { log.close(); }
});

test("a control settlement a survivor names does not keep every other settlement alive", () => {
  const log = openLog();
  try {
    // A kept attempt names one commit; the control operation settled that one and two it does not name.
    const kept = newOperationId();
    log.append(kept, submission("u".repeat(32), "kept-commit"));
    log.append(kept, { type: "integrated", base: "old", commitId: "named-commit" });
    log.append(kept, { type: "failed", stage: "integrating", reason: "gate failed" });
    for (const commitId of ["named-commit", "other-commit", "third-commit"])
      log.append(RUNNER_CONTROL_ID, { type: "integration_released", repo: "owner/repo", commitId, reason: "push failed" });
    log.forgetHistory(new Date(Date.now() + LEDGER_FACT_MS + LEDGER_HISTORY_MS), new Set([kept]));
    const survives = (commitId: string) => log.events({ operationId: RUNNER_CONTROL_ID })
      .some((row) => (row.event as { commitId?: string }).commitId === commitId);
    assert.equal(survives("named-commit"), true, "the settlement the kept attempt names survives");
    assert.equal(survives("other-commit"), false, "an unrelated settlement goes");
    assert.equal(survives("third-commit"), false);
  } finally { log.close(); }
});

test("a checkpoint truncates the write-ahead log to the pages still in use", () => {
  const home = mkdtempSync(join(tmpdir(), "slipjay-ledger-wal-"));
  const path = join(home, "operations.sqlite");
  const log = openOperationLog(path, {}, { classify: classifyEvent });
  try {
    for (let index = 0; index < 500; index++)
      log.append(`op-${index}`, { type: "progress", line: `progress line ${index} `.repeat(20) });
    assert.ok(statSync(`${path}-wal`).size > 0);
    log.checkpoint();
    assert.equal(statSync(`${path}-wal`).size, 0);
  } finally {
    log.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("the queue projection answers a new append and a pause without a stale answer", () => {
  const log = openLog();
  try {
    const first = newOperationId();
    log.append(first, submission("f".repeat(32), "first-commit"));
    assert.equal(log.openOperations().length, 1);
    assert.equal(log.openOperations()[0]?.position, 1);
    const second = newOperationId();
    log.append(second, submission("g".repeat(32), "second-commit"));
    assert.deepEqual(log.openOperations().map((operation) => [operation.commitId, operation.position]), [["first-commit", 1], ["second-commit", 2]]);
    log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    assert.equal(log.openOperations()[0]?.stage, "paused");
    log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "owner" });
    assert.equal(log.openOperations()[0]?.stage, "queued");
    log.append(first, { type: "landed", base: "old", commitId: "first-commit", branch: "main", remote: "origin" });
    assert.deepEqual(log.openOperations().map((operation) => operation.commitId), ["second-commit"]);
  } finally { log.close(); }
});
