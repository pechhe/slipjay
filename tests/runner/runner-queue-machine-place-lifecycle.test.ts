import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { admitMachineCapacity } from "../../src/lib/runner/host-capacity-remote.ts";
import { machineVerification } from "../../src/lib/runner/machine-verifier.ts";
import { fixture, test, until } from "./fixtures/queue-verifier-fixture.ts";
import { gate, options, placements, places } from "./fixtures/machine-place-fixture.ts";

test("failed repair of the real machine verifier's corrupt checkout falls back to boat as infrastructure", async () => {
  const p = places();
  const machine = machineVerification("peach-box", { ssh: "fixture", account: "ubuntu", root: "/unused-gates" }, { run: async (request) => {
    const response = (stdout = "", exitCode = 0, stderr = "") => ({ stdout, exitCode, stderr, stdoutTruncated: false, stderrTruncated: false,
      finishedAt: new Date().toISOString(), signal: null, timedOut: false, cancelled: false, outputSha256: "" });
    if (request.executable === "git") return request.args[0] === "bundle" ? response("", 128, "Refusing to create empty bundle.") : response();
    const script = request.args.at(-1)!;
    if (script.includes('echo "$HOME"')) return response("/home/ubuntu");
    if (script.includes("# SlipJay host capacity policy")) return response('{"configured":false}');
    if (script.includes("slipjay-receive-")) return response("", 1, "corrupt checkout: fetch failed");
    if (script.includes("slipjay-reinitialise-")) return response("", 1, "checkout reinitialisation failed");
    assert.ok(!script.includes("slipjay-command-"), "the failed setup never starts gate commands");
    return response();
  } });
  await machine.recover!([]);
  const f = await fixture(false, false, undefined, false, { ...options(p), machineVerifications: { "peach-box": machine } });
  try {
    const result = await f.land(f.submit(await f.candidate("repair")));
    assert.equal(result?.type, "landed", JSON.stringify(result));
    assert.deepEqual(placements(f), ["boat"]);
    assert.ok(f.log.events().some(({ event }) => event.type === "remote_verification" && event.phase === "failed" && event.infrastructure && /checkout reinitialisation failed/.test(event.reason)));
  } finally { await f.dispose(); }
});

test("a gate queued for the place stops when its landing is cancelled, opening nothing", async () => {
  const p = places();
  const f = await fixture(false, false, undefined, false, { ...options(p), gates: (root) => [gate(root)] });
  try {
    await writeFile(join(f.root, "hold"), "");
    const a = f.submit(await f.candidate("a"));
    f.queue.wake();
    await until(() => placements(f, a).length === 1 || undefined);
    const b = f.submit(await f.candidate("b"));
    f.queue.wake();
    await until(() => f.log.events({ operationId: b }).some(({ event }) => event.type === "progress" && /queued for one/.test(event.line)) || undefined);
    f.log.append(b, { type: "cancelled", reason: "cancelled by the author" });
    await until(() => f.result(b) || undefined);
    assert.equal(f.result(b)?.type, "cancelled");
    assert.deepEqual(placements(f, b), []);
    await rm(join(f.root, "hold"));
    await until(() => f.result(a) || undefined);
    assert.equal(f.result(a)?.type, "landed");
  } finally { await rm(join(f.root, "hold"), { force: true }); await f.dispose(); }
});

test("a machine with two places runs two gates side by side and queues a third for the first place freed", async () => {
  const first = places(), second = places();
  const f = await fixture(false, false, undefined, false, { ...options(first), machineVerifications: { "peach-box": [first.machine, second.machine] }, gates: (root) => [gate(root)] });
  try {
    await writeFile(join(f.root, "hold"), "");
    const a = f.submit(await f.candidate("a"));
    const b = f.submit(await f.candidate("b"));
    const c = f.submit(await f.candidate("c"));
    f.queue.wake();
    await until(() => placements(f, a).length === 1 && placements(f, b).length === 1 || undefined);
    assert.deepEqual([first.opens(), second.opens()], [1, 1], "each place took one gate, at the same time");
    await until(() => f.log.events({ operationId: c }).some(({ event }) => event.type === "progress" && /every peach-box gate place is busy; queued for one/.test(event.line)) || undefined);
    assert.deepEqual(placements(f, c), [], "the third gate opens nothing while both places are held");
    await rm(join(f.root, "hold"));
    await until(() => f.result(a) && f.result(b) && f.result(c) || undefined);
    for (const id of [a, b, c]) assert.equal(f.result(id)?.type, "landed");
    assert.equal(first.opens() + second.opens(), 3);
    assert.ok(!f.log.events().some(({ event }) => event.type === "gate_fallback"), "busy places are queued for, never boat");
    assert.ok(f.log.events({ operationId: c }).some(({ event }) => event.type === "gate_waited"));
  } finally { await rm(join(f.root, "hold"), { force: true }); await f.dispose(); }
});

