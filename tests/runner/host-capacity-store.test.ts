import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import { openCapacityStore } from "../../src/lib/runner/host-capacity-store.ts";
import { stopYieldedPreview } from "../../src/lib/runner/host-capacity-command.ts";
import { capacityOwnerState, currentCapacityOwner, processStart, readCapacityObservation, readCapacityPolicy, residentBytes } from "../../src/lib/runner/host-capacity-local.ts";
import { decideCapacity, type CapacityClass, type CapacityPolicy, type CapacityRequest } from "../../src/lib/runner/host-capacity.ts";

const policy: CapacityPolicy = {
  mode: "enforce", reserveBytes: 8, agingMs: 10, maxWaitMs: 1000, maxMemoryFullAvg10: 5, takeRoomAfterMs: 300_000,
  profiles: { landing: 4, release: 4, image: 4, agent: 4, audit: 4, preview: 4 },
  typical: { landing: 4, release: 4, image: 4, agent: 4, audit: 4, preview: 4 },
};
const request = (id: string, lane: CapacityClass = "landing"): CapacityRequest => ({ id, job: id, lane, bytes: 4, queuedAt: 0, admittedAt: null, cgroup: "/missing-fixture", owner: { kind: "holder", path: `/fixture/${id}`, identity: id } });
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
    assert.equal(first.poll(request("one", "image"), policy, observe, 1).outcome, "admitted");
    assert.equal(second.poll(request("two", "image"), policy, observe, 2).outcome, "admitted");
    assert.equal(first.poll(request("three", "image"), policy, observe, 3).outcome, "admitted");
    assert.equal(second.poll(request("four", "image"), policy, observe, 4).outcome, "waiting");
    const replay = second.poll({ ...request("four", "image"), queuedAt: 500 }, policy, observe, 5);
    assert.equal(replay.request.queuedAt, 0);
    assert.equal(second.poll({ ...request("four", "image"), owner: { identity: "four", path: "/fixture/four", kind: "holder" } }, policy, observe, 6).request.queuedAt, 0);
    assert.equal(second.poll(request("four", "image"), policy, observe, 1000).outcome, "unavailable");
    assert.throws(() => first.poll({ ...request("one", "image"), bytes: 5 }, policy, observe, 2), /different owner or commitment/);
    assert.equal(first.requests().filter((item) => item.admittedAt !== null).length, 3);
  } finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
});

