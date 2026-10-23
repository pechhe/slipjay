import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { candidateBookmark, OWNER_KILL_REASON, RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import type { LandingOperation, OperationEvent } from "../../src/lib/runner/runner-types.ts";
import { newOperationId, openOperationLog } from "../../src/lib/runner/runner-log.ts";
import type { OperationLogOptions } from "../../src/lib/runner/runner-log.ts";
import { classifyEvent } from "../../src/lib/runner/failure-classification.ts";
import { projectWatchOperation } from "../../src/lib/runner/runner-watch-projection.ts";

/** The log as the runner composes it: this file's subject is the store and the projections it records. */
const openLog = (path = ":memory:", options: OperationLogOptions = {}) => openOperationLog(path, options, { classify: classifyEvent, watch: projectWatchOperation });

function submission(repo = "owner/repo", changeId = "k".repeat(32), commitId = "commit"): OperationEvent {
  return { type: "submitted", repo, changeId, commitId, bookmark: candidateBookmark(changeId), submittedBy: "author" };
}

test("a successful retry is counted separately from observing external publication", () => {
  const log = openLog(":memory:");
  try {
    log.append("failed", { type: "integration_held", repo: "owner/repo", commitId: "first", reason: "push failed" });
    log.append("retry", { type: "integration_recovered", repo: "owner/repo", commitId: "first", retried: true });
    const retried = log.events({ operationId: "retry" }).find((row) => row.event.type === "held")?.event;
    assert.equal(retried?.type === "held" && retried.retries, 1);
    log.append("failed", { type: "integration_held", repo: "owner/repo", commitId: "second", reason: "publication unknown" });
    log.append("runner", { type: "integration_recovered", repo: "owner/repo", commitId: "second" });
    const observed = log.events({ operationId: "runner" }).find((row) => row.event.type === "held")?.event;
    assert.equal(observed?.type === "held" && observed.retries, 0);
  } finally { log.close(); }
});

test("operation log projects stages, command runs and the latest terminal result", () => {
  const log = openLog(":memory:");
  try {
    assert.equal(log.operation("unknown"), null);
    const id = newOperationId();
    const submitted = log.append(id, submission());
    log.append(id, { type: "stage", stage: "queued" });
    assert.equal(log.operation(id)?.status, "queued");
    const left = log.append(id, { type: "stage", stage: "verifying" });
    const started = log.append(id, { type: "run_started", runId: "run-1", command: "bun run check", host: "localhost" });
    const finished = log.append(id, { type: "run_finished", runId: "run-1", exitCode: 0, signal: null, timedOut: false, durationMs: 50 });
    log.append(id, { type: "run_started", runId: "run-2", command: "git push", host: "remote" });
    assert.equal(log.operation(id)?.status, "running");
    log.append(id, { type: "stage", stage: "publishing" });
    const landed = log.append(id, { type: "landed", base: "old", commitId: "new", branch: "main", remote: "origin" });
    const { outcome: _outcome, ...legacyFields } = log.operation(id) as LandingOperation;
    assert.deepEqual(legacyFields, {
      id, kind: "landing", repo: "owner/repo", changeId: "k".repeat(32), commitId: "commit", bookmark: candidateBookmark("k".repeat(32)), submittedBy: "author",
      status: "landed", stage: "publishing", submittedAt: submitted.at, startedAt: left.at, finishedAt: landed.at,
      runs: [
        { runId: "run-1", command: "bun run check", host: "localhost", startedAt: started.at, finishedAt: finished.at, exitCode: 0, signal: null, timedOut: false, durationMs: 50 },
        { runId: "run-2", command: "git push", host: "remote", startedAt: log.events({ operationId: id }).find((row) => row.event.type === "run_started" && row.event.runId === "run-2")!.at },
      ],
      result: landed.event, lastSeq: landed.seq,
    });
    const failed = log.append(id, { type: "failed", stage: "publishing", reason: "later failure" });
    assert.equal(log.operation(id)?.status, "failed");
    assert.deepEqual(log.operation(id)?.result, failed.event);
    assert.equal(log.operation(id)?.finishedAt, failed.at);
    const terminalEvents = log.events({ operationId: id, afterSeq: landed.seq });
    assert.deepEqual(terminalEvents.map((row) => row.event.type), ["classified", "failed"]);
    assert.deepEqual(terminalEvents[0]?.event, {
      type: "classified", ruleVersion: 1, cause: "infrastructure", command: "git push", failingTests: [], diagnostics: [],
    });
    assert.deepEqual(terminalEvents[1], failed);
    assert.deepEqual(log.openOperations(), []);
  } finally {
    log.close();
  }
});

test("queue positions follow submitted sequence within each repository and close without a position", () => {
  const log = openLog(":memory:", { workers: 1 });
  try {
    log.append("first", submission());
    log.append("other", submission("owner/other"));
    log.append("second", submission());
    log.append("first", { type: "stage", stage: "verifying" });
    assert.deepEqual(log.openOperations().map((op) => [op.id, op.position]), [["first", 1], ["other", 1], ["second", 2]]);
    // Another repository's operation waits for no landing of this one, only for a free worker.
    assert.equal(log.operation("other")?.waitingFor, `a worker (landing ${"k".repeat(12)})`);
    const two = openLog(":memory:");
    two.append("first", submission());
    two.append("other", submission("owner/other"));
    two.append("first", { type: "stage", stage: "verifying" });
    assert.equal(two.operation("other")?.waitingFor, undefined, "with a worker free, nothing holds it");
    two.close();
    const shared = openLog(":memory:", { lane: () => "shared" });
    shared.append("first", submission());
    shared.append("other", submission("owner/other"));
    shared.append("first", { type: "stage", stage: "verifying" });
    assert.deepEqual([shared.operation("other")?.position, shared.operation("other")?.waitingFor], [2, `landing ${"k".repeat(12)}`], "repositories sharing a lane queue together");
    shared.close();
    assert.equal(log.operation("second")?.waitingFor, `landing ${"k".repeat(12)}`);
    assert.deepEqual(log.openOperations("owner/repo").map((op) => op.id), ["first", "second"]);
    log.append("first", { type: "cancelled", reason: "test terminal" });
    assert.equal(log.operation("first")?.position, undefined);
    assert.equal(log.operation("second")?.position, 1);
    assert.deepEqual(log.operationsForChange("owner/repo", "k".repeat(32)).map((op) => op.id), ["second", "first"]);
    assert.deepEqual(log.operationsForChange("owner/repo", "z".repeat(32)), []);
  } finally {
    log.close();
  }
});

test("a release verifies in a lane of its own, and queued work waits behind it only while it publishes", () => {
  const log = openLog(":memory:");
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
      [["release", 1, undefined], ["landing", 1, undefined]]);
    log.append("release", { type: "stage", stage: "publishing" });
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
  let log = openLog(path);
  try {
    const first = log.append("one", submission());
    const second = log.append("two", submission());
    assert.ok(second.seq > first.seq);
    log.close();
    log = openLog(path);
    const persisted = log.events();
    assert.deepEqual(persisted.map((row) => row.event.type), ["submitted", "queue_snapshot", "submitted", "queue_snapshot"]);
    assert.deepEqual(log.events(), persisted, "derived and direct events survive reopening");
    const third = log.append("one", { type: "superseded", by: "two" });
    assert.ok(third.seq > second.seq);
    assert.deepEqual(log.events().slice(0, persisted.length), persisted);
    assert.deepEqual(log.events().slice(-2).map((row) => row.event.type), ["classified", "superseded"]);
    assert.deepEqual(log.events({ operationId: "one" }).map((row) => row.event.type), ["submitted", "queue_snapshot", "classified", "superseded"]);
  } finally {
    log.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deploys queue in their own lane, project their records, and the latest landing of a repository is known", () => {
  const log = openLog(":memory:");
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
  const log = openLog(":memory:");
  try {
    const release = (id: string, repo: string) => log.append(id, { type: "submitted", kind: "release", repo, commitId: "e".repeat(40), migrationsReady: false, submittedBy: "author" });
    release("first", "owner/repo");
    release("other", "owner/other");
    log.append("deploy", { type: "submitted", kind: "deploy", repo: "owner/repo", environment: "staging", commitId: "d".repeat(40), submittedBy: "author" });
    release("second", "owner/repo");
    assert.deepEqual(log.releases("owner/repo").map((op) => [op.id, op.kind, op.position]), [["second", "release", 2], ["first", "release", 1]]);
    assert.deepEqual(log.releases("owner/none"), []);
  } finally {
    log.close();
  }
});

test("a repository's resets share the landing lane, list newest first and close with their target and source", () => {
  const log = openLog(":memory:");
  try {
    const reset = (id: string, repo: string) => log.append(id, { type: "submitted", kind: "reset", repo, commitId: "e".repeat(40), submittedBy: "schedule" });
    reset("first", "owner/repo");
    log.append("landing", submission());
    reset("other", "owner/other");
    reset("second", "owner/repo");
    log.append("first", { type: "stage", stage: "resetting" });
    assert.equal(log.operation("landing")!.waitingFor, `reset ${"e".repeat(12)}`);
    log.append("first", { type: "reset", target: "db", source: "f".repeat(40) });
    assert.deepEqual(log.resets("owner/repo").map((op) => [op.id, op.kind, op.status, op.position]), [["second", "reset", "queued", 2], ["first", "reset", "reset", undefined]]);
    assert.deepEqual(log.resets("owner/repo")[1]!.result, { type: "reset", target: "db", source: "f".repeat(40) });
    assert.deepEqual(log.resets("owner/none"), []);
  } finally {
    log.close();
  }
});

test("atomic watch snapshot includes both lanes, cursor, holds and subscriptions", () => {
  const log = openLog(":memory:");
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
    unsubscribe(); log.append("other", submission()); assert.equal(seen.length, 8);
  } finally { log.close(); }
});

