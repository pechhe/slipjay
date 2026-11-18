import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import { openCapacityStore, readCapacityWaits } from "../../src/lib/runner/host-capacity-store.ts";
import { CAPACITY_WAIT_RETENTION_MS, formatCapacityWaits, summariseCapacityWaits, type CapacityClass, type CapacityPolicy, type CapacityRequest } from "../../src/lib/runner/host-capacity.ts";

const policy: CapacityPolicy = {
  mode: "enforce", reserveBytes: 6, agingMs: 10, maxWaitMs: 10_000, maxMemoryFullAvg10: 5,
  profiles: { landing: 4, release: 4, image: 4, agent: 4, audit: 4, preview: 4 },
  typical: { landing: 4, release: 4, image: 4, agent: 4, audit: 4, preview: 4 },
};
const request = (id: string, lane: CapacityClass = "landing", queuedAt = 0): CapacityRequest =>
  ({ id, job: id, lane, bytes: 4, queuedAt, admittedAt: null, cgroup: "/missing-fixture", owner: { kind: "holder", path: `/fixture/${id}`, identity: id } });
// 20 available less the 6 reserve holds three 4-byte jobs; a fourth waits for room.
const observe = (requests: readonly CapacityRequest[]) => ({
  owners: Object.fromEntries(requests.map((item) => [item.id, "alive" as const])),
  reading: { totalBytes: 64, availableBytes: 20, memoryFullAvg10: 0, currentBytes: {}, peakBytes: {} },
});
const fixture = () => {
  const root = join(tmpdir(), `host-capacity-waits-${randomUUID()}-scratch`);
  mkdirSync(root);
  return root;
};
/** Three jobs fill the fixture host, so a fourth waits. Each is admitted on its first poll, a zero-second wait. */
const fill = (store: ReturnType<typeof openCapacityStore>, now: number) => ["a", "b", "c"].forEach((id, index) => {
  assert.equal(store.poll({ ...request(id, "image"), queuedAt: now }, policy, observe, now + index).outcome, "admitted");
});

