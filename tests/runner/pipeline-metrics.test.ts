import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { formatPipelineMetrics, pipelineMetrics } from "../../src/lib/runner/pipeline-metrics.ts";
import type { OperationEvent, StoredEvent } from "../../src/lib/runner/runner-contract.ts";

const at = (ms: number): string => new Date(ms).toISOString();
const row = (seq: number, operationId: string, ms: number, event: OperationEvent): StoredEvent => ({ seq, operationId, at: at(ms), event });
const submitted = (repo: string, changeId: string): OperationEvent => ({ type: "submitted", repo, changeId, commitId: `commit-${changeId}`, bookmark: `bookmark-${changeId}`, submittedBy: "author" });
const shape = (fileSet: string): OperationEvent => ({ type: "change_shape", files: 2, insertions: 10, deletions: 2, packages: ["runner"], apps: [], migrationBearing: false, testFiles: ["tests/pipeline.test.ts"], fileSet, sizeBucket: "small" });
const testFailure = (command: string, testName: string): OperationEvent => ({ type: "classified", ruleVersion: 1, cause: "gate", command, failingTests: [testName], diagnostics: [] });
const run = (runId: string, command: string, durationMs: number, exitCode: number): OperationEvent[] => [
  { type: "run_started", runId, command, host: "slipjay-test" },
  { type: "run_finished", runId, exitCode, signal: null, timedOut: false, durationMs },
];

test("reports median and p90 for stage details and matched command runs", () => {
  const events: StoredEvent[] = [];
  [100, 300, 500, 700].forEach((duration, index) => {
    const id = `op-${index}`;
    events.push(row(index * 5 + 1, id, 1_000 + index * 1_000, submitted("acme/app", `c${index}`)));
    events.push(row(index * 5 + 2, id, 1_001 + index * 1_000, { type: "stage_detail", stage: "verifying", durationMs: duration }));
    events.push(row(index * 5 + 3, id, 1_002 + index * 1_000, { type: "run_started", runId: `run-${index}`, command: "bun test", host: "slipjay-test" }));
    events.push(row(index * 5 + 4, id, 1_003 + index * 1_000, { type: "run_finished", runId: `run-${index}`, exitCode: 0, signal: null, timedOut: false, durationMs: duration / 10 }));
    events.push(row(index * 5 + 5, id, 1_004 + index * 1_000, { type: "landed", base: "main", commitId: `commit-c${index}`, branch: "develop", remote: "origin" }));
  });

  const metrics = pipelineMetrics(events, at(0));
  assert.deepEqual(metrics.stages.verifying, { samples: 4, medianMs: 400, p90Ms: 700 });
  assert.deepEqual(metrics.commands["bun test"], { samples: 4, medianMs: 40, p90Ms: 70 });
  assert.match(formatPipelineMetrics(metrics), /verifying 4 samples, median 400ms, p90 700ms/);
});

test("splits paused time from active queue wait using runner-wide pause facts", () => {
  const events: StoredEvent[] = [
    row(1, "queued-op", 0, submitted("acme/app", "pause-case")),
    row(2, "runner", 2_000, { type: "paused", by: "owner" }),
    row(3, "runner", 7_000, { type: "resumed", by: "owner" }),
    row(4, "queued-op", 10_000, { type: "stage", stage: "fetching" }),
    row(5, "queued-op", 11_000, { type: "landed", base: "main", commitId: "commit-pause-case", branch: "develop", remote: "origin" }),
  ];

  const metrics = pipelineMetrics(events, at(0));
  assert.deepEqual(metrics.queue.total, { samples: 1, medianMs: 10_000, p90Ms: 10_000 });
  assert.deepEqual(metrics.queue.paused, { samples: 1, medianMs: 5_000, p90Ms: 5_000 });
  assert.deepEqual(metrics.queue.activeWait, { samples: 1, medianMs: 5_000, p90Ms: 5_000 });
  assert.deepEqual(metrics.stages.queued, { samples: 1, medianMs: 5_000, p90Ms: 5_000 });
});