test("watch snapshots retain every queued and running operation in order in both lanes", () => {
  const log = openLog(":memory:");
  try {
    log.append("serial-running", submission("owner/a", "first"));
    log.append("deploy-running", { type: "submitted", kind: "deploy", repo: "owner/a", environment: "staging", commitId: "first", submittedBy: "owner" });
    log.append("serial-running", { type: "stage", stage: "verifying" });
    log.append("deploy-running", { type: "stage", stage: "deploying" });
    for (const index of [1, 2, 3]) {
      log.append(`serial-queued-${index}`, submission("owner/a", `change-${index}`));
      log.append(`deploy-queued-${index}`, { type: "submitted", kind: "deploy", repo: "owner/a", environment: "staging", commitId: `commit-${index}`, submittedBy: "owner" });
    }
    const snapshot = log.snapshot("runner");
    for (const [lane, prefix] of [[snapshot.lanes.serial, "serial"], [snapshot.lanes.deploy, "deploy"]] as const) {
      assert.deepEqual(lane.map((operation) => [operation.id, operation.status, operation.position]), [
        [`${prefix}-running`, "running", 1],
        [`${prefix}-queued-1`, "queued", 2],
        [`${prefix}-queued-2`, "queued", 3],
        [`${prefix}-queued-3`, "queued", 4],
      ]);
    }
  } finally { log.close(); }
});

