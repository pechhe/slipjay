import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { candidateBookmark } from "../src/lib/runner-contract.ts";
import type { OperationEvent } from "../src/lib/runner-contract.ts";
import { newOperationId, openOperationLog } from "../src/lib/runner-log.ts";

function submission(repo = "owner/repo", changeId = "k".repeat(32), commitId = "commit"): OperationEvent {
  return { type: "submitted", repo, changeId, commitId, bookmark: candidateBookmark(changeId), submittedBy: "author" };
}

test("operation log projects stages, command runs and the latest terminal result", () => {
  const log = openOperationLog(":memory:");
  try {
    assert.equal(log.operation("unknown"), null);
    const id = newOperationId();
    const submitted = log.append(id, submission());
    log.append(id, { type: "stage", stage: "queued" });
    assert.equal(log.operation(id)?.status, "queued");
    log.append(id, { type: "stage", stage: "verifying" });
    const started = log.append(id, { type: "run_started", runId: "run-1", command: "bun run check", host: "localhost" });
    const finished = log.append(id, { type: "run_finished", runId: "run-1", exitCode: 0, signal: null, timedOut: false, durationMs: 50 });
    log.append(id, { type: "run_started", runId: "run-2", command: "git push", host: "remote" });
    assert.equal(log.operation(id)?.status, "running");
    log.append(id, { type: "stage", stage: "publishing" });
    const landed = log.append(id, { type: "landed", base: "old", commitId: "new", branch: "main", remote: "origin" });
    assert.deepEqual(log.operation(id), {
      id, repo: "owner/repo", changeId: "k".repeat(32), commitId: "commit", bookmark: candidateBookmark("k".repeat(32)), submittedBy: "author",
      status: "landed", stage: "publishing", submittedAt: submitted.at, finishedAt: landed.at,
      runs: [
        { runId: "run-1", command: "bun run check", host: "localhost", startedAt: started.at, finishedAt: finished.at, exitCode: 0, signal: null, timedOut: false, durationMs: 50 },
        { runId: "run-2", command: "git push", host: "remote", startedAt: log.events({ operationId: id })[5]!.at },
      ],
      result: landed.event, lastSeq: landed.seq,
    });
    const failed = log.append(id, { type: "failed", stage: "publishing", reason: "later failure" });
    assert.equal(log.operation(id)?.status, "failed");
    assert.deepEqual(log.operation(id)?.result, failed.event);
    assert.equal(log.operation(id)?.finishedAt, failed.at);
    assert.deepEqual(log.events({ operationId: id, afterSeq: landed.seq }), [failed]);
    assert.deepEqual(log.openOperations(), []);
  } finally {
    log.close();
  }
});

test("queue positions follow submitted sequence across repos and close without a position", () => {
  const log = openOperationLog(":memory:");
  try {
    log.append("first", submission());
    log.append("other", submission("owner/other"));
    log.append("second", submission());
    log.append("first", { type: "stage", stage: "verifying" });
    assert.deepEqual(log.openOperations().map((op) => [op.id, op.position]), [["first", 1], ["other", 2], ["second", 3]]);
    assert.deepEqual(log.openOperations("owner/repo").map((op) => op.id), ["first", "second"]);
    log.append("first", { type: "cancelled", reason: "test terminal" });
    assert.equal(log.operation("first")?.position, undefined);
    assert.equal(log.operation("second")?.position, 2);
    assert.deepEqual(log.operationsForChange("owner/repo", "k".repeat(32)).map((op) => op.id), ["second", "first"]);
    assert.deepEqual(log.operationsForChange("owner/repo", "z".repeat(32)), []);
  } finally {
    log.close();
  }
});

test("file log preserves every appended event and increasing global sequence across reopening", () => {
  const directory = mkdtempSync(join(tmpdir(), "runner-log-"));
  const path = join(directory, "events.sqlite");
  let log = openOperationLog(path);
  try {
    const first = log.append("one", submission());
    const second = log.append("two", submission());
    assert.ok(second.seq > first.seq);
    log.close();
    log = openOperationLog(path);
    assert.deepEqual(log.events(), [first, second]);
    const third = log.append("one", { type: "superseded", by: "two" });
    assert.ok(third.seq > second.seq);
    assert.deepEqual(log.events(), [first, second, third]);
    assert.deepEqual(log.events({ operationId: "one" }), [first, third]);
  } finally {
    log.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
