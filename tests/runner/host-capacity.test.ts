import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { readCapacityPolicy } from "../../src/lib/runner/host-capacity-local.ts";
import { CAPACITY_OOM_SCORE_ADJUST, learnTypical, withLearnedTypical, type CapacitySample, agentMemoryCommitment, parseCapacityMemoryMax, capacityOrder, countedBytes, decideCapacity, type CapacityPolicy, type CapacityRequest, type CapacityReading } from "../../src/lib/runner/host-capacity.ts";

const policy: CapacityPolicy = {
  mode: "enforce", reserveBytes: 8, agingMs: 100, maxWaitMs: 10_000, maxMemoryFullAvg10: 5, takeRoomAfterMs: 5 * 60_000,
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
  assert.match(blocked.reason, /preserving memory headroom for large/);
  const roomy = decideCapacity(sized("release", 24), [active, head, small], small.id, { ...reading, availableBytes: 64, currentBytes: { active: 24 }, peakBytes: { active: 24 } }, 102);
  assert.equal(roomy.admitted, true);
});

test("pressure, unavailable observations and wait expiry cannot become permission to start", () => {
  // An agent check waits on the forecast at its wait limit too: only landings and release checks take room.
  const job = request("job", "agent");
  for (const observed of [null, { ...reading, memoryFullAvg10: null }, { ...reading, memoryFullAvg10: 6 }, { ...reading, availableBytes: NaN }]) {
    assert.equal(decideCapacity(policy, [job], job.id, observed, 1).admitted, false);
  }
  assert.match(decideCapacity(policy, [job], job.id, reading, 10_000).reason, /wait limit/);
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
  ...policy, reserveBytes: 8 * GiB, maxWaitMs: 30 * 60_000,
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
  // which fit on its own, preserved the preview's 6 GiB behind it. A landing now goes ahead of any preview (SJ-267), so
  // an image build that went quiet stands in for it.
  const quiet = { ...request("sentinel", "image", 0, 12 * GiB), polledAt: 0 };
  const landing = request("landing", "landing", 5 * 60_000, 24 * GiB);
  const typed = { ...host, typical: { ...host.typical, landing: 12 * GiB } };
  const running = [preview("yardsmith"), preview("weave"), preview("isolated"), { ...request("release", "release", 0, 16 * GiB), admittedAt: 0 }];
  const observed = { ...peachBox, availableBytes: 44 * GiB, currentBytes: { yardsmith: 4.2 * GiB, weave: 4.1 * GiB, isolated: 2.5 * GiB, release: 1.7 * GiB },
    peakBytes: { yardsmith: 6.5 * GiB, weave: 5.2 * GiB, isolated: 4.8 * GiB, release: 13.4 * GiB } };
  const at = (now: number, polledAt: number) => decideCapacity(typed, [...running, { ...quiet, polledAt }, landing], landing.id, observed, now);
  const fresh = at(6 * 60_000, 6 * 60_000 - 1000);
  assert.match(fresh.reason, /preserving memory headroom for sentinel/, "a waiter still asking keeps its place");
  const stale = at(17 * 60_000, 0);
  assert.equal(stale.admitted, true);
  assert.equal(stale.head, "landing");
  assert.equal(capacityOrder([...running, quiet, landing], typed.agingMs)[0]?.id, "sentinel", "it keeps its age for when it asks again");
  assert.equal(decideCapacity(typed, [...running, { ...quiet, polledAt: 17 * 60_000 }, landing], "sentinel", observed, 17 * 60_000).admitted, true);
});

