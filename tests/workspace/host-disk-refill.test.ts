import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { project } from "../support/workspace-project.ts";
import { refillPool } from "../../src/lib/workspace/workspace-pool.ts";

const usageAt = (...percents: number[]) => {
  const reads: number[] = [];
  return { reads, read: async () => { const percent = percents[Math.min(reads.length, percents.length - 1)]!; reads.push(percent); return { percent }; } };
};

test("a refill at or above the refill threshold provisions nothing and logs why", async () => {
  const f = await project();
  try {
    const usage = usageAt(93);
    const outcomes: object[] = [];
    let provisioned = 0;
    await refillPool(f.repo, (outcome) => outcomes.push(outcome), { readUsage: usage.read, provision: async () => { provisioned += 1; return { provisioned: true }; } });
    assert.equal(provisioned, 0);
    assert.deepEqual(outcomes.filter((outcome) => "state" in outcome), [{ provisioned: false, state: "skipped", reason: "disk at 93% (threshold 93%)" }]);
  } finally { await f.dispose(); }
}, 120_000);

test("the check runs again before each later spare", async () => {
  const f = await project();
  try {
    // Room for two spares, then the disk fills.
    const usage = usageAt(50, 60, 94);
    const outcomes: Array<Record<string, unknown>> = [];
    let provisioned = 0;
    await refillPool(f.repo, (outcome) => outcomes.push(outcome as Record<string, unknown>), {
      readUsage: usage.read, provision: async () => { provisioned += 1; return { provisioned: true, name: `s${provisioned}` }; },
    });
    assert.equal(provisioned, 2);
    assert.deepEqual(usage.reads, [50, 60, 94]);
    assert.deepEqual(outcomes.at(-1), { provisioned: false, state: "skipped", reason: "disk at 94% (threshold 93%)" });
  } finally { await f.dispose(); }
}, 120_000);

test("an unreadable disk does not stop a refill, and a spare that did not provision ends it as before", async () => {
  const f = await project();
  try {
    const outcomes: object[] = [];
    await refillPool(f.repo, (outcome) => outcomes.push(outcome), { readUsage: async () => null, provision: async () => ({ provisioned: false, reason: "spare-exists" }) });
    assert.deepEqual(outcomes.filter((outcome) => "reason" in outcome), [{ provisioned: false, reason: "spare-exists" }]);
  } finally { await f.dispose(); }
}, 120_000);
