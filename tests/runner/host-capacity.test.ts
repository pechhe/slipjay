import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { capacityOrder, decideCapacity, type CapacityPolicy, type CapacityRequest, type CapacityReading } from "../../src/lib/runner/host-capacity.ts";

const policy: CapacityPolicy = {
  mode: "enforce", budgetBytes: 48, reserveBytes: 8, agingMs: 100, maxWaitMs: 10_000, maxMemoryFullAvg10: 5,
  profiles: { landing: 16, release: 16, image: 16, agent: 4, audit: 16, preview: 4 },
};
const reading: CapacityReading = { totalBytes: 64, availableBytes: 56, memoryFullAvg10: 0, currentBytes: {} };
const request = (id: string, lane: CapacityRequest["lane"], queuedAt = 0, bytes = policy.profiles[lane]): CapacityRequest => ({
  id, job: id, lane, bytes, queuedAt, admittedAt: null, cgroup: null, owner: { kind: "holder", path: `/fixture/${id}`, identity: id },
});

test("memory commitments reserve growth independently of observed usage and survive unknown readings", () => {
  const active = { ...request("active", "release"), admittedAt: 0 };
  const next = request("next", "landing");
  assert.equal(decideCapacity(policy, [active, next], "next", { ...reading, availableBytes: 32 }, 1).admitted, false);
  assert.equal(decideCapacity(policy, [active, next], "next", { ...reading, availableBytes: 32, currentBytes: { active: 12 } }, 1).admitted, true);
  assert.equal(decideCapacity(policy, [active, next], "active", null, 50_000).admitted, true);
  assert.equal(decideCapacity(policy, [active, next], "active", null, 50_000).activeBytes, 16, "age cannot release a live commitment");
});

test("aging places an old release ahead of a sustained stream of new landings", () => {
  const release = request("release", "release", 0);
  assert.deepEqual(capacityOrder([request("first", "landing", 50), release, request("later", "landing", 101)], 100).map((item) => item.id), ["first", "release", "later"]);
  for (let now = 101; now < 1000; now += 10) {
    assert.equal(capacityOrder([release, request(`new-${now}`, "landing", now)], 100)[0]?.id, "release");
  }
});

test("small backfill preserves the full earlier commitment instead of starving a large request", () => {
  const active = { ...request("active", "release", 0, 24), admittedAt: 0 };
  const head = request("large", "release", 0, 24);
  const small = request("small", "landing", 101, 4);
  const blocked = decideCapacity(policy, [active, head, small], small.id, reading, 102);
  assert.equal(blocked.admitted, false);
  assert.match(blocked.reason, /preserving commitment/);
  const roomy = decideCapacity({ ...policy, budgetBytes: 56 }, [active, head, small], small.id, { ...reading, availableBytes: 64, currentBytes: { active: 24 } }, 102);
  assert.equal(roomy.admitted, true);
});

test("pressure, unavailable observations and wait expiry cannot become permission to start", () => {
  const job = request("job", "landing");
  for (const observed of [null, { ...reading, memoryFullAvg10: null }, { ...reading, memoryFullAvg10: 6 }, { ...reading, availableBytes: NaN }]) {
    assert.equal(decideCapacity(policy, [job], job.id, observed, 1).admitted, false);
  }
  assert.match(decideCapacity(policy, [job], job.id, reading, 10_000).reason, /wait limit/);
  assert.equal(decideCapacity(policy, [request("huge", "image", 0, 49)], "huge", reading, 1).admitted, false);
});
