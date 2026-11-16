import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { CAPACITY_OOM_SCORE_ADJUST, agentMemoryCommitment, parseCapacityMemoryMax, capacityOrder, decideCapacity, type CapacityPolicy, type CapacityRequest, type CapacityReading } from "../../src/lib/runner/host-capacity.ts";

const policy: CapacityPolicy = {
  mode: "enforce", budgetBytes: 48, reserveBytes: 8, agingMs: 100, maxWaitMs: 10_000, maxMemoryFullAvg10: 5,
  profiles: { landing: 16, release: 16, image: 16, agent: 4, audit: 16, preview: 4 },
  typical: { landing: 16, release: 16, image: 16, agent: 4, audit: 16, preview: 4 },
};
const reading: CapacityReading = { totalBytes: 64, availableBytes: 56, memoryFullAvg10: 0, currentBytes: {}, peakBytes: {} };
/** A policy whose `lane` ceiling and typical size are both `bytes`, for fixtures larger than the default profile. */
const sized = (lane: CapacityRequest["lane"], bytes: number, base = policy): CapacityPolicy =>
  ({ ...base, profiles: { ...base.profiles, [lane]: bytes }, typical: { ...base.typical, [lane]: bytes } });
const request = (id: string, lane: CapacityRequest["lane"], queuedAt = 0, bytes = policy.profiles[lane]): CapacityRequest => ({
  id, job: id, lane, bytes, queuedAt, admittedAt: null, cgroup: null, owner: { kind: "holder", path: `/fixture/${id}`, identity: id },
});

