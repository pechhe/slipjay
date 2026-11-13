import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "vite-plus/test";
import { openCapacityStore } from "../../src/lib/runner/host-capacity-store.ts";
import { capacityOwnerState, currentCapacityOwner, processStart, readCapacityPolicy } from "../../src/lib/runner/host-capacity-local.ts";
import type { CapacityPolicy, CapacityRequest } from "../../src/lib/runner/host-capacity.ts";

const policy: CapacityPolicy = {
  mode: "enforce", budgetBytes: 12, reserveBytes: 8, agingMs: 10, maxWaitMs: 1000, maxMemoryFullAvg10: 5,
  profiles: { landing: 4, release: 4, image: 4, agent: 4, audit: 4, preview: 4 },
};
const request = (id: string): CapacityRequest => ({ id, job: id, lane: "landing", bytes: 4, queuedAt: 0, admittedAt: null, cgroup: "/missing-fixture", owner: { kind: "holder", path: `/fixture/${id}`, identity: id } });
const observe = (requests: readonly CapacityRequest[]) => ({
  owners: Object.fromEntries(requests.map((item) => [item.id, "alive" as const])),
  reading: { totalBytes: 64, availableBytes: 64, memoryFullAvg10: 0, currentBytes: {} },
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
    const shadow = store.poll(request("two"), { ...policy, mode: "shadow", budgetBytes: 4 }, observe, 2);
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
    const receipt=store.poll(request, policy, requests=>({owners:Object.fromEntries(requests.map(r=>[r.id,'alive'])),reading:{totalBytes:64,availableBytes:64,memoryFullAvg10:0,currentBytes:{}}}),1);
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
