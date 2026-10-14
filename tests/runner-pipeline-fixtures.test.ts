import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { formatPipelineMetrics, pipelineMetrics } from "../src/lib/pipeline-metrics.ts";
import type { CauseClass, StoredEvent } from "../src/lib/runner-contract.ts";

const captures = ["landed", "gate", "conflict", "infrastructure", "held-recovered", "killed", "superseded", "policy", "cancelled", "paused_out"] as const;
const logs = new Map(captures.map((name) => [name, JSON.parse(readFileSync(new URL(`./fixtures/pipeline/${name}.json`, import.meta.url), "utf8")) as StoredEvent[]]));

test("captured runner and HTTP logs retain classified outcomes and measured pipeline summaries", () => {
  for (const name of captures) {
    const events = logs.get(name)!;
    assert.ok(events.every((event, index) => index === 0 || event.seq > events[index - 1]!.seq));
    const metrics = pipelineMetrics(events, events[0]!.at);
    assert.ok(metrics.operations > 0);
    if (name === "landed") assert.equal(metrics.outcomes.landed, 2);
    else assert.ok(metrics.causes[(name === "held-recovered" ? "held" : name) as CauseClass] > 0, name);
    assert.ok(metrics.queue.total && metrics.queue.total.samples > 0, name);
    assert.match(formatPipelineMetrics(metrics), /Pipeline metrics since/);
    for (const row of events) {
      if (row.event.type === "classified") assert.equal(row.event.ruleVersion, 1);
      if (row.event.type === "stage_detail") assert.ok(row.event.durationMs >= 0);
      if (row.event.type === "queue_snapshot") assert.ok(row.event.position > 0 && row.event.depth >= row.event.position);
      if (row.event.type === "change_shape") assert.ok(row.event.files > 0 && /^[a-f0-9]{64}$/.test(row.event.fileSet));
    }
  }
});

test("captured gate failure names its test and captured publication hold finishes published", () => {
  const gate = logs.get("gate")!.find((row) => row.event.type === "classified" && row.event.cause === "gate")?.event;
  assert.ok(gate?.type === "classified");
  assert.deepEqual(gate.failingTests, ["tests/fixture.test.ts > fixture > rejects the candidate"]);
  const held = logs.get("held-recovered")!;
  const executedRecovery = held.find((row) => row.event.type === "integration_recovered" && row.event.retried);
  assert.ok(executedRecovery);
  const recovered = pipelineMetrics(held.filter((row) => row.seq <= executedRecovery.seq), held[0]!.at);
  assert.ok(recovered.held.some((entry) => entry.published && entry.retries >= 1 && entry.durationMs > 0));
  const latest = pipelineMetrics(held, held[0]!.at);
  assert.ok(latest.held.some((entry) => entry.published && entry.retries === 0), "the later external publication observation is not an executed retry");
  const policy = logs.get("policy")!;
  const purposes = policy.filter((row) => row.event.type === "run_started").map((row) => row.event.type === "run_started" && row.event.purpose);
  assert.ok(purposes.includes("migration_generate") && purposes.includes("migration_verify") && purposes.includes("gate"));
});