test("a kind of work learns its typical size from the 90th percentile of its latest peaks, never above its ceiling", () => {
  const peaks = (lane: CapacityRequest["lane"], ...gib: number[]): CapacitySample[] => gib.map((value) => ({ lane, peakBytes: value * GiB }));
  // 27 YardSmith landing peaks from peach-box's runner logs, 16 Nov.
  const landings = peaks("landing", 2.8, 3.9, 4.3, 4.8, 5.0, 5.1, 5.4, 5.5, 6.0, 6.1, 6.6, 6.7, 6.7, 7.0, 7.4, 7.5, 8.6, 8.7, 8.7, 9.1, 9.2, 9.4, 10.4, 10.5, 12.4, 16.3, 22.4);
  const learned = learnTypical(host, [...landings, ...peaks("agent", 3, 4), ...peaks("audit", 3, 5, 4, 3, 3, 3, 3, 3, 3, 30), ...peaks("image", ...Array(20).fill(0))]);
  assert.deepEqual(learned.landing, { bytes: 12.4 * GiB, source: "learned", samples: 27 });
  assert.deepEqual(learned.agent, { bytes: host.typical.agent, source: "configured", samples: 2 }, "too few peaks keep the configured size");
  assert.deepEqual(learned.audit, { bytes: 5 * GiB, source: "learned", samples: 10 }, "ten peaks size the work, and the single largest of them does not");
  assert.deepEqual(learnTypical(host, peaks("landing", 10, 12, 12, 1, 26.7)).landing, { bytes: host.typical.landing, source: "configured", samples: 5 },
    "a few peaks, one of them unusual (18 Nov), keep the configured size");
  assert.deepEqual(learned.image, { bytes: host.typical.image, source: "configured", samples: 0 }, "work outside its cgroup measured nothing");
  assert.equal(learnTypical(host, peaks("preview", ...Array(12).fill(30))).preview.bytes, host.profiles.preview);
  const shifted = learnTypical(host, [...peaks("release", ...Array(50).fill(14)), ...peaks("release", ...Array(50).fill(2))]);
  assert.deepEqual(shifted.release, { bytes: 2 * GiB, source: "learned", samples: 50 }, "only the latest 50 count");
});

test("with no fixed budget, a check starts beside previews and a release check whenever real memory holds it", () => {
  // peach-box, 16 Nov 10:49 GMT: an agent heavy check waited 14 minutes on "active commitments fill the host budget".
  const running = [preview("yardsmith"), preview("weave"), preview("isolated"), { ...request("release", "release", 0, 16 * GiB), admittedAt: 0 }];
  const check = request("check", "agent", 1, 16 * GiB);
  const observed = { ...peachBox, availableBytes: 39.9 * GiB, currentBytes: { yardsmith: 4.4 * GiB, weave: 4.1 * GiB, isolated: 2.6 * GiB, release: 1.7 * GiB },
    peakBytes: { yardsmith: 6.5 * GiB, weave: 5.2 * GiB, isolated: 4.8 * GiB, release: 13.4 * GiB } };
  const learnedAgent = { ...host, typical: { ...host.typical, agent: 6 * GiB } };
  assert.equal(decideCapacity(learnedAgent, [...running, check], check.id, observed, 2).admitted, true);
  assert.match(decideCapacity(host, [...running, check], check.id, observed, 2).reason, /waiting for available memory/, "at its 16 GiB ceiling it still needs real room");
});

// SJ-267: peach-box, 18 Nov 2026. Three previews admitted (each using about 4.5 GiB with a 5.6 GiB peak) and 41.7 GiB
// available; a landing queued at 04:30:41 waited its whole 30 minutes and failed.
const incident: CapacityPolicy = {
  ...policy, reserveBytes: 8 * GiB, agingMs: 60_000, maxWaitMs: 30 * 60_000,
  profiles: { landing: 24 * GiB, release: 16 * GiB, image: 16 * GiB, agent: 16 * GiB, audit: 16 * GiB, preview: 12 * GiB },
  typical: { landing: 12 * GiB, release: 16 * GiB, image: 8 * GiB, agent: 16 * GiB, audit: 16 * GiB, preview: 6 * GiB },
};
const minute = 60_000;
const previews = ["c57368b0", "3b4115f1", "80deb156"].map((id) => ({ ...request(id, "preview", 0, 12 * GiB), admittedAt: 0 }));
const incidentReading = (usedGiB: number, peakGiB: number): CapacityReading => ({
  totalBytes: 62.4 * GiB, availableBytes: 41.7 * GiB, memoryFullAvg10: 0,
  currentBytes: Object.fromEntries(previews.map(({ id }) => [id, usedGiB * GiB])), peakBytes: Object.fromEntries(previews.map(({ id }) => [id, peakGiB * GiB])),
});

