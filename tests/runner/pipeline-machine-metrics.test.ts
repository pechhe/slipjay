import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { pipelineMetrics } from "../../src/lib/runner/pipeline-metrics.ts";
import type { RemoteMachine, StoredEvent } from "../../src/lib/runner/runner-types.ts";

test("machine metrics include failed setup and lost gates, split machine names, and never charge boat for machines", () => {
  const log = openOperationLog(":memory:");
  const machine = (name: string): RemoteMachine => ({ verifier: "machine", name, id: name, size: "machine", image: "fixed SSH machine" });
  for (const [id, name, setupMs, machineMs] of [["a", "peach-box", 1000, 11000], ["b", "peach-box", 3000, 33000], ["c", "other", 5000, 55000]] as const) {
    log.append(id, { type: "submitted", repo: "fixture/repo", changeId: id.repeat(32), commitId: "c".repeat(40), bookmark: "slipjay/changes/x", submittedBy: "test" });
    log.append(id, { type: "remote_verification", phase: "ready", machine: machine(name), placement: `machine:${name}`, slot: 0, candidate: "c".repeat(40), tree: "t", setupMs });
    log.append(id, { type: "remote_verification", phase: "finished", machine: machine(name), tree: "t", trackedChanges: 0, machineMs });
  }
  log.append("d", { type: "submitted", repo: "fixture/repo", changeId: "d".repeat(32), commitId: "c".repeat(40), bookmark: "slipjay/changes/x", submittedBy: "test" });
  log.append("d", { type: "remote_verification", phase: "failed", machine: machine("peach-box"), placement: "machine:peach-box", setupMs: 2000, infrastructure: true, reason: "setup failed", usageBefore: null, usage: null });
  log.append("d", { type: "gate_fallback", placement: "machine:peach-box", cause: "infrastructure", reason: "setup failed" });
  const events = log.events();
  const metrics = pipelineMetrics(events, "1970-01-01").groups[0]!.remote!;
  assert.deepEqual(metrics.placements["machine:peach-box"], { attempts: 3, setup: { samples: 3, medianMs: 2000, p90Ms: 3000 }, gate: { samples: 2, medianMs: 20000, p90Ms: 30000 } });
  assert.equal(metrics.placements["machine:other"]!.gate!.medianMs, 50000);
  assert.deepEqual(metrics.fallbacks, { "machine:peach-box: setup failed": 1 });
  assert.equal(metrics.dollars, 0); assert.equal(metrics.estimatedDollars, 0); assert.equal(metrics.boatVmSeconds, 0);

  // A failed command transport has no finished machine reading; the terminal timestamp still bounds its duration.
  const ready = events.find((row) => row.operationId === "a" && row.event.type === "remote_verification" && row.event.phase === "ready")!;
  const lost: StoredEvent[] = [events[0]!, { ...ready, at: "2026-11-05T12:00:00.000Z" },
    { ...ready, seq: 999, at: "2026-11-05T12:00:12.000Z", event: { type: "failed", stage: "verifying", reason: "executor lost: ssh" } }];
  assert.equal(pipelineMetrics(lost, "1970-01-01").groups[0]!.remote!.placements["machine:peach-box"]!.gate!.medianMs, 12000);
});