test("memory commitments reserve growth independently of observed usage and survive unknown readings", () => {
  const active = { ...request("active", "release"), admittedAt: 0 };
  const next = request("next", "landing");
  assert.equal(decideCapacity(policy, [active, next], "next", { ...reading, availableBytes: 32 }, 1).admitted, false);
  assert.equal(decideCapacity(policy, [active, next], "next", { ...reading, availableBytes: 32, currentBytes: { active: 12 }, peakBytes: { active: 12 } }, 1).admitted, true);
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
  const blocked = decideCapacity(sized("release", 24), [active, head, small], small.id, reading, 102);
  assert.equal(blocked.admitted, false);
  assert.match(blocked.reason, /preserving commitment/);
  const roomy = decideCapacity({ ...sized("release", 24), budgetBytes: 56 }, [active, head, small], small.id, { ...reading, availableBytes: 64, currentBytes: { active: 24 }, peakBytes: { active: 24 } }, 102);
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


test("explicit agent bounds parse exact binary page sizes and retain the default for other work", () => {
  for (const value of ["2G", "2GiB", "2147483648"]) assert.equal(parseCapacityMemoryMax(value), 2 * 1024 ** 3);
  for (const value of ["off", "0", "1.5G", "-1G", "Infinity", "9007199254740992", "4097", "1T", "2Gextra"]) {
    assert.throws(() => parseCapacityMemoryMax(value), /memory-max/);
  }
  const configured = { ...policy, profiles: { ...policy.profiles, agent: 16 * 1024 ** 3 } };
  assert.equal(agentMemoryCommitment(configured, "agent"), 16 * 1024 ** 3);
  assert.equal(agentMemoryCommitment(configured, "agent", 2 * 1024 ** 3), 2 * 1024 ** 3);
  for (const bytes of [0, NaN, Infinity, 4097, 17 * 1024 ** 3]) assert.throws(() => agentMemoryCommitment(configured, "agent", bytes), /memory-max/);
  assert.throws(() => agentMemoryCommitment(configured, "release", 4096), /agent lane/);
});

test("bounded small checks fit remaining growth capacity that cannot admit a default agent", () => {
  const active = { ...request("active", "release", 0, 40), admittedAt: 0 };
  const small = request("small", "agent", 1, 2);
  const large = request("large", "agent", 2, 16);
  const observed = { ...reading, availableBytes: 24, currentBytes: { active: 32 }, peakBytes: { active: 32 } };
  const bounded = sized("agent", 16, sized("release", 40));
  assert.equal(decideCapacity(bounded, [active, small, large], small.id, observed, 3).admitted, true);
  assert.equal(decideCapacity(bounded, [active, { ...small, admittedAt: 3 }, large], large.id, observed, 4).admitted, false);
});

// SJ-244: peach-box on 16 Nov. Two combined previews (12 GiB ceilings, using 4.3 and 4.6 GiB, peaks 6.0 and 5.2) and a
// 24 GiB landing, with 42 GiB available, an 8 GiB reserve and a 48 GiB budget.
const GiB = 1024 ** 3;
const host: CapacityPolicy = {
  ...policy, budgetBytes: 48 * GiB, reserveBytes: 8 * GiB, maxWaitMs: 30 * 60_000,
  profiles: { landing: 24 * GiB, release: 16 * GiB, image: 16 * GiB, agent: 16 * GiB, audit: 16 * GiB, preview: 12 * GiB },
  typical: { landing: 24 * GiB, release: 16 * GiB, image: 16 * GiB, agent: 16 * GiB, audit: 16 * GiB, preview: 6 * GiB },
};
const ceilings = { ...host, typical: host.profiles };
const preview = (id: string) => ({ ...request(id, "preview", 0, 12 * GiB), admittedAt: 0 });
const peachBox: CapacityReading = {
  totalBytes: 62 * GiB, availableBytes: 42 * GiB, memoryFullAvg10: 0,
  currentBytes: { yardsmith: 4.3 * GiB, weave: 4.6 * GiB }, peakBytes: { yardsmith: 6.0 * GiB, weave: 5.2 * GiB },
};

test("a landing starts beside long-lived previews that use far less than their ceilings", () => {
  const landing = request("landing", "landing", 1, 24 * GiB);
  const requests = [preview("yardsmith"), preview("weave"), landing];
  assert.match(decideCapacity(ceilings, requests, landing.id, peachBox, 2).reason, /waiting for available memory/, "whole ceilings held the landing out");
  const decision = decideCapacity(host, requests, landing.id, peachBox, 2);
  assert.equal(decision.admitted, true);
  assert.equal(decision.activeBytes, 12 * GiB, "each preview counts at its typical size, above its peak");
});

test("a third preview still leaves room for the landing, and a fourth makes it wait", () => {
  const third = { ...preview("third"), admittedAt: 1 };
  const landing = request("landing", "landing", 2, 24 * GiB);
  const observed = { ...peachBox, availableBytes: 39.4 * GiB, currentBytes: { ...peachBox.currentBytes, third: 2.6 * GiB }, peakBytes: { ...peachBox.peakBytes, third: 2.6 * GiB } };
  assert.equal(decideCapacity(host, [preview("yardsmith"), preview("weave"), third, landing], landing.id, observed, 3).admitted, true);
  const fourth = { ...preview("fourth"), admittedAt: 1 };
  const crowded = { ...observed, availableBytes: 37 * GiB, currentBytes: { ...observed.currentBytes, fourth: 2.4 * GiB }, peakBytes: { ...observed.peakBytes, fourth: 2.4 * GiB } };
  assert.equal(decideCapacity(host, [preview("yardsmith"), preview("weave"), third, fourth, landing], landing.id, crowded, 3).admitted, false);
});

test("work just admitted counts at its typical size, so two cannot both spend the same free memory", () => {
  const started = { ...request("started", "landing", 0, 24 * GiB), admittedAt: 1 };
  const next = request("next", "landing", 1, 24 * GiB);
  const quiet = { ...peachBox, availableBytes: 50 * GiB, currentBytes: { started: 0 }, peakBytes: { started: 0 } };
  assert.equal(decideCapacity(host, [started, next], next.id, quiet, 2).admitted, false);
});

test("work that grew past its typical size counts at its peak, and never more than its ceiling", () => {
  const grown = { ...preview("grown"), admittedAt: 0 };
  const at = (current: number, peak: number) => decideCapacity(host, [grown], grown.id, { ...peachBox, currentBytes: { grown: current }, peakBytes: { grown: peak } }, 1);
  assert.equal(at(5 * GiB, 9 * GiB).activeBytes, 9 * GiB);
  assert.equal(at(5 * GiB, 9 * GiB).outstandingBytes, 4 * GiB, "room to return to its peak stays reserved");
  assert.equal(at(13 * GiB, 13 * GiB).activeBytes, 12 * GiB);
});

test("a job without both memory measurements counts at its whole ceiling", () => {
  const unknown = preview("unknown");
  const unmeasured: CapacityReading[] = [{ ...peachBox, currentBytes: {}, peakBytes: {} }, { ...peachBox, currentBytes: { unknown: GiB }, peakBytes: { unknown: null } }];
  for (const observed of unmeasured) {
    assert.equal(decideCapacity(host, [unknown], unknown.id, observed, 1).activeBytes, 12 * GiB);
  }
});

test("restartable work is first to give way when overlapping ceilings meet", () => {
  assert.ok(CAPACITY_OOM_SCORE_ADJUST.preview > CAPACITY_OOM_SCORE_ADJUST.agent);
  assert.ok(CAPACITY_OOM_SCORE_ADJUST.agent > CAPACITY_OOM_SCORE_ADJUST.landing);
  assert.equal(CAPACITY_OOM_SCORE_ADJUST.landing, 0);
  assert.equal(CAPACITY_OOM_SCORE_ADJUST.release, 0);
});

test("a queued request that has stopped asking does not hold the head of the queue", () => {
  // peach-box, 16 Nov 10:40 GMT: a sentinel preview polled once and went quiet for 17 minutes while a 12 GiB landing,
  // which fit on its own, preserved the preview's 6 GiB behind it.
  const quiet = { ...request("sentinel", "preview", 0, 12 * GiB), polledAt: 0 };
  const landing = request("landing", "landing", 5 * 60_000, 24 * GiB);
  const typed = { ...host, typical: { ...host.typical, landing: 12 * GiB } };
  const running = [preview("yardsmith"), preview("weave"), preview("isolated"), { ...request("release", "release", 0, 16 * GiB), admittedAt: 0 }];
  const observed = { ...peachBox, availableBytes: 44 * GiB, currentBytes: { yardsmith: 4.2 * GiB, weave: 4.1 * GiB, isolated: 2.5 * GiB, release: 1.7 * GiB },
    peakBytes: { yardsmith: 6.5 * GiB, weave: 5.2 * GiB, isolated: 4.8 * GiB, release: 13.4 * GiB } };
  const at = (now: number, polledAt: number) => decideCapacity(typed, [...running, { ...quiet, polledAt }, landing], landing.id, observed, now);
  const fresh = at(6 * 60_000, 6 * 60_000 - 1000);
  assert.match(fresh.reason, /preserving commitment capacity for sentinel/, "a waiter still asking keeps its place");
  const stale = at(17 * 60_000, 0);
  assert.equal(stale.admitted, true);
  assert.equal(stale.head, "landing");
  assert.equal(capacityOrder([...running, quiet, landing], typed.agingMs)[0]?.id, "sentinel", "it keeps its age for when it asks again");
  assert.equal(decideCapacity(typed, [...running, { ...quiet, polledAt: 17 * 60_000 }, landing], "sentinel", observed, 17 * 60_000).admitted, true);
});