test("a landing queued beside three running previews is admitted within its wait limit", () => {
  const landing = { ...request("landing", "landing", 30 * minute, 24 * GiB), polledAt: 31 * minute };
  // Before: typical sizes learned from memory.peak (landing at its 24 GiB ceiling, previews 7.75 GiB) left 24 GiB free.
  // Its first poll is still inside the five minutes in which real memory alone does not decide.
  const inflated = { ...incident, typical: { ...incident.typical, landing: 24 * GiB, preview: 7.75 * GiB } };
  // The previews are taken as just started here, so each still counts by the lane's size as every preview did then.
  const fresh = previews.map((preview) => ({ ...preview, admittedAt: 30 * minute }));
  const before = decideCapacity(inflated, [...fresh, landing], landing.id, incidentReading(4.5, 5.6), 31 * minute);
  assert.equal(before.admitted, false);
  // After: legacy peaks size nothing, so the configured typical sizes apply, and the previews count by the memory they
  // cannot give back. The landing is admitted at its first poll.
  const after = decideCapacity(withLearnedTypical(incident, []), [...previews, landing], landing.id, incidentReading(4.5, 5.6), 31 * minute);
  assert.equal(after.admitted, true, after.reason);
  // Even sized at its whole ceiling, as a landing with learned 24 GiB peaks would be, it fits.
  const ceiling = decideCapacity({ ...incident, typical: { ...incident.typical, landing: 24 * GiB } }, [...previews, landing], landing.id, incidentReading(4.5, 5.6), 31 * minute);
  assert.equal(ceiling.admitted, true, ceiling.reason);
});

test("a preview queued before a landing is not admitted ahead of it while the landing waits", () => {
  // The two combined previews queued 18 minutes before the landing; by age alone they were ahead of it.
  const yardsmith = { ...request("3b4115f1", "preview", 12 * minute, 12 * GiB), polledAt: 36 * minute };
  const weave = { ...request("80deb156", "preview", 13 * minute, 12 * GiB), polledAt: 36 * minute };
  const landing = { ...request("landing", "landing", 30 * minute, 24 * GiB), polledAt: 36 * minute };
  assert.deepEqual(capacityOrder([yardsmith, weave, landing], incident.agingMs).map(({ id }) => id), ["landing", "3b4115f1", "80deb156"]);
  // Past the reserve and the running preview's 1.5 GiB of room to grow, 12.5 GiB is free: room for the 12 GiB landing
  // or a 6 GiB preview, not both.
  const tight: CapacityReading = { totalBytes: 62.4 * GiB, availableBytes: 22 * GiB, memoryFullAvg10: 0, currentBytes: {}, peakBytes: {} };
  const queued = [previews[0]!, yardsmith, weave, landing];
  const observed = { ...tight, currentBytes: { c57368b0: 4.5 * GiB }, peakBytes: { c57368b0: 5.6 * GiB } };
  const held = decideCapacity(incident, queued, yardsmith.id, observed, 36 * minute);
  assert.equal(held.admitted, false);
  assert.match(held.reason, /preserving memory headroom for landing/);
  assert.equal(decideCapacity(incident, queued, landing.id, observed, 36 * minute).admitted, true);
});

test("landings go ahead of previews only: previews still age ahead of other background work", () => {
  const preview = request("preview", "preview", 0);
  const image = request("image", "image", 5 * minute);
  const landing = request("landing", "landing", 10 * minute);
  const release = request("release", "release", 0);
  assert.deepEqual(capacityOrder([image, preview], incident.agingMs).map(({ id }) => id), ["preview", "image"], "an older preview still precedes newer work");
  assert.deepEqual(capacityOrder([landing, image, preview, release], incident.agingMs).map(({ id }) => id), ["release", "landing", "preview", "image"],
    "the landing moves to just before the first preview, ahead of work aged in between; older non-preview work keeps its place");
  const later = request("later", "landing", 20 * minute);
  assert.deepEqual(capacityOrder([later, preview, landing], incident.agingMs).map(({ id }) => id), ["landing", "later", "preview"], "landings keep their own order");
});

