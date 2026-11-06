import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";
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
  const attempt = (machine: boolean, input: Parameters<RemoteVerification["open"]>[0]): RemoteAttempt => ({
    machine: machine ? { verifier: "machine", name: "peach-box", id: "peach-box", size: "machine", image: "fixed SSH machine" }
      : { verifier: "boat", name: "slot", id: "boat", size: "large", image: "image" },
    executor: { host: machine ? "machine:peach-box" : "boat:slot", run: runBoundedProcess },
    tree: "tree", usage: null,
    async finish() { const mutated = await readFile(join(input.checkout, "mutate"), "utf8").then((value) => value === "changed by machine gate", () => false); return { tree: mutated ? null : "tree", trackedChanges: mutated ? 1 : 0, usage: null }; },
    async close() { if (machine) { occupied = false; if (closeFailure) throw new Error("Remote executor unavailable (machine peach-box): cleanup unconfirmed"); } },
  });
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

test("machine screens exclude one another, release the runner worker, and expose host and timing evidence", async () => {
  const p = places();
  const f = await fixture(false, false, undefined, false, { ...options(p), workers: 1, other: true, gates: (root) => [gate(root)] });
  try {
    await writeFile(join(f.root, "hold"), "");
    const a = f.submit(await f.candidate("a"));
    const b = f.submit(await f.candidate("b"));
    f.queue.wake();
    await until(() => placements(f).length === 2 || undefined);
    assert.deepEqual(placements(f).sort(), ["boat", "machine:peach-box"]);
    assert.equal(p.max(), 1);
    assert.equal(p.opens(), 1);
    const other = f.submit(await f.candidate("unheld", f.otherAuthor, "fixture/other"));
    f.queue.wake();
    await until(() => f.result(other) || undefined);
    assert.equal(f.result(other)?.type, "landed", "the remote screen returned its runner worker");
    await rm(join(f.root, "hold"));
    await until(() => f.result(a) && f.result(b) || undefined);
    assert.equal(f.result(a)?.type, "landed"); assert.equal(f.result(b)?.type, "landed");
    const hosts = f.log.events().flatMap(({ event }) => event.type === "run_started" && event.purpose === "gate" ? [event.host] : []);
    assert.ok(hosts.includes("machine:peach-box")); assert.ok(hosts.includes("boat:slot"));
    const metrics = pipelineMetrics(f.log.events(), "1970-01-01").groups.find((group) => group.repo === "fixture/repo")!.remote!;
    assert.equal(metrics.placements["machine:peach-box"]?.gate?.samples, 1);
    assert.ok(Object.keys(metrics.fallbacks ?? {}).some((key) => key.includes("busy")));
  } finally { await rm(join(f.root, "hold"), { force: true }); await f.dispose(); }
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
    // A failed attempt to open boat holds it. The next gate can still use a recovered machine.
    p.holdBoat();
    const b = f.submit(await f.candidate("b")); f.queue.wake();
    await until(() => f.log.events().some(({ event }) => event.type === "boat_circuit" && event.state === "open") || undefined);
    p.quarantine(false); f.queue.wake();
    await until(() => f.result(b) || undefined);
    assert.equal(f.result(b)?.type, "landed", JSON.stringify(f.result(b)));
    assert.deepEqual(placements(f, b), ["machine:peach-box"]);
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
