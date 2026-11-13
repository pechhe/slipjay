import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";
import { admitMachineCapacity } from "../../src/lib/runner/host-capacity-remote.ts";
import { machineVerification } from "../../src/lib/runner/machine-verifier.ts";
import { runnerConfigProblem } from "../../src/lib/runner/runner-contract.ts";
import { pipelineMetrics } from "../../src/lib/runner/pipeline-metrics.ts";
import type { GatePlacement, MachineVerification, RemoteAttempt, RemoteVerification, RunnerConfig } from "../../src/lib/runner/runner-types.ts";
import { fixture, test, until } from "./fixtures/runner-queue-fixture.ts";

function places() {
  let occupied = false;
  let quarantined = false;
  let max = 0;
  let opens = 0;
  let setupFailure = "";
  let boatFailure = false;
  let closeFailure = false;
  // Like a real place, a remote attempt works in its own copy of exactly the candidate, never in the runner's checkout
  // (which is narrowed for a machine-place repository, SJ-200).
  const attempt = async (machine: boolean, input: Parameters<RemoteVerification["open"]>[0]): Promise<RemoteAttempt> => {
    const copy = await mkdtemp(join(tmpdir(), "remote-place-"));
    const gitDirectory = execFileSync("jj", ["--ignore-working-copy", "git", "root"], { cwd: input.checkout, encoding: "utf8" }).trim();
    execFileSync("sh", ["-c", `git --git-dir "$1" archive "$2" | tar -x -C "$3"`, "sh", gitDirectory, input.candidate, copy]);
    const inCopy = (cwd: string) => cwd.startsWith(input.checkout) ? copy + cwd.slice(input.checkout.length) : cwd;
    return {
      machine: machine ? { verifier: "machine", name: "peach-box", id: "peach-box", size: "machine", image: "fixed SSH machine" }
        : { verifier: "boat", name: "slot", id: "boat", size: "large", image: "image" },
      executor: { host: machine ? "machine:peach-box" : "boat:slot", run: (request) => runBoundedProcess({ ...request, cwd: inCopy(request.cwd) }) },
      tree: "tree", usage: null,
      async finish() { const mutated = await readFile(join(copy, "mutate"), "utf8").then((value) => value === "changed by machine gate", () => false); return { tree: mutated ? null : "tree", trackedChanges: mutated ? 1 : 0, usage: null }; },
      async close() { await rm(copy, { recursive: true, force: true }); if (machine) { occupied = false; if (closeFailure) throw new Error("Remote executor unavailable (machine peach-box): cleanup unconfirmed"); } },
    };
  };
  const machine: MachineVerification = {
    available: () => !occupied && !quarantined,
    reason: () => quarantined ? "quarantined: earlier work alive" : "machine place busy",
    async recover() {},
    async open(input) {
      opens++;
      if (setupFailure) throw Object.assign(new Error(setupFailure), { remote: { machine: { verifier: "machine", name: "peach-box", id: "peach-box", size: "machine", image: "fixed SSH machine" }, usageBefore: null, usage: null } });
      assert.equal(occupied, false, "never share a machine, screening included"); occupied = true; max = Math.max(max, Number(occupied));
      return attempt(true, input);
    },
  };
  const boat: RemoteVerification = { async probe() { if (boatFailure) throw new Error("boat unavailable"); }, async open(input) {
    if (boatFailure) throw Object.assign(new Error("Remote executor unavailable (boat): API unreachable"), { boatUnavailable: true });
    return attempt(false, input);
  } };
  return { machine, boat, max: () => max, opens: () => opens, quarantine: (value: boolean) => { quarantined = value; }, fail: (reason: string) => { setupFailure = reason; }, holdBoat: () => { boatFailure = true; }, failClose: (value: boolean) => { closeFailure = value; } };
}
const gate = (root: string) => `const fs=require('node:fs');while(fs.existsSync(${JSON.stringify(join(root, "hold"))}) && !fs.existsSync("unheld")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);if(fs.existsSync("mutate"))fs.writeFileSync("mutate","changed by machine gate");`;
const placements = (f: Awaited<ReturnType<typeof fixture>>, id?: string): GatePlacement[] => f.log.events(id ? { operationId: id } : {}).flatMap(({ event }) => event.type === "remote_verification" && event.phase === "ready" ? [event.placement!] : []);
const options = (p: ReturnType<typeof places>) => ({ screeningLanes: 3, workers: 2, gateMachine: "peach-box", machineVerifications: { "peach-box": p.machine }, remoteVerification: p.boat });