test("unknown ownership retains claims across restart and switching to shadow", () => {
  const root = fixture();
  let store = openCapacityStore(join(root, "ledger.sqlite"));
  try {
    store.poll(request("one", "image"), policy, observe, 1);
    store.close();
    store = openCapacityStore(join(root, "ledger.sqlite"));
    const unknown = (requests: readonly CapacityRequest[]) => ({ ...observe(requests), owners: { one: "unknown" as const } });
    assert.equal(store.recover(unknown), 0);
    assert.equal(store.requests().length, 1);
    const shadow = store.poll(request("two", "image"), { ...policy, mode: "shadow", reserveBytes: 16 }, observe, 2);
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
  assert.equal(readCapacityPolicy({ hostBudget: { mode: "shadow" } })?.takeRoomAfterMs, 5 * 60_000, "landings take room after five minutes unless the host says otherwise");
  assert.throws(() => readCapacityPolicy({ hostBudget: { mode: "enforce", typical: { image: 0 } } }), /integer/);
  assert.throws(() => readCapacityPolicy({ hostBudget: { mode: "enforce", typical: { gpu: 1 } } }), /unknown/);
  assert.throws(() => readCapacityPolicy({ hostBudget: { mode: "enforce", profiles: { preview: 4096 }, typical: { preview: 8192 } } }), /exceed/);
});

test("a landing takes room on real memory through the ledger once it has waited the take-room threshold", () => {
  const root = fixture();
  const store = openCapacityStore(join(root, "ledger.sqlite"));
  const GiB = 1024 ** 3;
  const sized: CapacityPolicy = {
    ...policy, reserveBytes: 8 * GiB, maxWaitMs: 30 * 60_000, takeRoomAfterMs: 5 * 60_000,
    profiles: { landing: 24 * GiB, release: 16 * GiB, image: 16 * GiB, agent: 16 * GiB, audit: 16 * GiB, preview: 12 * GiB },
    typical: { landing: 24 * GiB, release: 16 * GiB, image: 16 * GiB, agent: 16 * GiB, audit: 16 * GiB, preview: 12 * GiB },
  };
  // Three previews count 12 GiB each while holding 4: 24 GiB of growth room fills the gap between 41.7 GiB available
  // and the landing's 24 GiB need, exactly as on 18 Nov.
  const observeWith = (requests: readonly CapacityRequest[]) => ({ owners: Object.fromEntries(requests.map((item) => [item.id, "alive" as const])),
    reading: { totalBytes: 62.4 * GiB, availableBytes: 41.7 * GiB, memoryFullAvg10: 0,
      currentBytes: Object.fromEntries(requests.filter((item) => item.lane === "preview").map((item) => [item.id, 4 * GiB])),
      peakBytes: Object.fromEntries(requests.filter((item) => item.lane === "preview").map((item) => [item.id, 11.5 * GiB])) } });
  try {
    for (const id of ["a", "b", "c"]) assert.equal(store.poll({ ...request(id), lane: "preview", bytes: 12 * GiB }, sized, observeWith, 0).outcome, "admitted");
    const gate = { ...request("gate"), bytes: 24 * GiB, queuedAt: 60_000 };
    assert.equal(store.poll(gate, sized, observeWith, 60_000 + 5 * 60_000 - 1000).outcome, "waiting");
    const admitted = store.poll(gate, sized, observeWith, 60_000 + 5 * 60_000);
    assert.equal(admitted.outcome, "admitted");
    assert.match(admitted.decision.reason, /real memory holds it; others' growth room not reserved/);
    assert.deepEqual(store.waits(0).filter((wait) => wait.job === "gate"),
      [{ lane: "landing", job: "gate", queuedAt: 60_000, endedAt: 60_000 + 5 * 60_000, outcome: "admitted" }], "the ledger keeps the wait it ended");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
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
      assert.equal(store.finish(job.id, job.owner, () => true, { memoryPeakBytes: 20 * 1024 ** 3, memoryResidentBytes: (100 + index) * 1024 ** 2 }), true);
    }
    const holder = request("holder");
    store.poll(holder, sized, roomy(), 20);
    store.poll(request("watcher"), sized, roomy({ holder: 300 * 1024 ** 2 }), 21);
    store.recover((requests) => ({ ...roomy()(requests), owners: { holder: "gone", watcher: "alive" } }));
    for (let index = 0; index < 1100; index += 1) store.poll(request("watcher"), sized, roomy(), 30 + index);
    const learned = store.typical(sized);
    assert.deepEqual(learned.agent, { bytes: 108 * 1024 ** 2, source: "learned", samples: 10 }, "memory.peak, file cache included, sizes nothing");
    assert.deepEqual(learned.landing, { bytes: sized.typical.landing, source: "configured", samples: 1 }, "the holder's 300 MiB is one sample");
    // Jobs that measured nothing, such as Docker builds, never displace the measured peaks.
    for (let index = 0; index < 60; index += 1) {
      const job = { ...request(`empty-${index}`), lane: "agent" as const, bytes: 1024 ** 3 };
      store.poll(job, sized, roomy(), 1200 + index);
      store.finish(job.id, job.owner, () => true, { memoryResidentBytes: 1024 ** 2 });
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
    store.finish(gate.id, gate.owner, () => true, { memoryPeakBytes: 30 * GiB });
    const rows = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(rows.prepare("SELECT job, peak_bytes AS peak, growth, measure FROM peaks ORDER BY seq").all().map((row) => ({ ...row })), [
        { job: "before", peak: GiB, growth: null, measure: null },
        { job: "gate", peak: 5 * GiB, growth: JSON.stringify([[2000, GiB], [60_000, 5 * GiB]]), measure: "resident" },
      ], "a rise smaller than a step adds no note");
    } finally { rows.close(); }
    assert.equal(store.typical(sized).landing.samples, 1, "a memory.peak from before SJ-267 stays as history but sizes nothing");
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
    assert.deepEqual([noted!.externalBytes, noted!.residentPeakBytes], [1024 ** 3, 5 * 1024 ** 3], "the latest outside use, the highest peak");
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

test("a job admitted before SJ-267 drops its memory.peak and starts its peak again from unreclaimable memory", () => {
  const root = fixture();
  const path = join(root, "ledger.sqlite");
  const store = openCapacityStore(path);
  try {
    const GiB = 1024 ** 3;
    const preview = { ...request("preview"), lane: "preview" as const, admittedAt: 0 };
    const raw = new DatabaseSync(path);
    raw.prepare("INSERT INTO requests(id,body) VALUES (?,?)").run(preview.id, JSON.stringify({ ...preview, peakBytes: 9 * GiB, growth: [[1000, 9 * GiB]] }));
    raw.close();
    const [legacy] = store.requests();
    assert.equal("peakBytes" in legacy!, false);
    assert.equal(legacy!.growth, undefined);
    const seen = (current: number) => (requests: readonly CapacityRequest[]) => ({
      owners: Object.fromEntries(requests.map((item) => [item.id, "alive" as const])),
      reading: { totalBytes: 64 * GiB, availableBytes: 64 * GiB, memoryFullAvg10: 0, currentBytes: { preview: current }, peakBytes: { preview: current } } });
    assert.equal(store.sample(preview.id, seen(3 * GiB), 2000), true);
    assert.equal(store.sample(preview.id, seen(2 * GiB), 7000), true);
    assert.equal(store.requests()[0]!.residentPeakBytes, 3 * GiB, "a sample keeps only a new peak");
    assert.equal(store.finish(preview.id, preview.owner, () => true, { memoryPeakBytes: 9 * GiB, memoryResidentBytes: GiB }), true);
    assert.equal(store.sample(preview.id, seen(GiB)), false, "a sampler stops once its job has left the ledger");
    const rows = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(rows.prepare("SELECT peak_bytes AS peak, measure FROM peaks").all().map((row) => ({ ...row })), [{ peak: 3 * GiB, measure: "resident" }]);
    } finally { rows.close(); }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a sampler stops when its job's owner has ended", () => {
  const root = fixture();
  const store = openCapacityStore(join(root, "ledger.sqlite"));
  try {
    store.poll(request("gate"), policy, observe, 1);
    assert.equal(store.sample("gate", (requests) => ({ ...observe(requests), owners: { gate: "gone" } })), false);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a landing that cannot fit stops previews in the ledger, records why, and is admitted once their memory is back", () => {
  const root = fixture();
  const store = openCapacityStore(join(root, "ledger.sqlite"));
  // Two previews of 4 bytes each, a landing of 8: with 14 available less the 8 reserve, the landing needs both gone.
  const sizes: CapacityPolicy = { ...policy, maxWaitMs: 60_000, profiles: { ...policy.profiles, landing: 8 }, typical: { ...policy.typical, landing: 8 } };
  const preview = (id: string): CapacityRequest => ({ ...request(id, "preview"), cgroup: `/user.slice/user-1001.slice/user@1001.service/preview.slice/preview-gen-${id}.slice` });
  let available = 14;
  let emptied = new Set<string>();
  const host = (requests: readonly CapacityRequest[]) => ({
    owners: Object.fromEntries(requests.map((item) => [item.id, item.yieldedFor && emptied.has(item.id) ? "gone" as const : "alive" as const])),
    reading: { totalBytes: 64, availableBytes: available, memoryFullAvg10: 0,
      currentBytes: Object.fromEntries(requests.filter((item) => !emptied.has(item.id)).map((item) => [item.id, item.lane === "preview" ? 3 : 0])),
      peakBytes: Object.fromEntries(requests.filter((item) => !emptied.has(item.id)).map((item) => [item.id, item.lane === "preview" ? 3 : 0])) },
    giveWay: { isolated: 0, combined: 1 },
  });
  try {
    for (const id of ["combined", "isolated"]) assert.equal(store.poll(preview(id), sizes, host, 1).outcome, "admitted");
    const landing = { ...request("gate"), job: "Landing gate 564f6cc45168", queuedAt: 10 * 60_000 };
    available = 6;
    const first = store.poll(landing, sizes, host, 10 * 60_000);
    assert.equal(first.outcome, "waiting", "never admitted on memory not yet returned");
    assert.deepEqual(first.yields?.map(({ id }) => id).sort(), ["combined", "isolated"]);
    assert.match(first.decision.reason, /stopping .* to make room/);
    // Their claims count for nothing at once, so the stop is never repeated as a new plan.
    assert.equal(store.requests().filter((item) => item.yieldedFor?.landingId === "gate").length, 2);
    const yields = store.yields(0);
    assert.deepEqual(yields.map(({ requestId, landingJob, residentBytes }) => ({ requestId, landingJob, residentBytes })).sort((a, b) => a.requestId.localeCompare(b.requestId)), [
      { requestId: "combined", landingJob: "Landing gate 564f6cc45168", residentBytes: 3 },
      { requestId: "isolated", landingJob: "Landing gate 564f6cc45168", residentBytes: 3 },
    ]);
    // A stop that has not taken yet is handed back to the caller again on the next poll.
    const retry = store.poll(landing, sizes, host, 10 * 60_000 + 1000);
    assert.equal(retry.outcome, "waiting");
    assert.equal(retry.yields?.length, 2);
    // The groups empty and the memory comes back: the stopped previews leave the ledger and the landing is admitted.
    emptied = new Set(["combined", "isolated"]);
    available = 18;
    const admitted = store.poll(landing, sizes, host, 10 * 60_000 + 2000);
    assert.equal(admitted.outcome, "admitted", admitted.decision.reason);
    assert.equal(admitted.yields, undefined);
    assert.deepEqual(store.requests().map(({ id }) => id), ["gate"]);
    assert.equal(store.yields(0).length, 2, "the record outlives the requests");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a preview declares how readily it gives way beside its holder, and a stopped one is told which landing stopped it", () => {
  const root = fixture();
  try {
    const holder = join(root, "preview.owner");
    writeFileSync(holder, "preview");
    const preview: CapacityRequest = { ...request("preview", "preview"), owner: { kind: "holder", path: holder, identity: "preview" },
      cgroup: "/user.slice/user-1001.slice/user@1001.service/preview.slice/preview-gen.slice/preview-gen-preview.slice" };
    assert.equal(readCapacityObservation([preview]).giveWay?.preview, undefined, "undeclared");
    writeFileSync(`${holder}.give-way`, "0\n");
    assert.equal(readCapacityObservation([preview]).giveWay?.preview, 0);
    writeFileSync(`${holder}.give-way`, "high");
    assert.equal(readCapacityObservation([preview]).giveWay?.preview, undefined, "anything but one digit declares nothing");
    // Its holder stays for its own controller's cleanup, so it leaves the ledger by its group alone.
    const yieldedFor = { landingId: "gate", landingJob: "Landing gate 564f6cc45168", at: 1_795_043_000_000, residentBytes: 3 };
    assert.equal(capacityOwnerState(preview), "alive", "an unyielded preview follows its holder");
    assert.equal(capacityOwnerState({ ...preview, yieldedFor }), "gone");
    const stops: string[] = [];
    stopYieldedPreview({ ...preview, yieldedFor }, (unit) => stops.push(unit));
    assert.deepEqual(stops, ["preview-gen-preview.slice"]);
    assert.deepEqual(JSON.parse(readFileSync(`${holder}.yielded`, "utf8")), { requestId: "preview", ...yieldedFor });
    // Only a unit of this user's manager, and only a preview a landing chose.
    stopYieldedPreview({ ...preview, yieldedFor, cgroup: "/system.slice/ssh.service" }, (unit) => stops.push(unit));
    stopYieldedPreview(preview, (unit) => stops.push(unit));
    assert.deepEqual(stops, ["preview-gen-preview.slice"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
