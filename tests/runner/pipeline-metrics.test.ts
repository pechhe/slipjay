import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { formatPipelineMetrics, pipelineMetrics } from "../../src/lib/runner/pipeline-metrics.ts";
import type { OperationEvent, StoredEvent } from "../../src/lib/runner/runner-types.ts";

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
  const [landings] = metrics.groups;
  assert.equal(metrics.groups.length, 1);
  assert.deepEqual([landings!.repo, landings!.kind], ["acme/app", "landing"]);
  assert.deepEqual(landings!.stages.verifying, { samples: 4, medianMs: 400, p90Ms: 700 });
  assert.deepEqual(landings!.commands["bun test"], { samples: 4, medianMs: 40, p90Ms: 70 });
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

  const [group] = pipelineMetrics(events, at(0)).groups;
  assert.deepEqual(group!.queue.total, { samples: 1, medianMs: 10_000, p90Ms: 10_000 });
  assert.deepEqual(group!.queue.paused, { samples: 1, medianMs: 5_000, p90Ms: 5_000 });
  assert.deepEqual(group!.queue.activeWait, { samples: 1, medianMs: 5_000, p90Ms: 5_000 });
  assert.deepEqual(group!.stages.queued, { samples: 1, medianMs: 5_000, p90Ms: 5_000 });
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
  const claim = (seq: number, id: string, ms: number, hit: boolean, spareCount: number, durationMs: number, steps?: Record<string, number>): StoredEvent =>
    row(seq, id, ms, { type: "client", id: `fact-${seq}`, fact: { kind: "pool_claim", workspace: `ws-${seq}`, hit, spareCount, durationMs, ...steps ? { steps } : {} } });
  const events: StoredEvent[] = [
    row(1, "mac-1", 1_000, { type: "client_operation", repo: "acme/app", workspace: "a", machine: "mac" }),
    claim(2, "mac-1", 1_001, true, 8, 2_000, { fetch: 1_000, jjNew: 400, install: 0 }),
    row(3, "mac-2", 2_000, { type: "client_operation", repo: "acme/app", workspace: "b", machine: "mac" }),
    claim(4, "mac-2", 2_001, false, 0, 9_000, { fetch: 2_000, install: 6_000 }),
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
  assert.deepEqual(starts[0]!.steps, { fetch: 1_500, jjNew: 400, install: 3_000 }, "each step's median over the starts that recorded it");
  assert.deepEqual(starts[1]!.steps, {}, "a start from before step timing records none");
  const report = formatPipelineMetrics(pipelineMetrics(events, at(500)));
  assert.match(report, /acme\/app on mac 2 starts, 1 from the pool, claim median 5500ms, p90 9000ms, median 4 spares at start \(step medians: fetch 1500ms, jjNew 400ms, install 3000ms\)/);
  assert.match(report, /on vps 1 starts, 1 from the pool, claim median 1000ms, p90 1000ms, median 6 spares at start(;|$)/m);
});

test("keeps each repository's landings, releases and deploys apart, and counts a pre-verification as finished", () => {
  const events: StoredEvent[] = [
    row(1, "land", 1_000, submitted("acme/app", "c1")), row(2, "land", 1_001, { type: "stage_detail", stage: "verifying", durationMs: 100 }),
    row(3, "land", 1_002, { type: "landed", base: "main", commitId: "commit-c1", branch: "main", remote: "origin" }),
    row(4, "release", 2_000, { type: "submitted", kind: "release", repo: "acme/app", commitId: "r1", migrationsReady: false, submittedBy: "owner" }),
    row(5, "release", 2_001, { type: "stage_detail", stage: "verifying", durationMs: 9_000 }),
    row(6, "other", 3_000, submitted("other/app", "c2")), row(7, "other", 3_001, { type: "stage_detail", stage: "verifying", durationMs: 300 }),
    row(8, "verify", 4_000, { type: "submitted", kind: "verification", repo: "acme/app", commitId: "v1", submittedBy: "owner" }),
    row(9, "verify", 4_001, { type: "verified", base: "release", candidate: "v1", checks: [] }),
  ];
  const metrics = pipelineMetrics(events, at(0));
  assert.deepEqual(metrics.groups.map((group) => [group.repo, group.kind, group.stages.verifying?.medianMs]), [
    ["acme/app", "landing", 100], ["acme/app", "release", 9_000], ["acme/app", "verification", undefined], ["other/app", "landing", 300],
  ]);
  assert.equal(metrics.outcomes.verified, 1);
  assert.deepEqual(pipelineMetrics(events, at(0), { repo: "other/app" }).groups.map((group) => group.repo), ["other/app"]);
});

