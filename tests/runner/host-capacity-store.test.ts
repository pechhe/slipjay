import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import { openCapacityStore } from "../../src/lib/runner/host-capacity-store.ts";
import { capacityOwnerState, currentCapacityOwner, processStart, readCapacityObservation, readCapacityPolicy, residentBytes } from "../../src/lib/runner/host-capacity-local.ts";
import { decideCapacity, type CapacityPolicy, type CapacityRequest } from "../../src/lib/runner/host-capacity.ts";

const policy: CapacityPolicy = {
  mode: "enforce", reserveBytes: 8, agingMs: 10, maxWaitMs: 1000, maxMemoryFullAvg10: 5,
  profiles: { landing: 4, release: 4, image: 4, agent: 4, audit: 4, preview: 4 },
  typical: { landing: 4, release: 4, image: 4, agent: 4, audit: 4, preview: 4 },
};
const request = (id: string): CapacityRequest => ({ id, job: id, lane: "landing", bytes: 4, queuedAt: 0, admittedAt: null, cgroup: "/missing-fixture", owner: { kind: "holder", path: `/fixture/${id}`, identity: id } });
const observe = (requests: readonly CapacityRequest[]) => ({
  owners: Object.fromEntries(requests.map((item) => [item.id, "alive" as const])),
  // 20 available less the 8 reserve holds three 4-byte jobs.
  reading: { totalBytes: 64, availableBytes: 20, memoryFullAvg10: 0, currentBytes: {}, peakBytes: {} },
});
const fixture = () => {
  const root = join(tmpdir(), `host-capacity-${randomUUID()}-scratch`);
  mkdirSync(root);
  return root;
};

test("separate callers cannot both spend the final commitment, and replays preserve their arrival", () => {
  const root = fixture();
  const first = openCapacityStore(join(root, "ledger.sqlite"));
  const second = openCapacityStore(join(root, "ledger.sqlite"));
  try {
    assert.equal(first.poll(request("one"), policy, observe, 1).outcome, "admitted");
    assert.equal(second.poll(request("two"), policy, observe, 2).outcome, "admitted");
    assert.equal(first.poll(request("three"), policy, observe, 3).outcome, "admitted");
    assert.equal(second.poll(request("four"), policy, observe, 4).outcome, "waiting");
    const replay = second.poll({ ...request("four"), queuedAt: 500 }, policy, observe, 5);
    assert.equal(replay.request.queuedAt, 0);
    assert.equal(second.poll({ ...request("four"), owner: { identity: "four", path: "/fixture/four", kind: "holder" } }, policy, observe, 6).request.queuedAt, 0);
    assert.equal(second.poll(request("four"), policy, observe, 1000).outcome, "unavailable");
    assert.throws(() => first.poll({ ...request("one"), bytes: 5 }, policy, observe, 2), /different owner or commitment/);
    assert.equal(first.requests().filter((item) => item.admittedAt !== null).length, 3);
  } finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
});