test("groups attempts by repository and change through the landed attempt", () => {
  const events: StoredEvent[] = [
    row(1, "first", 1_000, submitted("acme/app", "same-change")),
    row(2, "first", 1_100, { type: "failed", stage: "verifying", reason: "test failed" }),
    row(3, "second", 2_000, submitted("acme/app", "same-change")),
    row(4, "second", 2_100, { type: "landed", base: "main", commitId: "commit-same-change", branch: "develop", remote: "origin" }),
    row(5, "third", 3_000, submitted("other/app", "same-change")),
  ];

  const metrics = pipelineMetrics(events, at(2_000));
  assert.deepEqual(metrics.attempts, [
    { repo: "acme/app", changeId: "same-change", operationIds: ["first", "second"], attempts: 2, landed: true },
    { repo: "other/app", changeId: "same-change", operationIds: ["third"], attempts: 1, landed: false },
  ]);
});

test("confirms repeated in-window failures after a later matching successful command and file set", () => {
  const command = "bun test tests/widget.test.ts";
  const events: StoredEvent[] = [
    row(1, "fail-a", 1_000, submitted("acme/app", "change-a")), row(2, "fail-a", 1_001, shape("same-files")), row(3, "fail-a", 1_002, testFailure(command, "widget > retries")),
    ...run("bad-a", command, 50, 1).map((event, index) => row(4 + index, "fail-a", 1_003 + index, event)),
    row(6, "fail-b", 2_000, submitted("acme/app", "change-b")), row(7, "fail-b", 2_001, shape("same-files")), row(8, "fail-b", 2_002, testFailure(command, "widget > retries")),
    ...run("bad-b", command, 55, 1).map((event, index) => row(9 + index, "fail-b", 2_003 + index, event)),
    row(11, "pass", 3_000, submitted("acme/app", "change-c")), row(12, "pass", 3_001, shape("same-files")),
    ...run("good", command, 52, 0).map((event, index) => row(13 + index, "pass", 3_002 + index, event)),
  ];

  const metrics = pipelineMetrics(events, at(0));
  assert.equal(metrics.flakes.length, 1);
  assert.equal(metrics.flakes[0]?.test, "widget > retries");
  assert.equal(metrics.flakes[0]?.confirmed, true);
  assert.equal(metrics.flakes[0]?.fileSet, "same-files");
  assert.deepEqual(metrics.flakes[0]?.changes, ["acme/app/change-a", "acme/app/change-b"]);
  assert.deepEqual(metrics.flakes[0]?.passingEvidence, { operationId: "pass", seq: 14 });
  assert.match(formatPipelineMetrics(metrics), /widget > retries \(confirmed;/);
  assert.deepEqual(pipelineMetrics(events, at(2_500)).flakes, []);
});

test("reports an unconfirmed candidate when file sets differ or no successful run follows", () => {
  const command = "vp test run tests/widget.test.ts";
  const events: StoredEvent[] = [
    row(1, "fail-a", 1_000, submitted("acme/app", "change-a")), row(2, "fail-a", 1_001, shape("files-a")), row(3, "fail-a", 1_002, testFailure(command, "widget > retries")),
    ...run("bad-a", command, 20, 1).map((event, index) => row(4 + index, "fail-a", 1_003 + index, event)),
    row(6, "fail-b", 2_000, submitted("acme/app", "change-b")), row(7, "fail-b", 2_001, shape("files-b")), row(8, "fail-b", 2_002, testFailure(command, "widget > retries")),
    ...run("bad-b", command, 20, 1).map((event, index) => row(9 + index, "fail-b", 2_003 + index, event)),
    row(11, "pass-different", 3_000, submitted("acme/app", "change-c")), row(12, "pass-different", 3_001, shape("files-b")),
    ...run("good", command, 20, 0).map((event, index) => row(13 + index, "pass-different", 3_002 + index, event)),
  ];

  const confirmed = pipelineMetrics(events, at(0)).flakes;
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0]?.confirmed, true);
  assert.equal(confirmed[0]?.fileSet, "files-b");
  assert.deepEqual(confirmed[0]?.failureEvidence.map(({ operationId, fileSet }) => [operationId, fileSet]), [["fail-a", "files-a"], ["fail-b", "files-b"]]);
  const withoutPass = events.filter((event) => event.operationId !== "pass-different");
  const candidate = pipelineMetrics(withoutPass, at(0)).flakes;
  assert.equal(candidate.length, 1);
  assert.equal(candidate[0]?.confirmed, false);
  assert.equal("fileSet" in candidate[0]!, false);
  assert.equal("passingEvidence" in candidate[0]!, false);
  assert.match(formatPipelineMetrics(pipelineMetrics(withoutPass, at(0))), /widget > retries \(candidate;/);
  assert.doesNotMatch(formatPipelineMetrics(pipelineMetrics(withoutPass, at(0))), /fileSet/);
  assert.deepEqual(pipelineMetrics(events.filter((event) => event.operationId === "fail-a"), at(0)).flakes, []);
});