test("machine screens exclude one another, queue for the place rather than use boat, and release the runner worker while waiting", async () => {
  const p = places();
  const f = await fixture(false, false, undefined, false, { ...options(p), workers: 1, other: true, gates: (root) => [gate(root)] });
  try {
    await writeFile(join(f.root, "hold"), "");
    const a = f.submit(await f.candidate("a"));
    f.queue.wake();
    await until(() => placements(f, a).length === 1 || undefined);
    const b = f.submit(await f.candidate("b"));
    const c = f.submit(await f.candidate("c"));
    f.queue.wake();
    const queued = (id: string) => f.log.events({ operationId: id }).some(({ event }) => event.type === "progress" && /busy; queued for one/.test(event.line));
    await until(() => queued(b) && queued(c) || undefined);
    const other = f.submit(await f.candidate("unheld", f.otherAuthor, "fixture/other"));
    f.queue.wake();
    await until(() => f.result(other) || undefined);
    assert.equal(f.result(other)?.type, "landed", "queued screens hold no runner worker");
    assert.deepEqual([placements(f, b), placements(f, c)], [[], []], "a queued gate opens nothing, boat included");
    await rm(join(f.root, "hold"));
    await until(() => f.result(a) && f.result(b) && f.result(c) || undefined);
    for (const id of [a, b, c]) assert.equal(f.result(id)?.type, "landed");
    assert.deepEqual(placements(f).sort(), ["machine:peach-box", "machine:peach-box", "machine:peach-box"]);
    assert.equal(p.max(), 1);
    assert.ok(!f.log.events().some(({ event }) => event.type === "gate_fallback"), "busy is never a reason for boat");
    for (const id of [b, c]) assert.ok(f.log.events({ operationId: id }).some(({ event }) => event.type === "gate_waited"));
    const hosts = f.log.events().flatMap(({ event }) => event.type === "run_started" && event.purpose === "gate" ? [event.host] : []);
    assert.ok(hosts.includes("machine:peach-box")); assert.ok(!hosts.includes("boat:slot"));
    const metrics = pipelineMetrics(f.log.events(), "1970-01-01").groups.find((group) => group.repo === "fixture/repo")!.remote!;
    assert.equal(metrics.placements["machine:peach-box"]?.gate?.samples, 3);
  } finally { await rm(join(f.root, "hold"), { force: true }); await f.dispose(); }
});

test("a machine gate starts at once however loaded the machine is, says so for background work, and a gate on boat touches no host", async () => {
  const p = places();
  const reads: (string | null)[] = [];
  const stamps: (string | null)[] = [];
  const hostShell = (machine: string | null) => async (script: string) => {
    if (script.includes("flock")) { stamps.push(machine); return "claimed\n"; }
    reads.push(machine);
    return "99 99 1.00 1/100 200\n32\n";
  };
  const f = await fixture(false, false, undefined, false, { ...options(p), hostShell, gates: (root) => [gate(root)] });
  try {
    const a = f.submit(await f.candidate("a"));
    assert.equal((await f.land(a))?.type, "landed");
    assert.deepEqual(reads, [], "the gate does not read the machine's load");
    assert.ok(stamps.includes("peach-box"), "background work on that machine leaves room after the gate");
    const events = f.log.events({ operationId: a }).map(({ event }) => event);
    assert.ok(!events.some((event) => event.type === "host_budget_waited"));
    assert.ok(!events.some((event) => event.type === "stage" && event.stage === "waiting-for-budget"));
    stamps.length = 0;
    p.fail("SSH unreachable");
    assert.equal((await f.land(f.submit(await f.candidate("b"))))?.type, "landed");
    assert.deepEqual(placements(f), ["machine:peach-box", "boat"]);
    assert.deepEqual([reads, stamps], [[], []], "a boat VM is its own host");
  } finally { await f.dispose(); }
});