test("snapshot hold SQL preserves repository lifecycle and ignores obsolete recovery", () => {
  const log = openLog(":memory:");
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
  const log = openLog(":memory:");
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
  const log = openLog(":memory:");
  try {
    log.append("production", { type: "submitted", kind: "deploy", repo: "owner/repo", environment: "production", commitId: "candidate", submittedBy: "owner" });
    log.append("production", { type: "failed", stage: "deploying", reason: "health failed", deployment: {
      environment: "production", commitId: "candidate", previous: "previous", changes: [], projects: [],
      rollback: { automatic: true, reason: "health failed" },
    } });
    log.append("production", { type: "run_started", runId: "run-1", command: "bun scripts/deploy.ts", host: "runner" });
    const snapshot = log.snapshot("runner");
    assert.deepEqual(snapshot.lanes.deploy, []);
    const outcome = snapshot.recentProductionDeploys[0];
    assert.equal(outcome?.id, "production");
    assert.equal(outcome?.result?.type === "failed" && outcome.result.deployment?.rollback?.automatic, true);
    assert.equal(outcome !== undefined && "runs" in outcome, false);
  } finally { log.close(); }
});

test("terminal classifications record versioned killed, paused, superseded and held causes", () => {
  const log = openLog(":memory:");
  try {
    log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    log.append("killed", submission());
    log.append("killed", { type: "cancelled", reason: OWNER_KILL_REASON });
    log.append("paused", submission("owner/repo", "z".repeat(32)));
    log.append("paused", { type: "cancelled", reason: "cancelled while the runner was paused" });
    log.append("superseded", submission("owner/repo", "y".repeat(32)));
    log.append("superseded", { type: "superseded", by: "newer" });
    log.append("held", submission("owner/repo", "x".repeat(32)));
    log.append("held", { type: "integrated", base: "base", commitId: "commit" });
    log.append("held", { type: "failed", stage: "publishing", reason: "publication was not confirmed" });

    const cause = (id: string) => log.events({ operationId: id }).find((row) => row.event.type === "classified")?.event;
    for (const [id, expected] of [["killed", "killed"], ["paused", "paused_out"], ["superseded", "superseded"], ["held", "held"]] as const) {
      assert.deepEqual(cause(id), {
        type: "classified", ruleVersion: 1, cause: expected, failingTests: [], diagnostics: [],
      });
    }
  } finally { log.close(); }
});