const NOW = 30 * 24 * 3_600_000;
/** A landing whose checks ran for `verifyMs`, `ageMs` before NOW, under `budgets`. */
const verifiedLanding = (id: string, seq: number, ageMs: number, verifyMs: number, extra: OperationEvent[] = [], budgets = { verifyP50Seconds: 90, verifyP90Seconds: 180, testFileSeconds: 30 }): StoredEvent[] =>
  [submitted("acme/app", id), { type: "verification_base", base: "b", candidate: "c", budgets } as OperationEvent, { type: "stage_detail", stage: "verifying", durationMs: verifyMs } as OperationEvent, ...extra]
    .map((event, index) => row(seq * 10 + index, id, NOW - ageMs + index, event));

test("judges a repository's verify time against its budgets only on enough executed landings in the window", () => {
  const nine = Array.from({ length: 9 }, (_, index) => verifiedLanding(`ok-${index}`, index + 1, 3_600_000, 60_000)).flat();
  const insufficient = pipelineMetrics(nine, at(0), { now: NOW }).repositories[0]!;
  assert.deepEqual(insufficient.budget, { status: "insufficient-samples", over: [] });

  const ten = [...nine, ...verifiedLanding("ok-9", 10, 3_600_000, 60_000)];
  const within = pipelineMetrics(ten, at(0), { now: NOW }).repositories[0]!;
  assert.deepEqual([within.verify?.samples, within.budget.status], [10, "within"]);

  // Skipped, cancelled and out-of-window landings are not samples; slow ones break the p50 budget.
  const slow = Array.from({ length: 10 }, (_, index) => verifiedLanding(`slow-${index}`, index + 20, 3_600_000, 120_000)).flat();
  const ignored = [
    ...verifiedLanding("skipped", 40, 3_600_000, 1, [{ type: "verification_skipped", base: "b", candidate: "c", fields: ["spares"], reason: "settings" }]),
    ...verifiedLanding("cancelled", 41, 3_600_000, 1, [{ type: "cancelled", reason: "owner" }]),
    ...verifiedLanding("old", 42, 8 * 24 * 3_600_000, 1),
  ];
  const over = pipelineMetrics([...slow, ...ignored], at(0), { now: NOW }).repositories[0]!;
  assert.deepEqual([over.verify?.samples, over.budget], [10, { status: "over", over: ["verifyP50Seconds"] }]);
  assert.match(formatPipelineMetrics(pipelineMetrics([...slow, ...ignored], at(0), { now: NOW })), /acme\/app budget: over \(verifyP50Seconds\)/);

  const undeclared = verifiedLanding("plain", 50, 3_600_000, 60_000).map((stored) => stored.event.type === "verification_base" ? { ...stored, event: { type: "verification_base", base: "b", candidate: "c" } as OperationEvent } : stored);
  assert.equal(pipelineMetrics(undeclared, at(0), { now: NOW }).repositories[0]!.budget.status, "undeclared");
});

