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
  assert.match(formatPipelineMetrics(metrics), /Confirmed flakes: widget > retries \(2 changes;/);
  assert.deepEqual(pipelineMetrics(events, at(2_500)).flakes, []);
});

test("reports an unconfirmed candidate when file sets differ and the command passed in between", () => {
  const command = "vp test run tests/widget.test.ts";
  const midPass = (seq: number): StoredEvent[] => [
    row(seq, "mid-pass", 1_500, submitted("acme/app", "change-mid")),
    ...run("mid-good", command, 20, 0).map((event, index) => row(seq + 1 + index, "mid-pass", 1_501 + index, event)),
  ];
  const events: StoredEvent[] = [
    row(1, "fail-a", 1_000, submitted("acme/app", "change-a")), row(2, "fail-a", 1_001, shape("files-a")), row(3, "fail-a", 1_002, testFailure(command, "widget > retries")),
    ...run("bad-a", command, 20, 1).map((event, index) => row(4 + index, "fail-a", 1_003 + index, event)),
    ...midPass(6),
    row(9, "fail-b", 2_000, submitted("acme/app", "change-b")), row(10, "fail-b", 2_001, shape("files-b")), row(11, "fail-b", 2_002, testFailure(command, "widget > retries")),
    ...run("bad-b", command, 20, 1).map((event, index) => row(12 + index, "fail-b", 2_003 + index, event)),
    row(14, "pass-different", 3_000, submitted("acme/app", "change-c")), row(15, "pass-different", 3_001, shape("files-b")),
    ...run("good", command, 20, 0).map((event, index) => row(16 + index, "pass-different", 3_002 + index, event)),
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
  assert.match(formatPipelineMetrics(pipelineMetrics(withoutPass, at(0))), /Flake candidates: widget > retries \(2 changes;/);
  assert.doesNotMatch(formatPipelineMetrics(pipelineMetrics(withoutPass, at(0))), /fileSet/);
  assert.deepEqual(pipelineMetrics(events.filter((event) => event.operationId === "fail-a"), at(0)).flakes, []);
});

test("does not use a successful run from another repository as flake confirmation", () => {
  const command = "bun test tests/widget.test.ts";
  const events: StoredEvent[] = [
    row(1, "fail-a", 1_000, submitted("acme/app", "change-a")), row(2, "fail-a", 1_001, shape("same-files")), row(3, "fail-a", 1_002, testFailure(command, "widget > retries")),
    ...run("bad-a", command, 20, 1).map((event, index) => row(4 + index, "fail-a", 1_003 + index, event)),
    row(6, "mid-pass", 1_500, submitted("acme/app", "change-mid")),
    ...run("mid-good", command, 20, 0).map((event, index) => row(7 + index, "mid-pass", 1_501 + index, event)),
    row(9, "fail-b", 2_000, submitted("acme/app", "change-b")), row(10, "fail-b", 2_001, shape("same-files")), row(11, "fail-b", 2_002, testFailure(command, "widget > retries")),
    ...run("bad-b", command, 20, 1).map((event, index) => row(12 + index, "fail-b", 2_003 + index, event)),
    row(14, "pass-other-repo", 3_000, submitted("other/app", "change-c")), row(15, "pass-other-repo", 3_001, shape("same-files")),
    ...run("good-other", command, 20, 0).map((event, index) => row(16 + index, "pass-other-repo", 3_002 + index, event)),
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
    row(6, "mid-pass", 1_500, submitted("acme/app", "change-mid")),
    ...run("mid-good", command, 20, 0).map((event, index) => row(7 + index, "mid-pass", 1_501 + index, event)),
    row(9, "fail-b", 2_000, submitted("acme/app", "change-b")), row(10, "fail-b", 2_001, shape("same-files")), row(11, "fail-b", 2_002, testFailure(command, "widget > retries")),
    ...run("bad-b", command, 20, 1).map((event, index) => row(12 + index, "fail-b", 2_003 + index, event)),
    row(14, "killed-pass", 3_000, submitted("acme/app", "change-c")), row(15, "killed-pass", 3_001, shape("same-files")),
    row(16, "killed-pass", 3_002, { type: "run_started", runId: "killed", command, host: "slipjay-test" }),
    row(17, "killed-pass", 3_003, { type: "run_finished", runId: "killed", exitCode: 0, signal: null, timedOut: false, killed: true, durationMs: 20 }),
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

test("a screened landing's gate counts toward the verify budget: the screen, or the authoritative rerun when its base moved", () => {
  const screened = (id: string, seq: number, screenMs: number, rerunMs?: number) => verifiedLanding(id, seq, 3_600_000, screenMs).map((stored) =>
    stored.event.type === "stage_detail" ? { ...stored, event: { type: "stage_detail", stage: "screening", durationMs: screenMs } as OperationEvent } : stored)
    .concat(rerunMs === undefined ? [] : [row(seq * 10 + 9, id, NOW - 3_600_000 + 9, { type: "stage_detail", stage: "verifying", durationMs: rerunMs })]);
  const ten = Array.from({ length: 10 }, (_, index) => screened(`screen-${index}`, index + 1, 10_000)).flat();
  const repo = pipelineMetrics(ten, at(0), { now: NOW }).repositories[0]!;
  assert.deepEqual([repo.verify?.samples, repo.verify?.medianMs, repo.budget.status], [10, 10_000, "within"]);
  const stale = pipelineMetrics(screened("stale", 30, 10_000, 200_000), at(0), { now: NOW }).repositories[0]!;
  assert.equal(stale.verify?.medianMs, 200_000, "the rerun on the moved base is the landing's gate");
});

test("a landing that waited at the host's CPU budget counts its whole gate and none of the wait", () => {
  const waited = (id: string, stage: "verifying" | "screening") => verifiedLanding(id, 1, 3_600_000, 5_000, [
    { type: "stage_detail", stage: "waiting-for-budget", durationMs: 600_000 },
    { type: "host_budget_waited", placement: "host", waitedMs: 600_000 },
    { type: "stage_detail", stage: "verifying", durationMs: 200_000 },
  ]).map((stored) => stored.event.type === "stage_detail" && stored.event.stage === "verifying" ? { ...stored, event: { ...stored.event, stage } } : stored);
  assert.equal(pipelineMetrics(waited("gate", "verifying"), at(0), { now: NOW }).repositories[0]!.verify?.medianMs, 205_000);
  assert.equal(pipelineMetrics(waited("screen", "screening"), at(0), { now: NOW }).repositories[0]!.verify?.medianMs, 205_000);
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

test("names each landing gate's critical suite, its serial tail and the gate's lock wait, from the timing the gate reported", () => {
  const timed = (runId: string, criticalSuite: string, serialTailMs: number, lockWaitMs: number): OperationEvent => ({ type: "test_report", runId, status: "recorded", files: [],
    timing: { wallMs: 200_000, criticalSuite, serialTailMs, lockWaitMs, suites: [{ name: criticalSuite, queueMs: 0, startMs: 0, finishMs: 200_000, permits: 2 }] } });
  const events = [
    ...verifiedLanding("weave-1", 1, 3_600_000, 200_000, [timed("w1", "yardsmith-weave", 40_000, 0)]),
    ...verifiedLanding("weave-2", 2, 3_600_000, 200_000, [timed("w2", "yardsmith-weave", 60_000, 2_000)]),
    ...verifiedLanding("workbench", 3, 3_600_000, 200_000, [timed("b1", "workbench", 100_000, 4_000)]),
    // A gate that wrote no timing counts in the verify time and in no critical path.
    ...verifiedLanding("untimed", 4, 3_600_000, 200_000, [{ type: "test_report", runId: "plain", status: "recorded", files: [] }]),
  ];
  const repo = pipelineMetrics(events, at(0), { now: NOW }).repositories[0]!;
  assert.deepEqual(repo.gateCriticalPath, {
    timed: 3,
    lockWait: { samples: 3, medianMs: 2_000, p90Ms: 4_000 },
    suites: [
      { suite: "yardsmith-weave", landings: 2, serialTail: { samples: 2, medianMs: 50_000, p90Ms: 60_000 } },
      { suite: "workbench", landings: 1, serialTail: { samples: 1, medianMs: 100_000, p90Ms: 100_000 } },
    ],
  });
  assert.match(formatPipelineMetrics(pipelineMetrics(events, at(0), { now: NOW })),
    /Gate critical path over 3 timed gates: yardsmith-weave 2 \(serial tail median 50\.0s\); workbench 1 \(serial tail median 100\.0s\); lock wait 3 samples, median 2000ms, p90 4000ms/);
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

test("slipjay metrics shows a single inconclusive audit as inconclusive with the last green unchanged", () => {
  const head = "a".repeat(40);
  const events: StoredEvent[] = [
    row(1, "audit-1", NOW - 3_600_000, { type: "submitted", kind: "audit", repo: "acme/app", commitId: head, slot: at(NOW - 3_600_000), submittedBy: "runner:schedule" }),
    row(2, "audit-1", NOW - 3_500_000, { type: "audit_head", commit: head }),
    row(3, "audit-1", NOW - 3_000_000, { type: "audited", commit: head, commands: ["bun run test"], passed: ["bun run test"], skipped: [], reused: [] }),
    row(4, "audit-2", NOW - 2_000_000, { type: "submitted", kind: "audit", repo: "acme/app", commitId: head, slot: at(NOW - 2_000_000), submittedBy: "runner:schedule" }),
    row(5, "audit-2", NOW - 1_900_000, { type: "audit_head", commit: head }),
    row(6, "audit-2", NOW - 1_000_000, { type: "failed", stage: "verifying", reason: "UNVERIFIABLE", inconclusive: true }),
  ];
  const metrics = pipelineMetrics(events, at(0), { now: NOW });
  const audit = metrics.repositories[0]?.audit;
  assert.equal(audit?.latest?.status, "inconclusive");
  assert.equal(audit?.lastGreen?.commit, head);
  assert.deepEqual(audit?.inconclusive?.audits, ["audit-2"]);
  assert.match(formatPipelineMetrics(metrics), /Audit: last green aaaaaaaaaaaa at .*; no open failure; inconclusive audit-2; 0 escapes/);
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
  const midPass = [
    row(4, "mid-pass", 1_500, submitted("acme/app", "passing")),
    ...run("mid-good", "vp test run", 5, 0).map((event, index) => row(5 + index, "mid-pass", 1_501 + index, event)),
  ];
  const events = [...failing("op-a", 1, 1_000), ...midPass, ...failing("op-b", 10, 2_000).map((entry) => ({ ...entry, event: entry.event.type === "submitted" ? { ...entry.event, changeId: "other" } : entry.event }))];
  const metrics = pipelineMetrics(events, at(0));
  assert.deepEqual(metrics.flakes.map((candidate) => [candidate.test, candidate.command]), [["tests/a.test.ts > breaks", "vp test run"]]);
});

test("a test that failed for two changes on one broken base, with no pass there, is a shared failure and not a flake candidate", () => {
  const command = "bun run test:landing";
  const events: StoredEvent[] = [
    row(1, "fail-a", 1_000, submitted("acme/app", "change-a")), row(2, "fail-a", 1_001, { type: "verification_base", base: "broken-base", candidate: "tree-a" }),
    row(3, "fail-a", 1_002, shape("files-a")), row(4, "fail-a", 1_003, testFailure(command, "landing > rename")),
    ...run("bad-a", command, 20, 1).map((event, index) => row(5 + index, "fail-a", 1_004 + index, event)),
    row(7, "fail-b", 2_000, submitted("acme/app", "change-b")), row(8, "fail-b", 2_001, { type: "verification_base", base: "broken-base", candidate: "tree-b" }),
    row(9, "fail-b", 2_002, shape("files-b")), row(10, "fail-b", 2_003, testFailure(command, "landing > rename")),
    ...run("bad-b", command, 20, 1).map((event, index) => row(11 + index, "fail-b", 2_004 + index, event)),
  ];
  assert.deepEqual(pipelineMetrics(events, at(0)).flakes, [], "both failures ran on one base, and nothing passed there");

  // A pass of the same command on that base after them shows the base is not deterministically broken.
  const eventsWithPass = [...events,
    row(20, "pass-same-base", 3_000, submitted("acme/app", "change-c")), row(21, "pass-same-base", 3_001, { type: "verification_base", base: "broken-base", candidate: "tree-c" }),
    row(22, "pass-same-base", 3_002, shape("files-c")),
    ...run("good", command, 20, 0).map((event, index) => row(23 + index, "pass-same-base", 3_003 + index, event)),
  ];
  assert.equal(pipelineMetrics(eventsWithPass, at(0)).flakes.length, 1);
});

test("plain output names confirmed flakes and candidates separately", () => {
  const command = "bun run test:landing";
  const events: StoredEvent[] = [
    row(1, "fail-a", 1_000, submitted("acme/app", "change-a")), row(2, "fail-a", 1_001, shape("same-files")), row(3, "fail-a", 1_002, testFailure(command, "widget > retries")),
    ...run("bad-a", command, 20, 1).map((event, index) => row(4 + index, "fail-a", 1_003 + index, event)),
    row(6, "fail-b", 2_000, submitted("acme/app", "change-b")), row(7, "fail-b", 2_001, shape("same-files")), row(8, "fail-b", 2_002, testFailure(command, "widget > retries")),
    ...run("bad-b", command, 20, 1).map((event, index) => row(9 + index, "fail-b", 2_003 + index, event)),
    row(11, "pass", 3_000, submitted("acme/app", "change-c")), row(12, "pass", 3_001, shape("same-files")),
    ...run("good", command, 20, 0).map((event, index) => row(13 + index, "pass", 3_002 + index, event)),
    row(15, "other-fail-a", 4_000, submitted("acme/app", "change-d")), row(16, "other-fail-a", 4_001, shape("files-a")), row(17, "other-fail-a", 4_002, testFailure(command, "search > orders")),
    ...run("other-bad-a", command, 20, 1).map((event, index) => row(18 + index, "other-fail-a", 4_003 + index, event)),
    row(20, "search-mid-pass", 4_500, submitted("acme/app", "change-mid")),
    ...run("search-mid-good", command, 20, 0).map((event, index) => row(21 + index, "search-mid-pass", 4_501 + index, event)),
    row(25, "other-fail-b", 5_000, submitted("acme/app", "change-e")), row(26, "other-fail-b", 5_001, shape("files-b")), row(27, "other-fail-b", 5_002, testFailure(command, "search > orders")),
    ...run("other-bad-b", command, 20, 1).map((event, index) => row(28 + index, "other-fail-b", 5_003 + index, event)),
  ];
  const lines = formatPipelineMetrics(pipelineMetrics(events, at(0))).split("\n");
  const confirmed = lines.find((line) => line.startsWith("Confirmed flakes:")) ?? "";
  const candidates = lines.find((line) => line.startsWith("Flake candidates:")) ?? "";
  assert.match(confirmed, /widget > retries/);
  assert.doesNotMatch(confirmed, /search > orders/);
  assert.match(candidates, /search > orders/);
  assert.doesNotMatch(candidates, /widget > retries/);
});

test("a test every change broke with no pass between them, on one base or across a moved one, is a shared failure", () => {
  const command = "bun run test:landing";
  const failing = (id: string, seq: number, ms: number, base?: string): StoredEvent[] => [
    row(seq, id, ms, submitted("acme/app", `change-${id}`)),
    ...(base ? [row(seq + 1, id, ms + 1, { type: "verification_base", base, candidate: `tree-${id}` } as OperationEvent)] : []),
    row(seq + 2, id, ms + 2, shape(`files-${id}`)), row(seq + 3, id, ms + 3, testFailure(command, "landing > rename")),
    ...run(`bad-${id}`, command, 20, 1).map((event, index) => row(seq + 4 + index, id, ms + 4 + index, event)),
  ];
  // A base that moved under the changes: the same break, no pass of the command between the failures.
  const moved = [...failing("a", 1, 1_000, "base-1"), ...failing("b", 10, 2_000, "base-2")];
  assert.deepEqual(pipelineMetrics(moved, at(0)).flakes, [], "the failures are one break that the base moved through");
  // No base recorded either: nothing shows the test varies, so the shared break explains them too.
  const unrecorded = [...failing("a", 1, 1_000), ...failing("b", 10, 2_000)];
  assert.deepEqual(pipelineMetrics(unrecorded, at(0)).flakes, []);
  // A pass of the command between the failures, on either base, contradicts the shared break.
  const midPass = [
    row(6, "mid-pass", 1_500, submitted("acme/app", "change-mid")),
    row(7, "mid-pass", 1_501, { type: "verification_base", base: "base-2", candidate: "tree-mid" } as OperationEvent),
    ...run("mid-good", command, 20, 0).map((event, index) => row(8 + index, "mid-pass", 1_502 + index, event)),
  ];
  const withPass = [...failing("a", 1, 1_000, "base-1"), ...midPass, ...failing("b", 10, 2_000, "base-2")];
  const [candidate] = pipelineMetrics(withPass, at(0)).flakes;
  assert.deepEqual([candidate?.test, candidate?.confirmed], ["landing > rename", false]);
});
test("a pass of the command on the same base before the failures contradicts that base's determinism", () => {
  const command = "bun run test:landing";
  // The command passed on this base before the two changes failed on it.
  const events: StoredEvent[] = [
    row(1, "early-pass", 500, submitted("acme/app", "change-early")),
    row(2, "early-pass", 501, { type: "verification_base", base: "broken-base", candidate: "tree-early" } as OperationEvent),
    ...run("good", command, 20, 0).map((event, index) => row(3 + index, "early-pass", 502 + index, event)),
    row(6, "fail-a", 1_000, submitted("acme/app", "change-a")),
    row(7, "fail-a", 1_001, { type: "verification_base", base: "broken-base", candidate: "tree-a" } as OperationEvent),
    row(8, "fail-a", 1_002, shape("files-a")), row(9, "fail-a", 1_003, testFailure(command, "landing > rename")),
    ...run("bad-a", command, 20, 1).map((event, index) => row(10 + index, "fail-a", 1_004 + index, event)),
    row(12, "fail-b", 2_000, submitted("acme/app", "change-b")),
    row(13, "fail-b", 2_001, { type: "verification_base", base: "broken-base", candidate: "tree-b" } as OperationEvent),
    row(14, "fail-b", 2_002, shape("files-b")), row(15, "fail-b", 2_003, testFailure(command, "landing > rename")),
    ...run("bad-b", command, 20, 1).map((event, index) => row(16 + index, "fail-b", 2_004 + index, event)),
  ];
  const [flake] = pipelineMetrics(events, at(0)).flakes;
  assert.deepEqual([flake?.test, flake?.confirmed], ["landing > rename", false]);
});

test("reports submission to publication by selection, migration change and placement, counting failures", () => {
  const report = (kind: "related" | "complete"): OperationEvent => ({ type: "test_report", runId: "r", status: "recorded", selection: kind, files: [] });
  const ready = (placement: "boat" | "machine:peach-box"): OperationEvent => ({ type: "remote_verification", phase: "ready", placement, slot: 0, machine: { verifier: placement === "boat" ? "boat" : "machine", name: "m", id: "m", size: "large", image: "i" } } as OperationEvent);
  const landing = (id: string, seq: number, publishMs: number, extra: OperationEvent[], end: OperationEvent = { type: "landed", base: "main", commitId: `commit-${id}`, branch: "main", remote: "origin" }, change = id): StoredEvent[] => [
    row(seq * 10, id, NOW - 3_600_000, submitted("acme/app", change)),
    ...extra.map((event, index) => row(seq * 10 + 1 + index, id, NOW - 3_600_000 + 1 + index, event)),
    row(seq * 10 + 9, id, NOW - 3_600_000 + publishMs, end),
  ];
  const migration = { ...shape("db"), migrationBearing: true } as OperationEvent;
  const events = [
    ...landing("a", 1, 60_000, [shape("a"), report("related"), ready("machine:peach-box")]),
    ...landing("b", 2, 80_000, [shape("b"), report("related"), ready("machine:peach-box")]),
    ...landing("c", 3, 200_000, [migration, report("complete"), ready("boat")]),
    ...landing("d", 4, 90_000, [shape("d"), report("related"), ready("machine:peach-box")], { type: "failed", reason: "gate failed" } as OperationEvent),
    ...landing("e", 5, 30_000, [shape("e")]),
    // d's change again: it waited for the place, then published as a relanding.
    ...landing("d-again", 6, 100_000, [shape("d"), report("related"), { type: "gate_waited", placement: "machine:peach-box", waitedMs: 20_000 }, ready("machine:peach-box")], undefined, "d"),
  ];
  const stp = pipelineMetrics(events, at(0), { now: NOW }).repositories[0]!.submissionToPublication;
  assert.deepEqual([stp.published?.samples, stp.published?.medianMs, stp.failed, stp.relanded], [5, 80_000, 1, 1]);
  assert.deepEqual([stp.bySelection.related?.published?.samples, stp.bySelection.related?.failed], [3, 1]);
  assert.equal(stp.bySelection.complete?.published?.medianMs, 200_000);
  assert.equal(stp.bySelection.unrecorded?.published?.medianMs, 30_000);
  assert.deepEqual([stp.byMigration.migrationBearing.published?.samples, stp.byMigration.other.published?.samples, stp.byMigration.other.failed], [1, 4, 1]);
  const atOnce = stp.byPlacement["machine:peach-box at once"], waited = stp.byPlacement["machine:peach-box waited"];
  assert.deepEqual([atOnce?.published?.samples, atOnce?.failed, waited?.published?.medianMs, waited?.relanded, stp.byPlacement.boat?.published?.samples, stp.byPlacement.runner?.published?.samples], [2, 1, 100_000, 1, 1, 1]);
  assert.match(formatPipelineMetrics(pipelineMetrics(events, at(0), { now: NOW })), /Submission to publication: 5 samples, median \S+, p90 \S+, 1 failed, 1 relanded/);
  // The typical cohort is a and b, d's failure and d-again: not the complete migration landing c, nor e with no selection.
  const typical = stp.typical;
  assert.deepEqual([typical.published?.samples, typical.published?.medianMs, typical.failed, typical.relanded], [3, 80_000, 1, 1]);
  assert.deepEqual(Object.values(typical.publishedPerDay), [3]);
  assert.deepEqual(Object.keys(typical.byPlacement).sort(), ["machine:peach-box at once", "machine:peach-box waited"]);
  assert.deepEqual([typical.byPlacement["machine:peach-box at once"]?.published?.samples, typical.byPlacement["machine:peach-box at once"]?.failed, typical.byPlacement["machine:peach-box waited"]?.relanded], [2, 1, 1]);
  assert.match(formatPipelineMetrics(pipelineMetrics(events, at(0), { now: NOW })), /typical \(related selection, no migration change\): 3 samples, median \S+, p90 \S+, 1 failed, 1 relanded/);
});

test("a related landing that changes a migration trigger stays out of the typical cohort, and each UTC day counts its own", () => {
  const report: OperationEvent = { type: "test_report", runId: "r", status: "recorded", selection: "related", files: [] };
  const landed = (id: string): OperationEvent => ({ type: "landed", base: "main", commitId: `commit-${id}`, branch: "main", remote: "origin" });
  const DAY = 24 * 3_600_000;
  const landing = (id: string, seq: number, submittedAt: number, extra: OperationEvent[]): StoredEvent[] => [
    row(seq * 10, id, submittedAt, submitted("acme/app", id)),
    ...extra.map((event, index) => row(seq * 10 + 1 + index, id, submittedAt + 1 + index, event)),
    row(seq * 10 + 9, id, submittedAt + 60_000, landed(id)),
  ];
  const events = [
    ...landing("yesterday", 1, NOW - DAY - 3_600_000, [shape("a"), report]),
    ...landing("today", 2, NOW - 3_600_000, [shape("b"), report]),
    ...landing("schema", 3, NOW - 3_600_000, [{ ...shape("db"), migrationBearing: true } as OperationEvent, report]),
  ];
  const typical = pipelineMetrics(events, at(0), { now: NOW }).repositories[0]!.submissionToPublication.typical;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  assert.equal(typical.published?.samples, 2);
  assert.deepEqual(typical.publishedPerDay, { [day(NOW - DAY - 3_600_000 + 60_000)]: 1, [day(NOW - 3_600_000 + 60_000)]: 1 });
});

test("reports each repository's failed landings and audits by category, with the machine time each category lost (SJ-215)", () => {
  const failing = (id: string, seq: number, repo: string, category: "regression" | "infrastructure" | "moved_base" | undefined, runMs: number, kind?: "audit"): StoredEvent[] => [
    row(seq, id, seq, kind ? { type: "submitted", kind, repo, commitId: "c", slot: "2026-11-09T02:00:00.000Z", submittedBy: "schedule" } : submitted(repo, id)),
    ...run(`${id}-run`, "bun run test", runMs, 1).map((event, index) => row(seq + 1 + index, id, seq + 1 + index, event)),
    row(seq + 3, id, seq + 3, { type: "classified", ruleVersion: 3, cause: "gate", failingTests: [], diagnostics: [], ...category ? { category: { kind: category, evidence: "e" } } : {} }),
    row(seq + 4, id, seq + 4, { type: "failed", stage: "verifying", reason: "Required verification failed (nonzero_exit): bun run test (check 1)\nFailure: error\nFirst error:\n  Error: broke" }),
  ];
  const landed = [row(90, "ok", 90, submitted("acme/app", "ok")), row(91, "ok", 91, { type: "landed", base: "b", commitId: "c", branch: "main", remote: "origin" })];
  const metrics = pipelineMetrics([
    ...failing("a", 100, "acme/app", "regression", 4_000), ...failing("b", 110, "acme/app", "regression", 1_000), ...failing("c", 120, "acme/app", "infrastructure", 7_000),
    ...failing("d", 130, "acme/app", "moved_base", 0, "audit"), ...failing("old", 140, "acme/app", undefined, 500), ...failing("other", 150, "acme/other", "regression", 2_000), ...landed,
    // A failure that recorded no classification at all.
    row(160, "bare", 160, submitted("acme/app", "bare")), row(161, "bare", 161, { type: "failed", stage: "verifying", reason: "gone" }),
  ], at(0), { now: 1_000_000 });
  const app = metrics.repositories.find((entry) => entry.repo === "acme/app")!.failures;
  // `old` recorded a classification without a category (rule 2): the rule gives its recorded failure the category it would have.
  assert.equal(app.total.count, 6);
  assert.equal(app.derived, 1);
  assert.equal(app.total.machineMs, 12_500);
  assert.deepEqual(Object.fromEntries(Object.entries(app.byCategory).map(([name, loss]) => [name, [loss.count, loss.machineMs]])),
    { regression: [3, 5_500], flake: [0, 0], infrastructure: [1, 7_000], moved_base: [1, 0], unresolved: [0, 0], unclassified: [1, 0] });
  assert.deepEqual(app.byCategory.regression.operations, ["a", "b", "old"]);
  assert.equal(metrics.repositories.find((entry) => entry.repo === "acme/other")!.failures.total.count, 1);
  assert.match(formatPipelineMetrics(metrics), /Failed landings and audits: 6 \(regression 3, 5\.5s of machine time; infrastructure 1, 7\.0s of machine time; moved_base 1, 0\.0s of machine time; unclassified 1, 0\.0s of machine time; 12\.5s in all; 1 read from failures recorded before rule 3, and unresolved where the evidence does not decide\)/);
});