test("machine setup infrastructure falls back to boat, and a machine gate changing candidate files fails", async () => {
  const p = places();
  const f = await fixture(false, false, undefined, false, { ...options(p), gates: (root) => [gate(root)] });
  try {
    p.fail("SSH unreachable");
    const a = await f.land(f.submit(await f.candidate("a")));
    assert.equal(a?.type, "landed", JSON.stringify(a));
    assert.deepEqual(placements(f), ["boat"]);
    assert.ok(f.log.events().some(({ event }) => event.type === "remote_verification" && event.phase === "failed" && event.infrastructure));
    p.fail("frozen install failed before gate commands");
    assert.equal((await f.land(f.submit(await f.candidate("setup"))))?.type, "landed");
    assert.deepEqual(placements(f), ["boat", "boat"]);
    assert.ok(f.log.events().filter(({ event }) => event.type === "run_started" && event.purpose === "gate").every(({ event }) => event.type === "run_started" && event.host === "boat:slot"));
    p.fail("");
    const b = await f.land(f.submit(await f.candidate("mutate")));
    assert.equal(b?.type, "failed", JSON.stringify(b));
    assert.match(b?.type === "failed" ? b.reason : "", /changed 1 file.*machine:peach-box/);
  } finally { await f.dispose(); }
});

test("unconfirmed machine cleanup neither fails a green gate nor hides a gate that changed the candidate", async () => {
  const p = places();
  const f = await fixture(false, false, undefined, false, { ...options(p), gates: (root) => [gate(root)] });
  try {
    p.failClose(true);
    const green = await f.land(f.submit(await f.candidate("a")));
    assert.equal(green?.type, "landed", JSON.stringify(green));
    const drifted = await f.land(f.submit(await f.candidate("mutate")));
    assert.equal(drifted?.type, "failed", JSON.stringify(drifted));
    assert.match(drifted?.type === "failed" ? drifted.reason : "", /changed 1 file.*machine:peach-box/);
  } finally { await f.dispose(); }
});

test("quarantined places use boat until recovery proves clean, then take gates while boat is held", async () => {
  const p = places(); p.quarantine(true);
  const f = await fixture(false, false, undefined, false, { ...options(p), boatProbeMs: 5 });
  try {
    const a = await f.land(f.submit(await f.candidate("a")));
    assert.equal(a?.type, "landed"); assert.deepEqual(placements(f), ["boat"]);
    // Boat for a down place is never quiet: the landing warns, and the runner records the outage once.
    assert.ok(f.log.events().some(({ event }) => event.type === "progress" && /^warning: peach-box's gate place is down \(quarantined: earlier work alive\); this gate runs on a boat VM instead$/.test(event.line)));
    const outages = () => f.log.events().flatMap(({ event }) => event.type === "machine_place" ? [`${event.name} ${event.state}`] : []);
    assert.deepEqual(outages(), ["peach-box down"]);
    // A failed attempt to open boat holds it. The next gate can still use a recovered machine.
    p.holdBoat();
    const b = f.submit(await f.candidate("b")); f.queue.wake();
    await until(() => f.log.events().some(({ event }) => event.type === "boat_circuit" && event.state === "open") || undefined);
    p.quarantine(false); f.queue.wake();
    await until(() => f.result(b) || undefined);
    assert.equal(f.result(b)?.type, "landed", JSON.stringify(f.result(b)));
    assert.deepEqual(placements(f, b), ["machine:peach-box"]);
    assert.deepEqual(outages(), ["peach-box down", "peach-box up"]);
  } finally { await f.dispose(); }
});

test("machine configuration rejects unknown, host-combined and verifier-less places at load", () => {
  const config: RunnerConfig = { jj: { "user.name": "Runner", "user.email": "runner@example.com" }, boat: { image: "image" }, machines: { "peach-box": { ssh: "peach-box", account: "ubuntu", root: "/var/lib/slipjay-gates" } }, repos: { repo: { url: "url", verifier: "boat", gateMachine: "peach-box" } } };
  assert.equal(runnerConfigProblem(config), null);
  config.repos.repo!.gateMachine = "missing";
  assert.match(runnerConfigProblem(config)!, /unknown machine/);
  config.repos.repo!.gateMachine = "peach-box"; config.repos.repo!.hostPlaces = 1;
  assert.match(runnerConfigProblem(config)!, /cannot be combined/);
  delete config.repos.repo!.hostPlaces; delete config.repos.repo!.verifier;
  assert.match(runnerConfigProblem(config)!, /needs a "verifier"/);
});


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
  for (const failure of ["cgroup", "ledger", "decode"]) {
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
      const id = f.submit(await f.candidate(`capacity-${failure}`));
      const result = await f.land(id);
      assert.notEqual(result?.type, "landed");
      assert.equal(boatOpens, 0);
      assert.ok(!f.log.events().some(({ event }) => event.type === "gate_fallback"));
      assert.ok(!f.log.events().some(({ event }) => event.type === "machine_place" && event.state === "down"));
    } finally { await f.dispose(); }
  }
});