test("ranks test files from recorded reports, finds growing ones, and judges the per-file budget on serial file-cost runs over their own window", () => {
  const report = (runId: string, files: [string, number][]): OperationEvent => ({ type: "test_report", runId, status: "recorded", files: files.map(([file, ms]) => ({ file, suite: "vitest", ms, status: "passed" })) });
  const cost = (runId: string, files: [string, number][]): OperationEvent => ({ type: "test_report", runId, status: "recorded", files: files.map(([file, ms]) => ({ file, suite: "file-cost", ms, status: "passed" })) });
  const landings = [1_000, 1_100, 1_000, 1_050, 1_000, 3_000, 3_100, 3_000, 3_050, 3_000].map((ms, index) => verifiedLanding(`run-${index}`, index + 1, 3_600_000, 60_000,
    [report(`r${index}`, [["tests/growing.test.ts", ms], ["tests/slow.test.ts", 40_000], ["tests/steady.test.ts", 500]])]));
  // Five nightly file-cost runs, older than tonight's report window and inside the budget window.
  const costs = Array.from({ length: 5 }, (_, index) => [
    { type: "submitted", kind: "audit", repo: "acme/app", commitId: "", slot: at(0), submittedBy: "runner:schedule" } as OperationEvent,
    cost(`cost-${index}`, [["tests/slow.test.ts", 31_000], ["tests/steady.test.ts", 500]]),
  ].map((event, offset) => row(200 + index * 10 + offset, `cost-op-${index}`, NOW - (index + 1) * 86_400_000, event)));
  const events = [
    ...landings.flat(),
    ...costs.flat(),
    ...verifiedLanding("broken", 20, 1_000, 60_000, [{ type: "test_report", runId: "bad", status: "malformed", reason: "no testResults" }]),
    ...verifiedLanding("install", 21, 1_000, 60_000, [{ type: "test_report", runId: "install", status: "missing" }]),
  ];
  const since = at(NOW - 3_600_000);
  const repo = pipelineMetrics(events, since, { now: NOW }).repositories[0]!;
  assert.deepEqual(repo.reports, { recorded: 10, malformed: 1, missing: 1 });
  assert.match(formatPipelineMetrics(pipelineMetrics(events, since, { now: NOW })), /Test reports: 10 recorded, 1 malformed, 1 missing/);
  // Tonight's listing is this report window's runs; a 40 s landing median is contention and judges nothing.
  assert.deepEqual(repo.slowestTestFiles.map((file) => [file.file, file.suite]), [["tests/slow.test.ts", "vitest"], ["tests/growing.test.ts", "vitest"], ["tests/steady.test.ts", "vitest"]]);
  assert.deepEqual(repo.growingTestFiles.map((file) => [file.file, file.earlierMedianMs, file.laterMedianMs]), [["tests/growing.test.ts", 1_000, 3_000]]);
  // Only the serial measurement, from five nights inside the budget window, is over the 30 s budget.
  assert.deepEqual(repo.testFilesOverBudget.map((file) => [file.suite, file.file, file.samples, file.medianMs]), [["file-cost", "tests/slow.test.ts", 5, 31_000]]);
  assert.deepEqual(repo.budget.over, ["testFileSeconds"]);
  assert.match(formatPipelineMetrics(pipelineMetrics(events, since, { now: NOW })), /Test files over budget: file-cost tests\/slow.test.ts 31.0s/);
  // The parallel medians rank what the nightly run should measure: anything past half the ceiling.
  assert.deepEqual(repo.costCandidates.map((file) => file.file), ["tests/slow.test.ts"]);
  assert.match(formatPipelineMetrics(pipelineMetrics(events, since, { now: NOW })), /Cost candidates: 1 file\(s\), slowest tests\/slow\.test\.ts 40\.0s/);

  // Four serial samples are too few to judge: the file is a candidate, not over.
  const early = pipelineMetrics([...landings.flat(), ...costs.slice(0, 4).flat()], since, { now: NOW }).repositories[0]!;
  assert.deepEqual([early.testFilesOverBudget, early.budget.over], [[], []]);
  assert.deepEqual(early.costCandidates.map((file) => file.file), ["tests/slow.test.ts"]);
});

test("lists at most forty files for the nightly file-cost run, however many are past half the ceiling", () => {
  const report = (runId: string, file: string): OperationEvent => ({ type: "test_report", runId, status: "recorded", files: [{ file, suite: "vitest", ms: 20_000, status: "passed" }] });
  const events = Array.from({ length: 45 }, (_, index) => verifiedLanding(`candidate-${index}`, index + 1, 3_600_000, 60_000, [report(`c${index}`, `tests/candidate-${index}.test.ts`)])).flat();
  const repo = pipelineMetrics(events, at(0), { now: NOW }).repositories[0]!;
  assert.equal(repo.costCandidates.length, 40);
  assert.deepEqual(repo.testFilesOverBudget, [], "a parallel 20 s median is a candidate, never over the 30 s ceiling");
});