test("a same-commit retry records when an earlier base passed and the new base failed", () => {
  const log = openLog(":memory:");
  try {
    const old = log.append("old-base", submission());
    log.append("old-base", { type: "verification_base", base: "base-old" });
    log.append("old-base", { type: "run_started", runId: "old-run", command: "vp test run", host: "runner" });
    log.append("old-base", { type: "run_finished", runId: "old-run", exitCode: 0, signal: null, timedOut: false, durationMs: 10, testBodyRan: true });
    log.append("old-base", { type: "verification_passed", base: "base-old", candidate: "commit" });
    log.append("old-base", { type: "integrated", base: "base-old", commitId: "commit" });
    log.append("old-base", { type: "failed", stage: "publishing", reason: "publication held" });
    const current = log.append("new-base", submission());
    assert.ok(current.seq > old.seq);
    log.append("new-base", { type: "verification_base", base: "base-new" });
    log.append("new-base", { type: "stage", stage: "verifying" });
    log.append("new-base", { type: "run_started", runId: "new-run", command: "vp test run", host: "runner" });
    log.append("new-base", { type: "run_finished", runId: "new-run", exitCode: 1, signal: null, timedOut: false, durationMs: 12, testBodyRan: true });
    log.append("new-base", { type: "failed", stage: "verifying", reason: "test failed", command: "vp test run", output: " FAIL tests/plan.test.ts > rejects route" });
    assert.deepEqual(log.events({ operationId: "new-base" }).find((row) => row.event.type === "classified")?.event, {
      type: "classified", ruleVersion: 1, cause: "gate", command: "vp test run",
      failingTests: ["tests/plan.test.ts > rejects route"], diagnostics: [],
      interaction: { earlierOperation: "old-base", fromBase: "base-old", toBase: "base-new" },
    });
  } finally { log.close(); }
});

test("an incomplete earlier verification run does not establish a passing interaction", () => {
  const log = openLog(":memory:");
  try {
    log.append("interrupted", submission());
    log.append("interrupted", { type: "verification_base", base: "base-old" });
    log.append("interrupted", { type: "run_started", runId: "check-1", command: "vp test run", host: "runner" });
    log.append("interrupted", { type: "run_finished", runId: "check-1", exitCode: 0, signal: null, timedOut: false, durationMs: 10, testBodyRan: true });
    log.append("interrupted", { type: "run_started", runId: "check-2", command: "bun run check:changed", host: "runner" });
    log.append("interrupted", { type: "failed", stage: "verifying", reason: "runner restarted during verification" });

    log.append("retry", submission());
    log.append("retry", { type: "verification_base", base: "base-new" });
    log.append("retry", { type: "run_started", runId: "retry-run", command: "vp test run", host: "runner" });
    log.append("retry", { type: "run_finished", runId: "retry-run", exitCode: 1, signal: null, timedOut: false, durationMs: 12, testBodyRan: true });
    log.append("retry", { type: "failed", stage: "verifying", reason: "test failed", command: "vp test run", output: " FAIL tests/plan.test.ts > rejects route" });

    const classified = log.events({ operationId: "retry" }).find((row) => row.event.type === "classified")?.event;
    assert.deepEqual(classified, {
      type: "classified", ruleVersion: 1, cause: "gate", command: "vp test run",
      failingTests: ["tests/plan.test.ts > rejects route"], diagnostics: [],
    });
  } finally { log.close(); }
});

test("held facts retain retry count, elapsed time and publication outcome", () => {
  const log = openLog(":memory:");
  const originalNow = Date.now;
  try {
    const first = log.append("control", { type: "integration_held", repo: "owner/repo", commitId: "commit", reason: "push refused" });
    Date.now = () => Date.parse(first.at) + 5_000;
    log.append("control", { type: "integration_held", repo: "owner/repo", commitId: "commit", reason: "push still refused" });
    const retry = log.events().filter((row) => row.event.type === "held").at(-1)?.event;
    assert.deepEqual(retry, { type: "held", repo: "owner/repo", commitId: "commit", retries: 1, durationMs: 5_000, published: false });

    Date.now = () => Date.parse(first.at) + 8_000;
    log.append("control", { type: "integration_recovered", repo: "owner/repo", commitId: "commit" });
    const published = log.events().filter((row) => row.event.type === "held").at(-1)?.event;
    assert.deepEqual(published, { type: "held", repo: "owner/repo", commitId: "commit", retries: 1, durationMs: 8_000, published: true });
  } finally {
    Date.now = originalNow;
    log.close();
  }
});

