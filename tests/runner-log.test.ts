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
      id, kind: "landing", repo: "owner/repo", changeId: "k".repeat(32), commitId: "commit", bookmark: candidateBookmark("k".repeat(32)), submittedBy: "author",
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

test("a release is an operation in the same queue, and queued work names the operation it waits behind", () => {
  const log = openOperationLog(":memory:");
  try {
    const candidate = "c".repeat(40);
    log.append("release", { type: "submitted", kind: "release", repo: "owner/repo", commitId: candidate, migrationsReady: true, submittedBy: "author" });
    log.append("landing", submission());
    assert.equal(log.operation("landing")?.waitingFor, undefined, "nothing runs yet");
    log.append("release", { type: "stage", stage: "verifying" });
    const release = log.operation("release")!;
    assert.equal(release.kind, "release");
    assert.ok(release.kind === "release" && release.migrationsReady);
    assert.equal(release.waitingFor, undefined);
    assert.deepEqual(log.openOperations().map((op) => [op.id, op.position, op.waitingFor]),
      [["release", 1, undefined], ["landing", 2, `release ${candidate.slice(0, 12)}`]]);
    assert.equal(log.operation("landing")?.waitingFor, `release ${candidate.slice(0, 12)}`);
    assert.deepEqual(log.operationsForChange("owner/repo", "k".repeat(32)).map((op) => op.id), ["landing"], "releases are not changes");
    log.append("release", { type: "failed", stage: "verifying", reason: "test terminal" });
    assert.equal(log.operation("release")?.status, "failed");
    assert.equal(log.operation("landing")?.waitingFor, undefined);
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

test("deploys queue in their own lane, project their records, and the latest landing of a repository is known", () => {
  const log = openOperationLog(":memory:");
  try {
    const commit = "d".repeat(40);
    log.append("landing", submission());
    log.append("landing", { type: "stage", stage: "verifying" });
    log.append("deploy", { type: "submitted", kind: "deploy", repo: "owner/repo", environment: "staging", commitId: commit, submittedBy: "runner:schedule" });
    const queued = log.operation("deploy")!;
    assert.equal(queued.kind, "deploy");
    assert.ok(queued.kind === "deploy" && queued.environment === "staging");
    assert.equal(queued.position, 1, "a deploy never waits behind a landing");
    assert.equal(queued.waitingFor, undefined);
    assert.equal(log.lastLanded("owner/repo"), null);
    log.append("landing", { type: "landed", base: "base", commitId: commit, branch: "main", remote: "origin" });
    assert.equal(log.lastLanded("owner/repo")?.commitId, commit);
    assert.equal(log.lastLanded("other/repo"), null);
    const record = { environment: "staging", commitId: commit, previous: null, changes: [{ commitId: commit, subject: "Add a" }], projects: [{ name: "app", ok: true, url: "https://app.example" }] };
    log.append("deploy", { type: "stage", stage: "deploying" });
    log.append("deploy", { type: "deployed", record });
    const deployed = log.operation("deploy")!;
    assert.equal(deployed.status, "deployed");
    assert.deepEqual(deployed.result, { type: "deployed", record });
    assert.deepEqual(log.deployments("owner/repo").map((op) => op.id), ["deploy"]);
    assert.deepEqual(log.deployments("owner/repo", "production"), []);
    assert.deepEqual(log.operationsForChange("owner/repo", "k".repeat(32)).map((op) => op.id), ["landing"], "deploys are not changes");
  } finally {
    log.close();
  }
});

test("a repository's releases list newest first, without its deploys or other repositories' releases", () => {
  const log = openOperationLog(":memory:");
  try {
    const release = (id: string, repo: string) => log.append(id, { type: "submitted", kind: "release", repo, commitId: "e".repeat(40), migrationsReady: false, submittedBy: "author" });
    release("first", "owner/repo");
    release("other", "owner/other");
    log.append("deploy", { type: "submitted", kind: "deploy", repo: "owner/repo", environment: "staging", commitId: "d".repeat(40), submittedBy: "author" });
    release("second", "owner/repo");
    assert.deepEqual(log.releases("owner/repo").map((op) => [op.id, op.kind, op.position]), [["second", "release", 3], ["first", "release", 1]]);
    assert.deepEqual(log.releases("owner/none"), []);
  } finally {
    log.close();
  }
});

test("a repository's resets share the landing lane, list newest first and close with their target and source", () => {
  const log = openOperationLog(":memory:");
  try {
    const reset = (id: string, repo: string) => log.append(id, { type: "submitted", kind: "reset", repo, commitId: "e".repeat(40), submittedBy: "schedule" });
    reset("first", "owner/repo");
    log.append("landing", submission());
    reset("other", "owner/other");
    reset("second", "owner/repo");
    log.append("first", { type: "stage", stage: "resetting" });
    assert.equal(log.operation("landing")!.waitingFor, `reset ${"e".repeat(12)}`);
    log.append("first", { type: "reset", target: "db", source: "f".repeat(40) });
    assert.deepEqual(log.resets("owner/repo").map((op) => [op.id, op.kind, op.status, op.position]), [["second", "reset", "queued", 3], ["first", "reset", "reset", undefined]]);
    assert.deepEqual(log.resets("owner/repo")[1]!.result, { type: "reset", target: "db", source: "f".repeat(40) });
    assert.deepEqual(log.resets("owner/none"), []);
  } finally {
    log.close();
  }
});

test("atomic watch snapshot includes both lanes, cursor, holds and subscriptions", () => {
  const log = openOperationLog(":memory:");
  try {
    const seen: number[] = [];
    const unsubscribe = log.subscribe((event) => seen.push(event.seq));
    log.append("landing", submission("owner/a"));
    log.append("deploy", { type: "submitted", kind: "deploy", repo: "owner/b", commitId: "d", environment: "staging", submittedBy: "owner" });
    const stage = log.append("landing", { type: "stage", stage: "verifying" });
    log.append("held", { type: "integration_held", repo: "owner/a", commitId: "h", reason: "push refused" });
    const last = log.append("control", { type: "paused", by: "owner" });
    const snapshot = log.snapshot("runner", new Date("2026-10-14T10:00:00Z"));
    assert.equal(snapshot.seq, last.seq);
    assert.equal(snapshot.lanes.serial[0]?.stageStartedAt, stage.at);
    assert.equal(snapshot.lanes.deploy[0]?.id, "deploy");
    assert.equal(snapshot.held[0]?.commitId, "h");
    assert.equal(snapshot.paused, null); // runner control has a reserved operation id
    assert.deepEqual(snapshot.lastSuite, { status: "unavailable" });
    unsubscribe(); log.append("other", submission()); assert.equal(seen.length, 5);
  } finally { log.close(); }
});

test("snapshot hold SQL preserves repository lifecycle and ignores obsolete recovery", () => {
  const log = openOperationLog(":memory:");
  try {
    const hold = (repo: string, commitId: string, reason = "blocked") => log.append("control", { type: "integration_held", repo, commitId, reason });
    const recover = (repo: string, commitId: string) => log.append("control", { type: "integration_recovered", repo, commitId });
    const first = hold("a", "A");
    hold("b", "other");
    hold("a", "A", "retry");
    recover("a", "wrong");
    assert.deepEqual(log.snapshot("runner").held.find((entry) => entry.repo === "a"), { repo: "a", commitId: "A", since: first.at, reason: "retry", retries: 1 });
    assert.equal(log.snapshot("runner").held.length, 2);
    recover("a", "A");
    assert.deepEqual(log.snapshot("runner").held.map((entry) => entry.repo), ["b"]);
    const again = hold("a", "A");
    assert.deepEqual(log.snapshot("runner").held.find((entry) => entry.repo === "a"), { repo: "a", commitId: "A", since: again.at, reason: "blocked", retries: 0 });
    const newer = hold("a", "B");
    recover("a", "A");
    assert.deepEqual(log.snapshot("runner").held.find((entry) => entry.repo === "a"), { repo: "a", commitId: "B", since: newer.at, reason: "blocked", retries: 0 });
    hold("a", "B");
    assert.equal(log.snapshot("runner").held.find((entry) => entry.repo === "a")?.retries, 1);
    recover("a", "B");
    assert.deepEqual(log.snapshot("runner").held.map((entry) => entry.repo), ["b"]);
  } finally { log.close(); }
});

test("snapshot latest staging attempt includes failure after success and a failure-only repository", () => {
  const log = openOperationLog(":memory:");
  try {
    const deploy = (id: string, repo: string) => log.append(id, { type: "submitted", kind: "deploy", repo, environment: "staging", commitId: id, submittedBy: "owner" });
    deploy("success-A", "a");
    log.append("success-A", { type: "deployed", record: { environment: "staging", commitId: "success-A", previous: null, changes: [], projects: [] } });
    deploy("failed-B", "a"); log.append("failed-B", { type: "failed", stage: "deploying", reason: "failed" });
    deploy("only-failed", "b"); log.append("only-failed", { type: "failed", stage: "deploying", reason: "also failed" });
    assert.deepEqual(log.snapshot("runner").lastStagingDeploys.map((op) => [op.id, op.status, op.result?.type]), [["failed-B", "failed", "failed"], ["only-failed", "failed", "failed"]]);
  } finally { log.close(); }
});

test("snapshot retains a completed production outcome for a new watcher", () => {
  const log = openOperationLog(":memory:");
  try {
    log.append("production", { type: "submitted", kind: "deploy", repo: "owner/repo", environment: "production", commitId: "candidate", submittedBy: "owner" });
    log.append("production", { type: "failed", stage: "deploying", reason: "health failed", deployment: {
      environment: "production", commitId: "candidate", previous: "previous", changes: [], projects: [],
      rollback: { automatic: true, reason: "health failed" },
    } });
    const snapshot = log.snapshot("runner");
    assert.deepEqual(snapshot.lanes.deploy, []);
    const outcome = snapshot.recentProductionDeploys[0];
    assert.equal(outcome?.id, "production");
    assert.equal(outcome?.result?.type === "failed" && outcome.result.deployment?.rollback?.automatic, true);
  } finally { log.close(); }
});