test("a place that goes down while gates queue for it sends each to boat once, loudly, never passing it between them", async () => {
  const p = places();
  const f = await fixture(false, false, undefined, false, { ...options(p), gates: (root) => [gate(root)] });
  try {
    await writeFile(join(f.root, "hold"), "");
    const a = f.submit(await f.candidate("a"));
    f.queue.wake();
    await until(() => placements(f, a).length === 1 || undefined);
    const b = f.submit(await f.candidate("b"));
    const c = f.submit(await f.candidate("c"));
    f.queue.wake();
    const queued = (id: string) => f.log.events({ operationId: id }).some(({ event }) => event.type === "progress" && /queued for one/.test(event.line));
    await until(() => queued(b) && queued(c) || undefined);
    // The place goes down while a still holds it: its release hands a down place to b.
    p.quarantine(true);
    await rm(join(f.root, "hold"));
    await until(() => f.result(a) && f.result(b) && f.result(c) || undefined);
    for (const id of [a, b, c]) assert.equal(f.result(id)?.type, "landed");
    assert.deepEqual([placements(f, b), placements(f, c)], [["boat"], ["boat"]]);
    for (const id of [b, c]) assert.equal(f.log.events({ operationId: id }).filter(({ event }) => event.type === "gate_fallback").length, 1);
  } finally { await rm(join(f.root, "hold"), { force: true }); await f.dispose(); }
});

test("a machine-place landing slot keeps only slipjay.json, and widens to every file to generate a migration", async () => {
  const p = places();
  const f = await fixture(true, false, undefined, false, { ...options(p), screeningLanes: 1 });
  try {
    const sparse = (id: string) => {
      const started = f.log.events({ operationId: id }).flatMap(({ event }) => event.type === "attempt_started" ? [event.checkout] : []).at(-1)!;
      return execFileSync("jj", ["--ignore-working-copy", "sparse", "list"], { cwd: started, encoding: "utf8" }).trim();
    };
    const plain = f.submit(await f.candidate("plain.txt"));
    assert.equal((await f.land(plain))?.type, "landed");
    assert.equal(sparse(plain), "slipjay.json", "a landing that generates nothing switches only slipjay.json");
    const schema = f.submit(await f.candidate("schema/a.ts"));
    assert.equal((await f.land(schema))?.type, "landed", "the migration still generates in the runner's checkout");
    assert.equal(sparse(schema), ".", "generation widened the slot to every file");
    const next = f.submit(await f.candidate("next.txt"));
    assert.equal((await f.land(next))?.type, "landed");
    assert.equal(sparse(next), "slipjay.json", "the next plain landing narrows it again");
  } finally { await f.dispose(); }
});

test("configured capacity acquisition failures never invoke the Boat verifier or mark the machine down", async () => {
  let failure: "cgroup" | "ledger" | "decode" = "cgroup";
  const p = places();
  let boatOpens = 0;
  p.boat.open = async () => { boatOpens++; throw new Error("Boat must never open for a capacity failure"); };
  p.machine.open = async (input) => {
    await admitMachineCapacity({ id: "a".repeat(32), job: "fixture gate", lane: "landing", owner: { kind: "holder", path: "/fixture/holder/id", identity: "a".repeat(32) },
      slice: "slipjay-attempt-fixture.slice", signal: input.signal, policy: { configured: true }, control: async (script) => {
        if (script.startsWith("systemctl")) return failure === "cgroup" ? "" : "/fixture/cgroup";
        if (failure === "ledger") throw new Error("ledger unavailable");
        return "invalid-json";
      } });
    throw new Error("failed admission cannot open an attempt");
  };
  const f = await fixture(false, false, undefined, false, { ...options(p), gates: (root) => [gate(root)] });
  try {
    for (const mode of ["cgroup", "ledger", "decode"] as const) {
      failure = mode;
      const id = f.submit(await f.candidate(`capacity-${mode}`));
      const result = await f.land(id);
      assert.notEqual(result?.type, "landed");
      assert.equal(boatOpens, 0);
      assert.ok(!f.log.events().some(({ event }) => event.type === "gate_fallback"));
      assert.ok(!f.log.events().some(({ event }) => event.type === "machine_place" && event.state === "down"));
    }
  } finally { await f.dispose(); }
});