test("a job holding large file cache but little anonymous memory counts by what it cannot give back", () => {
  // A landing gate whose memory.peak reached 31.8 GB, nearly all of it checkout and install cache.
  const gate = { ...request("gate", "landing", 0, 24 * GiB), admittedAt: 0 };
  const decision = decideCapacity(incident, [gate], gate.id, { ...incidentReading(0, 0), currentBytes: { gate: 2 * GiB }, peakBytes: { gate: 5 * GiB } }, 1);
  assert.equal(decision.activeBytes, 12 * GiB, "its typical size, not its ceiling");
  assert.deepEqual(learnTypical(incident, [5, 7, 6, 5, 6, 7, 5, 6, 7, 6].map((gib) => ({ lane: "landing" as const, peakBytes: gib * GiB }))).landing,
    { bytes: 7 * GiB, source: "learned", samples: 10 });
});

// the same 18 Nov incident, where a landing waited its full 30 minutes beside a host with no memory pressure at
// all. 41.7 GiB available less the 8 GiB reserve holds a landing's 24 GiB need, but the room three running previews might
// still grow into (8 GiB each) only leaves 10 GiB of it, so the forecast alone kept the landing out.
const taking: CapacityPolicy = { ...incident, typical: { ...incident.profiles }, takeRoomAfterMs: 5 * minute };
/** Previews holding 4 GiB each, counted at their 12 GiB typical size: 24 GiB of growth room no one is using. */
const growing: CapacityReading = {
  ...incidentReading(0, 0), availableBytes: 41.7 * GiB,
  currentBytes: Object.fromEntries(previews.map(({ id }) => [id, 4 * GiB])),
  peakBytes: Object.fromEntries(previews.map(({ id }) => [id, 11.5 * GiB])),
};
const queued = (lane: CapacityRequest["lane"], waitedMs: number): CapacityRequest => ({
  ...request("gate", lane, 30 * minute, incident.profiles[lane]), polledAt: 30 * minute + waitedMs,
});
const waiting = (request: CapacityRequest, reading: CapacityReading = growing, waitedMs = 5 * minute) =>
  decideCapacity(taking, [...previews, request], request.id, reading, 30 * minute + waitedMs);

test("a landing waiting under five minutes still waits for the growth room running previews may need", () => {
  const decision = waiting(queued("landing", 4 * minute + 59_000), growing, 4 * minute + 59_000);
  assert.equal(decision.admitted, false, decision.reason);
  assert.match(decision.reason, /preserving memory headroom|waiting for available memory/);
  assert.equal(decision.outstandingBytes, 24 * GiB, "the forecast that holds it out");
});