type FailedVerification = Extract<OperationEvent, { type: "failed" }>;
function failedChecks(log: ReturnType<typeof openOperationLog>, id: string, checks: { runId: string; command: string; timedOut?: boolean; testBodyRan: boolean; failingTests?: string[] }[]): void {
  log.append(id, submission("owner/repo", "k".repeat(32), "commit"));
  log.append(id, { type: "stage", stage: "verifying" });
  for (const check of checks) {
    log.append(id, { type: "run_started", runId: check.runId, command: check.command, host: "runner" });
    log.append(id, { type: "run_finished", runId: check.runId, exitCode: check.timedOut ? null : 1, signal: null, timedOut: check.timedOut ?? false, durationMs: 5,
      testBodyRan: check.testBodyRan, ...check.failingTests ? { failingTests: check.failingTests } : {} });
  }
  const failures: NonNullable<FailedVerification["failures"]> = checks.map((check, checkIndex) => ({ checkIndex, command: check.command, outcome: check.timedOut ? "timeout" : "nonzero_exit", runId: check.runId }));
  log.append(id, { type: "failed", stage: "verifying", reason: "index", command: checks[0]!.command, failures });
}
const classifiedOf = (log: ReturnType<typeof openOperationLog>, id: string) => {
  const fact = log.events({ operationId: id }).find((row) => row.event.type === "classified")?.event;
  return fact?.type === "classified" ? fact : undefined;
};

test("two identical failed commands are classified from their own runs, matched by runId", () => {
  const log = openLog(":memory:");
  try {
    failedChecks(log, "twice", [
      { runId: "first", command: "vp test run", timedOut: true, testBodyRan: false },
      { runId: "second", command: "vp test run", testBodyRan: true, failingTests: ["tests/a.test.ts > breaks"] },
    ]);
    const fact = classifiedOf(log, "twice");
    assert.equal(fact?.cause, "gate");
    assert.deepEqual(fact?.checks?.map((check) => [check.runId, check.cause]), [["first", "infrastructure"], ["second", "gate"]]);
  } finally { log.close(); }
});

test("a check timeout without a test body is infrastructure alone and gate beside a failing test", () => {
  const log = openLog(":memory:");
  try {
    failedChecks(log, "timeout-only", [{ runId: "t", command: "bun run check:slow", timedOut: true, testBodyRan: false }]);
    failedChecks(log, "mixed", [
      { runId: "m1", command: "bun run check:slow", timedOut: true, testBodyRan: false },
      { runId: "m2", command: "vp test run", testBodyRan: true, failingTests: ["tests/a.test.ts > breaks"] },
    ]);
    assert.equal(classifiedOf(log, "timeout-only")?.cause, "infrastructure");
    assert.equal(classifiedOf(log, "mixed")?.cause, "gate");
    assert.deepEqual(classifiedOf(log, "mixed")?.failingTests, ["tests/a.test.ts > breaks"]);
    assert.deepEqual(classifiedOf(log, "mixed")?.checks?.map((check) => check.failingTests), [[], ["tests/a.test.ts > breaks"]]);
  } finally { log.close(); }
});

test("an owner kill after an earlier failed check is classified killed, never gate", () => {
  const log = openLog(":memory:");
  try {
    log.append("killed", submission());
    log.append("killed", { type: "run_started", runId: "k1", command: "vp test run", host: "runner" });
    log.append("killed", { type: "run_finished", runId: "k1", exitCode: 1, signal: null, timedOut: false, durationMs: 5, testBodyRan: true });
    log.append("killed", { type: "cancelled", reason: OWNER_KILL_REASON });
    assert.equal(classifiedOf(log, "killed")?.cause, "killed");
    assert.equal(classifiedOf(log, "killed")?.checks, undefined);
  } finally { log.close(); }
});

test("a failed event without failures classifies one run by command as before", () => {
  const log = openLog(":memory:");
  try {
    log.append("legacy", submission());
    log.append("legacy", { type: "run_started", runId: "l1", command: "vp test run", host: "runner" });
    log.append("legacy", { type: "run_finished", runId: "l1", exitCode: 1, signal: null, timedOut: false, durationMs: 5, testBodyRan: true });
    log.append("legacy", { type: "failed", stage: "verifying", reason: "failed", command: "vp test run" });
    assert.equal(classifiedOf(log, "legacy")?.cause, "gate");
    assert.equal(classifiedOf(log, "legacy")?.checks, undefined);
  } finally { log.close(); }
});