test("does not use a successful run from another repository as flake confirmation", () => {
  const command = "bun test tests/widget.test.ts";
  const events: StoredEvent[] = [
    row(1, "fail-a", 1_000, submitted("acme/app", "change-a")), row(2, "fail-a", 1_001, shape("same-files")), row(3, "fail-a", 1_002, testFailure(command, "widget > retries")),
    ...run("bad-a", command, 20, 1).map((event, index) => row(4 + index, "fail-a", 1_003 + index, event)),
    row(6, "fail-b", 2_000, submitted("acme/app", "change-b")), row(7, "fail-b", 2_001, shape("same-files")), row(8, "fail-b", 2_002, testFailure(command, "widget > retries")),
    ...run("bad-b", command, 20, 1).map((event, index) => row(9 + index, "fail-b", 2_003 + index, event)),
    row(11, "pass-other-repo", 3_000, submitted("other/app", "change-c")), row(12, "pass-other-repo", 3_001, shape("same-files")),
    ...run("good-other", command, 20, 0).map((event, index) => row(13 + index, "pass-other-repo", 3_002 + index, event)),
  ];

  const flakes = pipelineMetrics(events, at(0)).flakes;
  assert.equal(flakes.length, 1);
  assert.equal(flakes[0]?.confirmed, false);
});

test("a killed successful-looking run cannot confirm a flake candidate", () => {
  const command = "bun test tests/widget.test.ts";
  const events: StoredEvent[] = [
    row(1, "fail-a", 1_000, submitted("acme/app", "change-a")), row(2, "fail-a", 1_001, shape("same-files")), row(3, "fail-a", 1_002, testFailure(command, "widget > retries")),
    ...run("bad-a", command, 20, 1).map((event, index) => row(4 + index, "fail-a", 1_003 + index, event)),
    row(6, "fail-b", 2_000, submitted("acme/app", "change-b")), row(7, "fail-b", 2_001, shape("same-files")), row(8, "fail-b", 2_002, testFailure(command, "widget > retries")),
    ...run("bad-b", command, 20, 1).map((event, index) => row(9 + index, "fail-b", 2_003 + index, event)),
    row(11, "killed-pass", 3_000, submitted("acme/app", "change-c")), row(12, "killed-pass", 3_001, shape("same-files")),
    row(13, "killed-pass", 3_002, { type: "run_started", runId: "killed", command, host: "slipjay-test" }),
    row(14, "killed-pass", 3_003, { type: "run_finished", runId: "killed", exitCode: 0, signal: null, timedOut: false, killed: true, durationMs: 20 }),
  ];

  const flakes = pipelineMetrics(events, at(0)).flakes;
  assert.equal(flakes.length, 1);
  assert.equal(flakes[0]?.confirmed, false);
});

test("a successful run before the latest failure does not confirm the newer candidate", () => {
  const command = "bun test tests/widget.test.ts";
  const events: StoredEvent[] = [
    row(1, "fail-a", 1_000, submitted("acme/app", "change-a")), row(2, "fail-a", 1_001, shape("same-files")), row(3, "fail-a", 1_002, testFailure(command, "widget > retries")),
    ...run("bad-a", command, 20, 1).map((event, index) => row(4 + index, "fail-a", 1_003 + index, event)),
    row(6, "fail-b", 2_000, submitted("acme/app", "change-b")), row(7, "fail-b", 2_001, shape("same-files")), row(8, "fail-b", 2_002, testFailure(command, "widget > retries")),
    ...run("bad-b", command, 20, 1).map((event, index) => row(9 + index, "fail-b", 2_003 + index, event)),
    row(11, "pass", 3_000, submitted("acme/app", "change-c")), row(12, "pass", 3_001, shape("same-files")),
    ...run("good", command, 20, 0).map((event, index) => row(13 + index, "pass", 3_002 + index, event)),
    row(15, "fail-c", 4_000, submitted("acme/app", "change-d")), row(16, "fail-c", 4_001, shape("same-files")), row(17, "fail-c", 4_002, testFailure(command, "widget > retries")),
  ];

  const flakes = pipelineMetrics(events, at(0)).flakes;
  assert.equal(flakes.length, 1);
  assert.equal(flakes[0]?.confirmed, false);
  assert.deepEqual(flakes[0]?.changes, ["acme/app/change-a", "acme/app/change-b", "acme/app/change-d"]);
});