test("a landing that has waited five minutes takes room the host really has, whatever others may grow into", () => {
  const decision = waiting(queued("landing", 5 * minute));
  assert.equal(decision.admitted, true, decision.reason);
  assert.match(decision.reason, /admitted after 5 min: real memory holds it; others' growth room not reserved/);
  assert.equal(decision.outstandingBytes, 24 * GiB, "the growth room is still reported, just not reserved");
});

test("a release check that has waited five minutes takes room on the same terms", () => {
  const run = queued("release", 5 * minute);
  assert.equal(waiting(run, growing, 4 * minute + 59_000).admitted, false, "a release check under five minutes still waits");
  const taken = waiting(run);
  assert.equal(taken.admitted, true, taken.reason);
  assert.match(taken.reason, /real memory holds it/);
});

test("previews, agents, images and audits keep waiting for the growth room however long they have waited", () => {
  for (const lane of ["preview", "agent", "image", "audit"] as const) {
    const decision = waiting(queued(lane, 20 * minute), growing, 20 * minute);
    assert.equal(decision.admitted, false, `${lane}: ${decision.reason}`);
    assert.doesNotMatch(decision.reason, /real memory holds it/);
  }
});

test("a landing real memory cannot hold still waits, and fails at the wait limit", () => {
  // 30 GiB available less the 8 GiB reserve is below the landing's 24 GiB need.
  const short: CapacityReading = { ...growing, availableBytes: 30 * GiB };
  const held = waiting(queued("landing", 5 * minute), short);
  assert.equal(held.admitted, false);
  const expired = waiting(queued("landing", 30 * minute), short, 30 * minute);
  assert.equal(expired.admitted, false);
  assert.match(expired.reason, /wait limit reached/);
  // Pressure over the limit means a genuinely overloaded host, however long it waited.
  const pressured: CapacityReading = { ...growing, memoryFullAvg10: 6 };
  assert.equal(waiting(queued("landing", 5 * minute), pressured).admitted, false);
  const pressuredExpiry = waiting(queued("landing", 30 * minute), pressured, 30 * minute);
  assert.equal(pressuredExpiry.admitted, false);
  assert.match(pressuredExpiry.reason, /wait limit reached/);
});

test("an unreadable reading keeps its own answer past the take-room threshold and the wait limit", () => {
  for (const observed of [null, { ...growing, memoryFullAvg10: null }, { ...growing, availableBytes: NaN }]) {
    const decision = waiting(queued("landing", 30 * minute), observed as CapacityReading, 30 * minute);
    assert.equal(decision.admitted, false);
    assert.doesNotMatch(decision.reason, /real memory holds it|wait limit/);
  }
});

test("the take-room threshold is read from hostBudget and defaults to five minutes", () => {
  assert.equal(readCapacityPolicy({ hostBudget: { mode: "shadow" } })?.takeRoomAfterMs, 5 * 60_000);
  assert.equal(readCapacityPolicy({ hostBudget: { mode: "shadow", takeRoomAfterMs: 90_000 } })?.takeRoomAfterMs, 90_000);
  for (const value of [0, -1, 1.5, "300000"]) {
    assert.throws(() => readCapacityPolicy({ hostBudget: { mode: "shadow", takeRoomAfterMs: value } }), /takeRoomAfterMs/);
  }
  // A host configured to wait longer for the forecast keeps landings waiting that long.
  const patient: CapacityPolicy = { ...taking, takeRoomAfterMs: 10 * minute };
  const landing = queued("landing", 5 * minute);
  assert.equal(decideCapacity(patient, [...previews, landing], landing.id, growing, 35 * minute).admitted, false);
  assert.equal(decideCapacity(patient, [...previews, landing], landing.id, growing, 40 * minute).admitted, true);
});

test("a preview that has served ten minutes counts by what it holds, so other work is not kept out by room it never takes", () => {
  // peach-box, 18 Nov: three combined previews held 4.5 GiB (5.6 GiB at most) against a learned 10.6 GiB preview size.
  const learned: CapacityPolicy = { ...incident, typical: { ...incident.typical, preview: 10.6 * GiB } };
  const reading = incidentReading(4.5, 5.6);
  const check = { ...request("check", "agent", 40 * minute, 16 * GiB), polledAt: 40 * minute };
  const at = (admittedAt: number) => previews.map((preview) => ({ ...preview, admittedAt }));
  for (const preview of at(0)) assert.equal(countedBytes(learned, preview, reading, 40 * minute), 6.6 * GiB, "its 5.6 GiB peak and a 1 GiB margin");
  assert.equal(decideCapacity(learned, [...at(0), check], check.id, reading, 40 * minute).admitted, true, "16 GiB fits beside three settled previews");
  // Five minutes in, a preview may still be compiling: it counts at the size previews reach.
  for (const preview of at(35 * minute)) assert.equal(countedBytes(learned, preview, reading, 40 * minute), 10.6 * GiB);
  assert.equal(decideCapacity(learned, [...at(35 * minute), check], check.id, reading, 40 * minute).admitted, false);
  // Unmeasured, it counts at its whole ceiling, as before.
  assert.equal(countedBytes(learned, at(0)[0]!, null, 40 * minute), 12 * GiB);
  // Only previews: a landing gate holding the same counts by its kind's size.
  const gate = { ...request("c57368b0", "landing", 0, 24 * GiB), admittedAt: 0 };
  assert.equal(countedBytes(learned, gate, reading, 40 * minute), 12 * GiB);
});