test("unknown ownership retains claims across restart and switching to shadow", () => {
  const root = fixture();
  let store = openCapacityStore(join(root, "ledger.sqlite"));
  try {
    store.poll(request("one"), policy, observe, 1);
    store.close();
    store = openCapacityStore(join(root, "ledger.sqlite"));
    const unknown = (requests: readonly CapacityRequest[]) => ({ ...observe(requests), owners: { one: "unknown" as const } });
    assert.equal(store.recover(unknown), 0);
    assert.equal(store.requests().length, 1);
    const shadow = store.poll(request("two"), { ...policy, mode: "shadow", reserveBytes: 16 }, observe, 2);
    assert.equal(shadow.outcome, "admitted");
    assert.equal(shadow.decision.admitted, false, "shadow preserves the would-wait decision");
    assert.equal(store.requests().length, 2);
    assert.equal(store.recover((requests) => ({ ...observe(requests), owners: { one: "gone", two: "unknown" } })), 1);
    assert.equal(store.requests()[0]?.id, "two");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("concurrent processes serialize admission in the shared host ledger", async () => {
  const root = fixture();
  const module = new URL("../../src/lib/runner/host-capacity-store.ts", import.meta.url).href;
  const path = join(root, "ledger.sqlite");
  // Race the first open too: journal and schema setup need the same bounded busy handling as admission.
  const source = `import { openCapacityStore } from ${JSON.stringify(module)};
    const store=openCapacityStore(process.argv[1]); const request=JSON.parse(process.argv[2]); const policy=JSON.parse(process.argv[3]);
    const receipt=store.poll(request, policy, requests=>({owners:Object.fromEntries(requests.map(r=>[r.id,'alive'])),reading:{totalBytes:64,availableBytes:20,memoryFullAvg10:0,currentBytes:{},peakBytes:{}}}),1);
    console.log(receipt.outcome);store.close();`;
  try {
    const outcomes = await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise<string>((resolve, reject) => {
      const child = spawn("bun", ["-e", source, path, JSON.stringify(request(`job-${index}`)), JSON.stringify(policy)]);
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
    })));
    assert.equal(outcomes.filter((outcome) => outcome === "admitted").length, 3);
    assert.equal(outcomes.filter((outcome) => outcome === "waiting").length, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Linux owner identity handles comm parentheses, PID reuse and missing holders conservatively", () => {
  assert.equal(processStart(`123 (name with ) parentheses) S ${Array.from({ length: 18 }, () => "0").join(" ")} 456`), "456");
  assert.equal(processStart("malformed"), null);
  if (process.platform !== "linux") return;
  const root = fixture();
  try {
    const owner = currentCapacityOwner();
    assert.equal(capacityOwnerState({ ...request("current"), owner }), "alive");
    if (owner.kind === "process") assert.equal(capacityOwnerState({ ...request("reused"), owner: { ...owner, start: "0" } }), "gone");
    const holder = join(root, "id");
    writeFileSync(holder, "held");
    const held = { ...request("held"), owner: { kind: "holder" as const, path: holder, identity: "held" } };
    assert.equal(capacityOwnerState(held), "alive");
    rmSync(holder);
    assert.equal(capacityOwnerState(held), "gone");
    assert.equal(capacityOwnerState({ ...held, cgroup: null }), "unknown");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed host policy cannot silently disable enforcement", () => {
  assert.equal(readCapacityPolicy({}), null);
  assert.throws(() => readCapacityPolicy({ hostBudget: { mode: "off" } }), /mode/);
  assert.throws(() => readCapacityPolicy({ hostBudget: { mode: "enforce", extra: 1 } }), /unknown/);
  assert.throws(() => readCapacityPolicy({ hostBudget: { mode: "enforce", profiles: { image: -1 } } }), /integer/);
  assert.equal(readCapacityPolicy({ hostBudget: { mode: "shadow" } })?.mode, "shadow");
  assert.throws(() => readCapacityPolicy({ hostBudget: { mode: "enforce", typical: { image: 0 } } }), /integer/);
  assert.throws(() => readCapacityPolicy({ hostBudget: { mode: "enforce", typical: { gpu: 1 } } }), /unknown/);
  assert.throws(() => readCapacityPolicy({ hostBudget: { mode: "enforce", profiles: { preview: 4096 }, typical: { preview: 8192 } } }), /exceed/);
});

test("finished jobs leave their peak in a history that outlives the per-poll decisions, and admission learns from it", () => {
  const root = fixture();
  const store = openCapacityStore(join(root, "ledger.sqlite"));
  try {
    const roomy = (peaks: Record<string, number> = {}) => (requests: readonly CapacityRequest[]) => ({
      owners: Object.fromEntries(requests.map((item) => [item.id, "alive" as const])),
      reading: { totalBytes: 64 * 1024 ** 3, availableBytes: 64 * 1024 ** 3, memoryFullAvg10: 0, currentBytes: Object.fromEntries(requests.map((item) => [item.id, 0])), peakBytes: peaks } });
    const sized = { ...policy, profiles: { ...policy.profiles, agent: 1024 ** 3 }, typical: { ...policy.typical, agent: 1024 ** 3 } };
    // A command job's peak comes with its completion; a holder's from what the ledger saw while it ran.
    for (let index = 0; index < 10; index += 1) {
      const job = { ...request(`command-${index}`), lane: "agent" as const, bytes: 1024 ** 3 };
      store.poll(job, sized, roomy(), index);
      assert.equal(store.finish(job.id, job.owner, () => true, { memoryPeakBytes: (100 + index) * 1024 ** 2 }), true);
    }
    const holder = request("holder");
    store.poll(holder, sized, roomy(), 20);
    store.poll(request("watcher"), sized, roomy({ holder: 300 * 1024 ** 2 }), 21);
    store.recover((requests) => ({ ...roomy()(requests), owners: { holder: "gone", watcher: "alive" } }));
    for (let index = 0; index < 1100; index += 1) store.poll(request("watcher"), sized, roomy(), 30 + index);
    const learned = store.typical(sized);
    assert.deepEqual(learned.agent, { bytes: 108 * 1024 ** 2, source: "learned", samples: 10 });
    assert.deepEqual(learned.landing, { bytes: sized.typical.landing, source: "configured", samples: 1 }, "the holder's 300 MiB is one sample");
    // Jobs that measured nothing, such as Docker builds, never displace the measured peaks.
    for (let index = 0; index < 60; index += 1) {
      const job = { ...request(`empty-${index}`), lane: "agent" as const, bytes: 1024 ** 3 };
      store.poll(job, sized, roomy(), 1200 + index);
      store.finish(job.id, job.owner, () => true, { memoryPeakBytes: 1024 ** 2 });
    }
    assert.deepEqual(store.typical(sized).agent, learned.agent);
    const next = { ...request("next"), lane: "agent" as const, bytes: 1024 ** 3, queuedAt: 2000 };
    const tight = (requests: readonly CapacityRequest[]) => ({ ...roomy()(requests), reading: { ...roomy()(requests).reading, availableBytes: 8 + 200 * 1024 ** 2 } });
    assert.equal(store.poll(next, { ...sized, reserveBytes: 8 }, tight, 2000).outcome, "admitted", "admitted at its learned 108 MiB, not its 1 GiB ceiling");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a finished job's peak keeps when it grew, one note per step, and an older ledger gains the record", () => {
  const root = fixture();
  const path = join(root, "ledger.sqlite");
  // A ledger written before growth was recorded.
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE peaks (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, lane TEXT NOT NULL, job TEXT NOT NULL, peak_bytes INTEGER NOT NULL); INSERT INTO peaks(at,lane,job,peak_bytes) VALUES (1,'landing','before',1073741824);");
  old.close();
  const store = openCapacityStore(path);
  try {
    const GiB = 1024 ** 3;
    const seen = (peak: number | null) => (requests: readonly CapacityRequest[]) => ({
      owners: Object.fromEntries(requests.map((item) => [item.id, "alive" as const])),
      reading: { totalBytes: 64 * GiB, availableBytes: 64 * GiB, memoryFullAvg10: 0, currentBytes: { gate: 0 }, peakBytes: (peak === null ? {} : { gate: peak }) as Record<string, number> } });
    const sized = { ...policy, profiles: { ...policy.profiles, landing: 24 * GiB }, typical: { ...policy.typical, landing: 24 * GiB } };
    const gate = { ...request("gate"), bytes: 24 * GiB, queuedAt: 1000 };
    store.poll(gate, sized, seen(null), 1000);
    store.poll(gate, sized, seen(GiB), 3000);
    store.poll(gate, sized, seen(GiB + 1024 ** 2), 4000);
    store.poll(gate, sized, seen(5 * GiB), 61_000);
    store.finish(gate.id, gate.owner, () => true, { memoryPeakBytes: 5 * GiB });
    const rows = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(rows.prepare("SELECT job, growth FROM peaks ORDER BY seq").all().map((row) => ({ ...row })), [
        { job: "before", growth: null },
        { job: "gate", growth: JSON.stringify([[2000, GiB], [60_000, 5 * GiB]]) },
      ], "a rise smaller than a step adds no note");
    } finally { rows.close(); }
    assert.equal(store.typical(sized).landing.samples, 2, "the earlier peak still counts");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an image job's runner adds its BuildKit container's memory to its own, and its peak only rises", () => {
  const root = fixture();
  const store = openCapacityStore(join(root, "ledger.sqlite"));
  try {
    // This test process's own cgroup stands in for the job's: its counters are real.
    const own = /^0::(\/.*)$/m.exec(readFileSync("/proc/self/cgroup", "utf8"))?.[1] ?? null;
    const job = { ...request("image"), lane: "image" as const, cgroup: own };
    store.poll(job, policy, observe, 1);
    store.noteUsage(job.id, job.owner, 3 * 1024 ** 3, 5 * 1024 ** 3);
    store.noteUsage(job.id, job.owner, 1024 ** 3, 2 * 1024 ** 3);
    const [noted] = store.requests();
    assert.deepEqual([noted!.externalBytes, noted!.peakBytes], [1024 ** 3, 5 * 1024 ** 3], "the latest outside use, the highest peak");
    assert.throws(() => store.noteUsage(job.id, { kind: "holder", path: "/other", identity: "other" }, 0, 0), /another owner/);
    const reading = readCapacityObservation(store.requests()).reading;
    assert.ok(reading!.currentBytes[job.id]! > 1024 ** 3, "the container's memory counts as the job's");
    assert.ok(reading!.peakBytes[job.id]! >= 5 * 1024 ** 3);
    assert.equal(store.finish(job.id, job.owner, () => true, { memoryPeakBytes: 100 * 1024 ** 2, measuredPeakBytes: 6 * 1024 ** 3 }), true);
    assert.equal(store.typical(policy).image.samples, 1, "a measured image build is a sample");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("resident memory is anonymous and kernel memory, not file cache, and unknown without both", () => {
  assert.equal(residentBytes("anon 100\nfile 9000\nkernel 20\nslab 15\nslab_reclaimable 12\n"), 108);
  assert.equal(residentBytes("anon 100\nfile 9000\n"), null);
});

test("each poll records when its owner last asked, and a later poll keeps the original arrival", () => {
  const root = fixture();
  const store = openCapacityStore(join(root, "ledger.sqlite"));
  try {
    const waiting = request("waiting");
    assert.equal(store.poll(waiting, policy, observe, 5).request.polledAt, 5);
    const again = store.poll({ ...waiting, queuedAt: 40 }, policy, observe, 40).request;
    assert.equal(again.queuedAt, 0);
    assert.equal(again.polledAt, 40);
    assert.equal(store.requests()[0]?.polledAt, 40);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a host with no typical sizes admits exactly as before: every job counts at its whole profile", () => {
  const legacy = readCapacityPolicy({ hostBudget: { mode: "enforce", profiles: { preview: 12 * 1024 ** 3 } } })!;
  assert.deepEqual(legacy.typical, legacy.profiles);
  const GiB = 1024 ** 3;
  const preview = (id: string): CapacityRequest => ({ ...request(id), lane: "preview", bytes: 12 * GiB, admittedAt: 0 });
  const landing: CapacityRequest = { ...request("landing"), bytes: 24 * GiB, queuedAt: 1 };
  const reading = { totalBytes: 62 * GiB, availableBytes: 42 * GiB, memoryFullAvg10: 0,
    currentBytes: { a: 4.5 * GiB, b: 4.5 * GiB }, peakBytes: { a: 6 * GiB, b: 5 * GiB } };
  const decision = decideCapacity(legacy, [preview("a"), preview("b"), landing], landing.id, reading, 2);
  assert.equal(decision.activeBytes, 24 * GiB, "measured peaks change nothing without typical sizes");
  assert.equal(decision.outstandingBytes, 15 * GiB);
  assert.equal(decision.admitted, false);
});

test("an unconfigured typical size counts each kind of work at its whole ceiling", () => {
  const configured = readCapacityPolicy({ hostBudget: { mode: "enforce", profiles: { preview: 12 * 1024 ** 3 }, typical: { preview: 6 * 1024 ** 3 } } })!;
  assert.equal(configured.typical.preview, 6 * 1024 ** 3);
  assert.equal(configured.profiles.preview, 12 * 1024 ** 3);
  assert.equal(configured.typical.landing, configured.profiles.landing);
});


test("verified completion retains queue, runtime and resource evidence after releasing ownership", () => {
  const root = fixture();
  const store = openCapacityStore(join(root, "ledger.sqlite"));
  try {
    store.poll(request("completed"), policy, observe, 1);
    const resources = { memoryPeakBytes: 42, memoryEvents: null };
    assert.equal(store.finish("completed", request("completed").owner, () => false, resources), false);
    assert.equal(store.requests().length, 1);
    assert.equal(store.finish("completed", request("completed").owner, () => true, resources), true);
    assert.equal(store.requests().length, 0);
    const completion = store.history().map((row) => JSON.parse(String(row.body))).find((row) => row.kind === "finished");
    assert.equal(completion.queueMs, 1);
    assert.ok(completion.runMs >= 0);
    assert.deepEqual(completion.evidence, resources);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});


test("an unavailable initialization lock fails within its bound and leaves the ledger recoverable", () => {
  const root = fixture();
  const path = join(root, "blocked.sqlite");
  const holder = new DatabaseSync(path);
  holder.exec("CREATE TABLE fixture (id INTEGER); BEGIN EXCLUSIVE;");
  const module = new URL("../../src/lib/runner/host-capacity-store.ts", import.meta.url).href;
  try {
    const child = spawnSync("bun", ["-e", `import { openCapacityStore } from ${JSON.stringify(module)}; openCapacityStore(process.argv[1]).close();`, path], {
      encoding: "utf8", timeout: 15_000,
    });
    assert.equal(child.error, undefined, "initialization must return before the outer process timeout");
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /database is locked/);
  } finally { holder.exec("ROLLBACK"); holder.close(); }
  try {
    const recovered = openCapacityStore(path);
    assert.deepEqual(recovered.requests(), []);
    recovered.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