test("splits a landing's verify time by how the gate selected its tests, so a representative run is judged alone", () => {
  const selection = (runId: string, kind: "related" | "complete"): OperationEvent => ({ type: "test_report", runId, status: "recorded", selection: kind, files: [{ file: "tests/a.test.ts", suite: "vitest", ms: 1_000, status: "passed" }] });
  const events = [
    ...[60_000, 70_000, 80_000, 90_000].flatMap((ms, index) => verifiedLanding(`related-${index}`, index + 1, 3_600_000, ms, [selection(`s${index}`, "related")])),
    ...[300_000, 320_000, 340_000, 360_000].flatMap((ms, index) => verifiedLanding(`complete-${index}`, index + 10, 3_600_000, ms, [selection(`c${index}`, "complete")])),
    // A version-1 report names no selection, so it lands in neither split while still counting in the whole.
    ...verifiedLanding("unknown", 20, 3_600_000, 200_000, [{ type: "test_report", runId: "plain", status: "recorded", files: [{ file: "tests/b.test.ts", suite: "vitest", ms: 1_000, status: "passed" }] }]),
  ];
  const repo = pipelineMetrics(events, at(0), { now: NOW }).repositories[0]!;
  assert.deepEqual(repo.verifyBySelection.related, { samples: 4, medianMs: 75_000, p90Ms: 90_000 });
  assert.deepEqual(repo.verifyBySelection.complete, { samples: 4, medianMs: 330_000, p90Ms: 360_000 });
  assert.deepEqual([repo.verify?.samples, repo.verify?.medianMs], [9, 200_000]);
  const text = formatPipelineMetrics(pipelineMetrics(events, at(0), { now: NOW }));
  assert.match(text, /Verify by selection: related 4 samples, median 75000ms, p90 90000ms; complete 4 samples, median 330000ms, p90 360000ms/);
});

test("a test file's samples are its executed runs in one operation kind: skipped rows and the audit's runs are kept out of a landing's, and its budget", () => {
  const report = (runId: string, ms: number, status: "passed" | "skipped"): OperationEvent => ({ type: "test_report", runId, status: "recorded", files: [{ file: "tests/a.test.ts", suite: "vitest", ms, status }] });
  const audit = (id: string, seq: number, ms: number): StoredEvent[] => [
    { type: "submitted", kind: "audit", repo: "acme/app", commitId: "", slot: at(0), submittedBy: "runner:schedule" } as OperationEvent,
    report(`${id}-run`, ms, "passed"),
  ].map((event, index) => row(seq + index, id, NOW - 1_000 + index, event));
  const events = [
    ...[0, 0, 0].flatMap((ms, index) => verifiedLanding(`skip-${index}`, index + 1, 3_600_000, 60_000, [report(`s${index}`, ms, "skipped")])),
    ...[1_000, 1_000, 1_000].flatMap((ms, index) => verifiedLanding(`land-${index}`, index + 10, 3_000_000, 60_000, [report(`l${index}`, ms, "passed")])),
    ...audit("audit-1", 30, 60_000), ...audit("audit-2", 40, 60_000), ...audit("audit-3", 50, 60_000),
  ];
  const repo = pipelineMetrics(events, at(0), { now: NOW }).repositories[0]!;
  assert.deepEqual(repo.slowestTestFiles.map((file) => [file.kind, file.file, file.samples, file.medianMs]), [["audit", "tests/a.test.ts", 3, 60_000], ["landing", "tests/a.test.ts", 3, 1_000]]);
  assert.deepEqual(repo.growingTestFiles, []);
  assert.deepEqual(repo.testFilesOverBudget, [], "a 60 s audit run is over no landing budget");
});

test("a test that failed and then passed on a retry of the same verified candidate is a confirmed flake", () => {
  const command = "bun run test";
  const retry = (id: string, seq: number, exitCode: number, failing?: string, candidate?: string): StoredEvent[] => [
    { type: "submitted", repo: "acme/app", changeId: "one-change", commitId: "same-source", bookmark: "b", submittedBy: "author" } as OperationEvent,
    ...(candidate ? [{ type: "verification_base", base: `base-of-${candidate}`, candidate } as OperationEvent] : []),
    ...(failing ? [testFailure(command, failing)] : []),
    ...run(`${id}-run`, command, 10, exitCode),
  ].map((event, index) => row(seq + index, id, seq * 10 + index, event));
  const events = [...retry("first", 1, 1, "spares > install one at a time", "tree-1"), ...retry("second", 10, 0, undefined, "tree-1")];
  const [flake] = pipelineMetrics(events, at(0)).flakes;
  assert.deepEqual([flake?.test, flake?.confirmed, flake?.changes, flake?.retriedPass], ["spares > install one at a time", true, ["acme/app/one-change"], { operationId: "second", seq: 13 }]);
  assert.match(formatPipelineMetrics(pipelineMetrics(events, at(0))), /passed on retry second/);

  // The same source verified on a different base is a different tree: the pass shows the base was fixed, not a flake.
  const rebased = [...retry("first", 1, 1, "spares > install one at a time", "tree-1"), ...retry("second", 10, 0, undefined, "tree-2")];
  const [moved] = pipelineMetrics(rebased, at(0)).flakes ?? [];
  assert.equal(moved, undefined, "a pass on another candidate neither confirms nor lists a flake");

  // Missing candidate evidence is not proof the tree was unchanged.
  const unrecorded = [...retry("first", 1, 1, "spares > install one at a time"), ...retry("second", 10, 0)];
  assert.equal(pipelineMetrics(unrecorded, at(0)).flakes.every((entry) => !entry.confirmed), true);

  // A different source commit is a changed input, so one change's failure and pass prove nothing.
  const changed = events.map((stored) => stored.operationId === "second" && stored.event.type === "submitted" ? { ...stored, event: { ...stored.event, commitId: "edited" } } : stored);
  assert.deepEqual(pipelineMetrics(changed, at(0)).flakes, []);
});

