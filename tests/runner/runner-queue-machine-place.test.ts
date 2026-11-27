import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runnerConfigProblem } from "../../src/lib/runner/runner-config.ts";
import { pipelineMetrics } from "../../src/lib/runner/pipeline-metrics.ts";
import type { RunnerConfig } from "../../src/lib/runner/runner-types.ts";
import { fixture, test, until } from "./fixtures/queue-verifier-fixture.ts";
import { gate, options, placements, places } from "./fixtures/machine-place-fixture.ts";

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

test("boat's starting image is a saved snapshot's name, never a sandbox boat deletes 14 days after it stops", () => {
  const config: RunnerConfig = { jj: { "user.name": "Runner", "user.email": "runner@example.com" }, boat: { image: "slipjay-gate-image", size: "large" }, repos: { repo: { url: "url", verifier: "boat" } } };
  assert.equal(runnerConfigProblem(config), null);
  config.boat!.image = "bx_ktc7fqjb";
  assert.match(runnerConfigProblem(config)!, /names the sandbox bx_ktc7fqjb, which boat deletes 14 days after it stops; save it with "boat snapshot bx_ktc7fqjb <name>"/);
  config.boat!.image = " ";
  assert.match(runnerConfigProblem(config)!, /names no saved snapshot/);
});