test("projects held integration evidence from held facts", () => {
  const events: StoredEvent[] = [
    row(1, "held-op", 1_000, submitted("acme/app", "held-change")),
    row(2, "held-op", 2_000, { type: "held", repo: "acme/app", commitId: "held-commit", retries: 3, durationMs: 12_500, published: false }),
  ];
  assert.deepEqual(pipelineMetrics(events, at(0)).held, [{ repo: "acme/app", operationId: "held-op", commitId: "held-commit", retries: 3, durationMs: 12_500, published: false, seq: 2 }]);
});

test("uses the latest control-plane held observation for a recent recovery", () => {
  const events: StoredEvent[] = [
    row(1, "held-op", 1_000, submitted("acme/app", "held-change")),
    row(2, "held-op", 2_000, { type: "held", repo: "acme/app", commitId: "held-commit", retries: 2, durationMs: 8_000, published: false }),
    row(3, "held-op", 2_001, { type: "failed", stage: "publishing", reason: "publication unavailable" }),
    row(4, "runner", 9_000, { type: "held", repo: "acme/app", commitId: "held-commit", retries: 2, durationMs: 8_000, published: true }),
  ];

  assert.deepEqual(pipelineMetrics(events, at(5_000)).held, [{ repo: "acme/app", operationId: "runner", commitId: "held-commit", retries: 2, durationMs: 8_000, published: true, seq: 4 }]);
});

test("keeps held observations with the same commit separate by repository", () => {
  const events: StoredEvent[] = [
    row(1, "held-a", 1_000, { type: "held", repo: "acme/app", commitId: "shared-commit", retries: 1, durationMs: 1_000, published: false }),
    row(2, "held-b", 1_100, { type: "held", repo: "other/app", commitId: "shared-commit", retries: 4, durationMs: 4_000, published: true }),
  ];

  assert.deepEqual(pipelineMetrics(events, at(0)).held, [
    { repo: "acme/app", operationId: "held-a", commitId: "shared-commit", retries: 1, durationMs: 1_000, published: false, seq: 1 },
    { repo: "other/app", operationId: "held-b", commitId: "shared-commit", retries: 4, durationMs: 4_000, published: true, seq: 2 },
  ]);
});

test("reports workspace claim timings and pool hit rate by repository and machine", () => {
  const claim = (seq: number, id: string, ms: number, hit: boolean, spareCount: number, durationMs: number): StoredEvent =>
    row(seq, id, ms, { type: "client", id: `fact-${seq}`, fact: { kind: "pool_claim", workspace: `ws-${seq}`, hit, spareCount, durationMs } });
  const events: StoredEvent[] = [
    row(1, "mac-1", 1_000, { type: "client_operation", repo: "acme/app", workspace: "a", machine: "mac" }),
    claim(2, "mac-1", 1_001, true, 8, 2_000),
    row(3, "mac-2", 2_000, { type: "client_operation", repo: "acme/app", workspace: "b", machine: "mac" }),
    claim(4, "mac-2", 2_001, false, 0, 9_000),
    row(5, "vps-1", 3_000, { type: "client_operation", repo: "acme/app", workspace: "c", machine: "vps" }),
    claim(6, "vps-1", 3_001, true, 6, 1_000),
    row(7, "old", 10, { type: "client_operation", repo: "acme/app", workspace: "d", machine: "mac" }),
    claim(8, "old", 11, true, 8, 50_000),
  ];
  const starts = pipelineMetrics(events, at(500)).workspaceStarts;
  assert.deepEqual(starts.map(({ machine, starts, poolHits, medianSpares }) => ({ machine, starts, poolHits, medianSpares })), [
    { machine: "mac", starts: 2, poolHits: 1, medianSpares: 4 },
    { machine: "vps", starts: 1, poolHits: 1, medianSpares: 6 },
  ]);
  assert.deepEqual(starts[0]!.claim, { samples: 2, medianMs: 5_500, p90Ms: 9_000 });
  assert.match(formatPipelineMetrics(pipelineMetrics(events, at(500))), /acme\/app on mac 2 starts, 1 from the pool, claim median 5500ms, p90 9000ms, median 4 spares at start/);
});
