import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { pipelineMetrics, formatPipelineMetrics } from "../../src/lib/runner/pipeline-metrics.ts";
import type { OperationEvent, StoredEvent } from "../../src/lib/runner/runner-types.ts";

const repo = "pechhe/yardsmith";
let seq = 0;
const at = (minutes: number) => new Date(Date.parse("2026-11-05T08:00:00Z") + minutes * 60_000).toISOString();
const row = (operationId: string, minutes: number, event: OperationEvent): StoredEvent => ({ seq: ++seq, operationId, at: at(minutes), event });
const commit = (n: number) => String(n).repeat(40).slice(0, 40);

/** A landing that published after a 90 s gate and a 20 s remote setup. */
const landing = (id: string, minutes: number, n: number): StoredEvent[] => [
  row(id, minutes, { type: "submitted", repo, changeId: `c${n}`, commitId: commit(n), bookmark: `b${n}`, submittedBy: `host:ys-spare-${n}` }),
  row(id, minutes, { type: "remote_verification", phase: "ready", machine: { verifier: "boat", id: "vm", name: "vm", size: "s", image: "i" }, placement: "boat", slot: 0, candidate: commit(n), tree: "t", setupMs: 20_000 }),
  row(id, minutes + 2, { type: "stage_detail", stage: "verifying", durationMs: 90_000 }),
  row(id, minutes + 2, { type: "landed", base: commit(0), commitId: commit(n), branch: "develop", remote: "origin" }),
];
const batch = (id: string, minutes: number, head: number, outcome: "green" | "red" | "flaky" | "infrastructure", culprits: number[] = [], routed: number[] = []): StoredEvent[] => [
  row(id, minutes, { type: "submitted", kind: "verification", repo, commitId: commit(head), submittedBy: "peach-box:batch" }),
  row(id, minutes, { type: "batch_started", base: commit(0), head: commit(head), machine: "batch", scheduled: true, landings: [] }),
  row(id, minutes + 1, { type: "batch_run", phase: "complete", commit: commit(head), status: outcome === "green" ? "passed" : "failed", setupMs: 40_000, durationMs: 600_000 }),
  row(id, minutes + 10, { type: "batch_outcome", outcome, base: commit(0), head: commit(head), machine: "batch",
    culprits: culprits.map((n) => ({ commitId: commit(n), operationId: `land-${n}`, workspace: null, keys: ["workbench"], failingTests: [], command: null, output: "" })) }),
  ...routed.map((n) => row(id, minutes + 11, { type: "batch_routed", commitId: commit(n), operationId: `land-${n}`, specId: "s", number: 6000 + n, runId: "r", noteId: null })),
];

test("slipjay metrics reports batch checks by outcome, culprits with their Forge items, unresolved reds, red-to-green time and the landing gate's time", () => {
  const events = [
    ...landing("land-1", 0, 1), ...landing("land-2", 5, 2),
    ...batch("batch-1", 30, 2, "red", [1, 2], [1]),
    ...batch("batch-2", 60, 2, "flaky"),
    ...batch("batch-3", 90, 3, "green"),
    ...batch("batch-4", 120, 4, "red", [2]),
    ...batch("batch-5", 150, 4, "infrastructure"),
  ];
  const [metrics] = pipelineMetrics(events, at(-60), { now: Date.parse(at(200)) }).batches;
  assert.deepEqual(metrics!.checks, { run: 5, green: 1, red: 2, flaky: 1, infrastructure: 1, stopped: 0, background: 0, perDay: 5 });
  assert.deepEqual(metrics!.culprits.map((culprit) => [culprit.operationId, culprit.forge, culprit.routed]),
    [["land-1", 6001, "routed"], ["land-2", null, "pending"], ["land-2", null, "pending"]]);
  assert.deepEqual(metrics!.unresolvedRed, ["batch-4"]);
  assert.equal(metrics!.redToGreen?.medianMs, 60 * 60_000);
  assert.equal(metrics!.scheduledSetup?.medianMs, 40_000);
  assert.deepEqual(metrics!.redPastGate, { red: 2, pastGate: 2 });
  assert.equal(metrics!.landingGate?.medianMs, 110_000);
  assert.match(formatPipelineMetrics(pipelineMetrics(events, at(-60), { now: Date.parse(at(200)) })), /batch checks: 5 run, 1 green, 2 red, 1 flaky, 1 infrastructure, 0 stopped/);
});

test("slipjay metrics reports background checks, stops, their CPU time and how long a daytime landing waits for a check that covers it", () => {
  const background = (id: string, minutes: number, head: number, outcome: "green" | "red" | "stopped", cpuMs: number): StoredEvent[] => [
    row(id, minutes, { type: "submitted", kind: "verification", repo, commitId: commit(head), submittedBy: "peach-live:background" }),
    row(id, minutes, { type: "batch_started", base: commit(0), head: commit(head), machine: "machine:peach-box", scheduled: false, background: true, landings: [] }),
    row(id, minutes + 5, { type: "remote_verification", phase: "finished", machine: { verifier: "machine", id: "peach-box/check", name: "peach-box", size: "machine", image: "fixed SSH machine" }, tree: "t", trackedChanges: 0, machineMs: 1, memory: { peakBytes: 1, oomKills: 0, cpuMs } }),
    row(id, minutes + 8, { type: "batch_outcome", outcome, base: commit(0), head: commit(head), machine: "machine:peach-box" }),
  ];
  // 08:00 GMT is 08:00 London on 5 Nov; landing 7 publishes at 21:02 London, outside the daytime window.
  const events = [
    ...landing("land-5", 0, 5), ...landing("land-6", 10, 6), ...landing("land-7", 13 * 60, 7),
    ...background("bg-1", 20, 6, "stopped", 30_000), ...background("bg-2", 30, 6, "green", 120_000), ...background("bg-3", 13 * 60 + 10, 7, "red", 60_000),
  ];
  const [metrics] = pipelineMetrics(events, at(-60), { now: Date.parse(at(23 * 60)) }).batches;
  assert.deepEqual(metrics!.checks, { run: 3, green: 1, red: 1, flaky: 0, infrastructure: 0, stopped: 1, background: 3, perDay: 3 });
  assert.equal(metrics!.checkCpuMs, 210_000);
  // Landing 5 (published 08:02) and 6 (08:12) are first covered by bg-2, which ended 08:38; the stopped check covers nothing.
  assert.equal(metrics!.landingToCheck?.samples, 2);
  assert.deepEqual([metrics!.landingToCheck?.medianMs, metrics!.landingToCheck?.p90Ms], [31 * 60_000, 36 * 60_000]);
  assert.match(formatPipelineMetrics(pipelineMetrics(events, at(-60), { now: Date.parse(at(23 * 60)) })), /Background checks: 3 of 3/);
});