test("a failure is attributed to the verification base in force when it happened, not a later attempt's", () => {
  const command = "bun run test";
  const events = [
    row(1, "first", 1_000, { type: "submitted", repo: "acme/app", changeId: "one-change", commitId: "same-source", bookmark: "b", submittedBy: "author" }),
    row(2, "first", 1_001, { type: "verification_base", base: "base-1", candidate: "tree-1" }),
    row(3, "first", 1_002, testFailure(command, "widget > retries")),
    ...run("first-run", command, 10, 1).map((event, index) => row(4 + index, "first", 1_003 + index, event)),
    row(6, "first", 1_005, { type: "verification_base", base: "base-2", candidate: "tree-2" }),
    row(7, "second", 2_000, { type: "submitted", repo: "acme/app", changeId: "one-change", commitId: "same-source", bookmark: "b", submittedBy: "author" }),
    row(8, "second", 2_001, { type: "verification_base", base: "base-2", candidate: "tree-2" }),
    ...run("second-run", command, 10, 0).map((event, index) => row(9 + index, "second", 2_002 + index, event)),
  ];
  assert.deepEqual(pipelineMetrics(events, at(0)).flakes, [], "the failure verified tree-1; the pass tree-2 is another tree");
});

test("each repository's metrics carry its audit status", () => {
  const head = "a".repeat(40);
  const events: StoredEvent[] = [
    row(1, "audit-1", NOW - 3_600_000, { type: "submitted", kind: "audit", repo: "acme/app", commitId: head, slot: at(NOW - 3_600_000), submittedBy: "runner:schedule" }),
    row(2, "audit-1", NOW - 3_500_000, { type: "audit_head", commit: head }),
    row(3, "audit-1", NOW - 3_000_000, { type: "audited", commit: head, commands: ["bun run test"], passed: ["bun run test"], skipped: [], reused: [] }),
  ];
  const metrics = pipelineMetrics(events, at(0), { now: NOW });
  assert.deepEqual([metrics.groups[0]?.kind, metrics.outcomes.audited], ["audit", 1]);
  assert.equal(metrics.repositories[0]?.audit?.lastGreen?.commit, head);
  assert.equal(metrics.repositories[0]?.audit?.overdue, false);
  assert.match(formatPipelineMetrics(metrics), /Audit: last green aaaaaaaaaaaa at .*; no open failure; 0 escapes/);
});

test("attributes each failing test to the command that failed it, not to the first failed command", () => {
  const failing = (id: string, seq: number, ms: number): StoredEvent[] => [
    row(seq, id, ms, submitted("acme/app", "per-check")),
    row(seq + 1, id, ms + 1, { type: "classified", ruleVersion: 1, cause: "gate", command: "bun run typecheck", failingTests: ["tests/a.test.ts > breaks"], diagnostics: [],
      checks: [
        { checkIndex: 0, command: "bun run typecheck", cause: "infrastructure", failingTests: [], diagnostics: [] },
        { checkIndex: 1, command: "vp test run", cause: "gate", runId: "r2", failingTests: ["tests/a.test.ts > breaks"], diagnostics: [] },
      ] }),
  ];
  const events = [...failing("op-a", 1, 1_000), ...failing("op-b", 10, 2_000).map((entry) => ({ ...entry, event: entry.event.type === "submitted" ? { ...entry.event, changeId: "other" } : entry.event }))];
  const metrics = pipelineMetrics(events, at(0));
  assert.deepEqual(metrics.flakes.map((candidate) => [candidate.test, candidate.command]), [["tests/a.test.ts > breaks", "vp test run"]]);
});