test("a request admitted after waiting and one that ran out of time each leave one wait row and the right summary", () => {
  const root = fixture();
  const path = join(root, "ledger.sqlite");
  const store = openCapacityStore(path);
  try {
    fill(store, 1000);
    const gate = request("gate", "landing", 2000);
    const check = request("check", "agent", 2000);
    assert.equal(store.poll(gate, policy, observe, 2000).outcome, "waiting");
    assert.equal(store.poll(check, policy, observe, 2000).outcome, "waiting");
    assert.equal(store.poll(gate, policy, observe, 4000).outcome, "waiting");
    // Room appears: two jobs finished, and the waiter is admitted six seconds after it arrived.
    store.finish("b", request("b").owner, () => true);
    store.finish("c", request("c").owner, () => true);
    assert.equal(store.poll(gate, policy, observe, 8000).outcome, "admitted");
    assert.equal(store.poll(check, policy, observe, 12_000).outcome, "unavailable", "its arrival is 10s before the wait limit");
    assert.deepEqual(store.waits(0), [
      { lane: "image", job: "a", queuedAt: 1000, endedAt: 1000, outcome: "admitted" },
      { lane: "image", job: "b", queuedAt: 1000, endedAt: 1001, outcome: "admitted" },
      { lane: "image", job: "c", queuedAt: 1000, endedAt: 1002, outcome: "admitted" },
      { lane: "landing", job: "gate", queuedAt: 2000, endedAt: 8000, outcome: "admitted" },
      { lane: "agent", job: "check", queuedAt: 2000, endedAt: 12_000, outcome: "wait-limit" },
    ], "one row per request, whether it waited nothing or ran out of time");
    const waits = summariseCapacityWaits(store.waits(0));
    assert.deepEqual(waits, {
      value: 10,
      evidence: {
        image: { count: 3, p50: 0, p90: 0, max: 0, waitLimit: 0 },
        landing: { count: 1, p50: 6, p90: 6, max: 6, waitLimit: 0 },
        agent: { count: 1, p50: 10, p90: 10, max: 10, waitLimit: 1 },
      },
    }, "the largest p90 across kinds of work is the number a metric reads");
    const text = formatCapacityWaits(waits, 24);
    assert.match(text, /image: 3 ended, p50 0s, p90 0s, max 0s, 0 at the wait limit/);
    assert.match(text, /landing: 1 ended, p50 6s, p90 6s, max 6s, 0 at the wait limit/);
    assert.match(text, /agent: 1 ended, p50 10s, p90 10s, max 10s, 1 at the wait limit/);
    assert.deepEqual(readCapacityWaits(path, 0).map((wait) => wait.job), ["a", "b", "c", "gate", "check"]);
    assert.deepEqual(readCapacityWaits(path, 8000).map((wait) => wait.job), ["gate", "check"], "the window includes its own start");
    assert.deepEqual(readCapacityWaits(path, 8001).map((wait) => wait.job), ["check"]);
    // Recovery of the request that already gave up adds no second row and does not rewrite its end.
    store.recover((requests) => ({ ...observe(requests), owners: { ...observe(requests).owners, check: "gone" } }), 13_000);
    assert.deepEqual(store.waits(0).filter((wait) => wait.job === "check"), [{ lane: "agent", job: "check", queuedAt: 2000, endedAt: 12_000, outcome: "wait-limit" }]);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("queued work whose owner ends before admission records the wait it did not finish", () => {
  const root = fixture();
  const store = openCapacityStore(join(root, "ledger.sqlite"));
  try {
    fill(store, 1000);
    const preview = request("preview", "preview", 2000);
    assert.equal(store.poll(preview, policy, observe, 2000).outcome, "waiting");
    assert.equal(store.recover((requests) => ({ ...observe(requests), owners: { ...observe(requests).owners, preview: "gone" } }), 5000), 1);
    const [wait] = store.waits(0).filter((row) => row.job === "preview");
    assert.equal(wait?.outcome, "abandoned");
    assert.equal(wait?.lane, "preview");
    assert.equal(wait?.queuedAt, 2000, "the arrival it kept while it waited");
    assert.equal(wait?.endedAt, 5000, "the moment recovery saw its owner gone");
    assert.equal(store.requests().length, 3, "the abandoned request has left the ledger");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an already-admitted request's later polls and its completion add no further row", () => {
  const root = fixture();
  const store = openCapacityStore(join(root, "ledger.sqlite"));
  try {
    const gate = request("gate", "landing", 0);
    assert.equal(store.poll(gate, policy, observe, 1000).outcome, "admitted");
    assert.equal(store.requests()[0]?.admittedAt, 1000);
    for (const now of [2000, 5000, 9000]) assert.equal(store.poll(gate, policy, observe, now).request.admittedAt, 1000);
    store.finish("gate", gate.owner, () => true);
    assert.deepEqual(store.waits(0), [{ lane: "landing", job: "gate", queuedAt: 0, endedAt: 1000, outcome: "admitted" }]);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("waits older than a week go with the next one written", () => {
  const root = fixture();
  const path = join(root, "ledger.sqlite");
  const store = openCapacityStore(path);
  try {
    fill(store, 1000);
    assert.equal(store.poll(request("stale", "landing", 1000), policy, observe, 11_000).outcome, "unavailable");
    assert.deepEqual(store.waits(0).map((wait) => wait.job), ["a", "b", "c", "stale"]);
    // Seven days and a millisecond later the write that ends another wait removes the first.
    const later = 11_000 + CAPACITY_WAIT_RETENTION_MS + 1;
    store.finish("a", request("a").owner, () => true);
    assert.equal(store.poll(request("fresh", "landing", later), policy, observe, later).outcome, "admitted");
    assert.deepEqual(store.waits(0).map((wait) => wait.job), ["fresh"], "every row older than a week went with the write");
    assert.deepEqual(store.waits(later).map((wait) => wait.job), ["fresh"], "a window inside the retention keeps what it has");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a read-only waits report creates no ledger and copes with one written before waits were", () => {
  const root = fixture();
  try {
    const missing = join(root, "missing.sqlite");
    assert.deepEqual(readCapacityWaits(missing, 0), []);
    assert.equal(existsSync(missing), false, "reporting waits never writes a ledger");
    const old = join(root, "old.sqlite");
    const db = new DatabaseSync(old);
    db.exec("CREATE TABLE requests (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE decisions (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, request_id TEXT NOT NULL, body TEXT NOT NULL);");
    db.close();
    assert.deepEqual(readCapacityWaits(old, 0), [], "a ledger from before waits reports none");
    const store = openCapacityStore(old);
    try {
      assert.equal(store.poll(request("gate", "landing", 500), policy, observe, 500).outcome, "admitted");
      assert.equal(store.poll(request("gate"), policy, observe, 9000).request.admittedAt, 500, "an upgraded ledger keeps admitting as before");
    } finally { store.close(); }
    assert.deepEqual(readCapacityWaits(old, 0).map((wait) => wait.job), ["gate"], "and keeps the wait it admitted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the summary reports no waits as an empty report with a zero value", () => {
  assert.deepEqual(summariseCapacityWaits([]), { value: 0, evidence: {} });
  assert.match(formatCapacityWaits(summariseCapacityWaits([]), 24), /none/);
  const ten = summariseCapacityWaits(Array.from({ length: 10 }, (_, index) => ({ lane: "agent" as const, job: `job-${index}`, queuedAt: 0, endedAt: (index + 1) * 1000, outcome: "admitted" as const })));
  assert.deepEqual(ten.evidence.agent, { count: 10, p50: 5, p90: 9, max: 10, waitLimit: 0 }, "the ninth wait is the 90th percentile of ten");
});
