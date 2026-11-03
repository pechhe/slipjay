import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";
import { newOperationId, openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { pipelineMetrics } from "../../src/lib/runner/pipeline-metrics.ts";
import { RUNNER_CONTROL_ID, runnerConfigProblem } from "../../src/lib/runner/runner-contract.ts";
import type { GatePlacement, RemoteAttempt, RemoteVerification, RunnerConfig } from "../../src/lib/runner/runner-types.ts";
import { fixture, jj, test, until } from "./fixtures/runner-queue-fixture.ts";

/**
 * SJ-189: a remote-verifying repository with `hostPlaces: 1` gates in the runner host's one gate place when it is free
 * as its commands are about to run, and on its boat VM otherwise.
 */

/**
 * The gate: it holds while `<root>/hold-gates` exists, unless the candidate carries `unheld`; a candidate carrying `mutate` changes a tracked file; one
 * carrying `linger` leaves a detached process in the checkout and records its pid in `<root>/linger.pid`.
 */
const holdingGate = (root: string) => `const fs=require("node:fs"),path=require("node:path"),at=(name)=>path.join(${JSON.stringify(root)},name);
while (fs.existsSync(at("hold-gates")) && !fs.existsSync("unheld")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
if (fs.existsSync("mutate")) fs.writeFileSync("mutate", "changed by the gate\\n");
if (fs.existsSync("linger")) { const child=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore",cwd:process.cwd()}); child.unref(); fs.writeFileSync(at("linger.pid"), String(child.pid)); }`;

/** A boat verifier whose "VM" runs the gate on this host in the runner checkout, failing to open while `refuse` says so. */
function fakeBoat(refuse: (input: Parameters<RemoteVerification["open"]>[0]) => Promise<Error | undefined> = async () => undefined) {
  const opened: { screening?: boolean; retrying?: boolean }[] = [];
  let opens = 0;
  /** Each VM's billed seconds so far: every attempt on it bills 60 s. */
  const billed = new Map<string, number>();
  const remote: RemoteVerification = {
    async open(input): Promise<RemoteAttempt> {
      opens++;
      const refusal = await refuse(input);
      if (refusal) throw refusal;
      opened.push({ screening: input.screening, retrying: input.retrying });
      const name = `slipjay-fixture-repo-${input.slot}${input.screening ? "-screen" : ""}`;
      return {
        executor: { host: `boat:${name}`, run: runBoundedProcess },
        machine: { verifier: "boat", id: `bx_${name}`, name, size: "large", image: "bx_image" },
        tree: "t".repeat(40), usage: { seconds: billed.get(name) ?? 0, dollars: 0 },
        finish: async () => {
          billed.set(name, (billed.get(name) ?? 0) + 60);
          return { tree: "t".repeat(40), trackedChanges: 0, usage: { seconds: billed.get(name)!, dollars: 0 } };
        },
        close: async () => {},
      };
    },
  };
  return { remote, opened, opens: () => opens };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const placements = (f: Fixture, id?: string): GatePlacement[] => f.log.events(id ? { operationId: id } : {})
  .flatMap(({ event }) => event.type === "remote_verification" && event.phase === "ready" ? [event.placement ?? "boat"] : []);
/** How many gates hold the host place now: a host `ready` with no `finished` after it, per operation. */
const hostGatesNow = (f: Fixture) => {
  const open = new Set<string>();
  for (const { operationId, event } of f.log.events()) {
    if (event.type !== "remote_verification") continue;
    if (event.phase === "ready" && event.placement === "host") open.add(operationId);
    else if (event.machine.verifier === "host") open.delete(operationId);
  }
  return open.size;
};
const hold = (f: Fixture) => writeFile(join(f.root, "hold-gates"), "");
const release = (f: Fixture) => rm(join(f.root, "hold-gates"), { force: true });
async function terminal(f: Fixture, ...ids: string[]) {
  f.queue.wake();
  return Promise.all(ids.map((id) => until(() => f.result(id) || undefined)));
}

test("two concurrent landings gate one in the host place and one on boat, beside a deploy and an audit", async () => {
  const boat = fakeBoat();
  const f = await fixture(false, false, { minIntervalMs: 0 }, false, { screeningLanes: 3, workers: 2, hostPlaces: 1, remoteVerification: boat.remote, gates: (root) => [holdingGate(root)], failingAudit: true });
  try {
    await hold(f);
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(() => placements(f).length === 2 || undefined);
    assert.deepEqual(placements(f).sort(), ["boat", "host"], "the second gate found the host place busy and went to boat");
    assert.equal(hostGatesNow(f), 1);
    const host = [a, b].find((id) => placements(f, id)[0] === "host")!;
    const ready = f.log.events({ operationId: host }).find(({ event }) => event.type === "remote_verification" && event.phase === "ready")!.event;
    assert.equal(ready.type === "remote_verification" && ready.machine.name, f.executor.host, "a host attempt names the runner host");

    // A deploy and an audit run while both gates hold: neither takes the host place nor waits for it.
    const deploy = newOperationId();
    f.log.append(deploy, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "staging", commitId: f.main(), submittedBy: "test" });
    const audit = newOperationId();
    f.log.append(audit, { type: "submitted", kind: "audit", repo: "fixture/repo", commitId: "", slot: new Date().toISOString(), submittedBy: "test" });
    f.queue.wake();
    await until(() => f.result(deploy) && f.result(audit) || undefined);
    assert.equal(hostGatesNow(f), 1, "the host place still holds one gate");
    assert.ok(!f.result(a) && !f.result(b), "both gates were still running");

    // A third landing's gate, while the host place is busy, also goes to boat: never two in the host place.
    const c = f.submit(await f.candidate("c.txt"));
    f.queue.wake();
    await until(() => placements(f, c).length || undefined);
    assert.deepEqual(placements(f, c), ["boat"]);
    assert.equal(hostGatesNow(f), 1);

    await release(f);
    const results = await terminal(f, a, b, c);
    assert.deepEqual(results.map((result) => result?.type), ["landed", "landed", "landed"], JSON.stringify(results));
    const runs = f.log.events({ operationId: host }).flatMap(({ event }) => event.type === "run_started" && event.purpose === "gate" ? [event.host] : []);
    assert.deepEqual(runs, [f.executor.host], "the host-placed gate ran on the runner host");

    const remote = pipelineMetrics(f.log.events(), "1970-01-01T00:00:00.000Z", { repo: "fixture/repo" }).groups.find((group) => group.kind === "landing")?.remote;
    assert.ok(remote, "metrics report the gate attempts");
    assert.equal(remote.placements.host?.attempts, 1);
    assert.equal(remote.placements.boat?.attempts, 2);
    assert.equal(remote.placements.host?.gate?.samples, 1, "each placement reports its gate time");
    assert.equal(remote.placements.boat?.setup?.samples, 2);
    const boatFinished = f.log.events().filter(({ event }) => event.type === "remote_verification" && event.phase === "finished" && event.machine.verifier === "boat").length;
    assert.ok(boatFinished >= 2);
    assert.equal(remote.boatVmSeconds, 60 * boatFinished, "the boat VM seconds billed across the window; the host attempt bills none");
  } finally { await release(f); await f.dispose(); }
}, 240_000);

test("a host-placed screen keeps its worker while its gate runs; a boat-placed one hands it back", async () => {
  for (const hostPlaces of [1, 0] as const) {
    const boat = fakeBoat();
    const f = await fixture(false, false, undefined, false, { screeningLanes: 3, workers: 1, hostPlaces, other: true, remoteVerification: boat.remote, gates: (root) => [holdingGate(root)] });
    try {
      await hold(f);
      const screen = f.submit(await f.candidate("a.txt"));
      f.queue.wake();
      await until(() => placements(f, screen).length || undefined);
      assert.deepEqual(placements(f, screen), [hostPlaces ? "host" : "boat"]);
      const other = f.submit(await f.candidate("unheld", f.otherAuthor, "fixture/other"));
      f.queue.wake();
      if (hostPlaces) {
        // The other repository's landing would land in moments with a free worker; it waits for the host gate.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        assert.equal(f.log.operation(other)?.status, "queued", "no more host work starts beside the host-placed gate");
        assert.equal(f.result(screen), undefined);
      } else {
        await until(() => f.result(other) || undefined);
        assert.equal(f.result(other)?.type, "landed", "a screen gating on boat holds no worker");
        assert.equal(f.result(screen), undefined);
      }
      await release(f);
      const results = await terminal(f, screen, other);
      assert.deepEqual(results.map((result) => result?.type), ["landed", "landed"]);
    } finally { await release(f); await f.dispose(); }
  }
}, 240_000);

test("a host-placed gate that changes the candidate's files fails the landing, and a process it leaves is stopped", async () => {
  const boat = fakeBoat();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, workers: 1, hostPlaces: 1, remoteVerification: boat.remote, gates: (root) => [holdingGate(root)] });
  try {
    const mutated = await f.land(f.submit(await f.candidate("mutate")));
    assert.equal(mutated?.type, "failed", JSON.stringify(mutated));
    assert.match(mutated?.type === "failed" ? mutated.reason : "", new RegExp(`changed 1 file\\(s\\) of the candidate on ${f.executor.host}`));
    assert.ok(!f.log.events().some(({ event }) => event.type === "verification_passed"));

    const lingering = await f.land(f.submit(await f.candidate("linger")));
    assert.equal(lingering?.type, "landed", JSON.stringify(lingering));
    const pid = Number(await readFile(join(f.root, "linger.pid"), "utf8"));
    assert.ok(pid > 0);
    await until(() => { try { process.kill(pid, 0); return undefined; } catch { return true; } });
    const next = await f.land(f.submit(await f.candidate("next.txt")));
    assert.equal(next?.type, "landed");
    assert.deepEqual(placements(f), ["host", "host", "host"]);
    assert.equal(boat.opens(), 0, "a lone landing never opens boat");
  } finally { await f.dispose(); }
}, 240_000);

test("while boat is held a landing still gates in the free host place", async () => {
  let available = false;
  const boat = fakeBoat(async () => available ? undefined : Object.assign(new Error("Remote executor unavailable (boat): could not reach the Boat API"), { boatUnavailable: true }));
  boat.remote.probe = async () => { if (!available) throw new Error("still unreachable"); };
  const f = await fixture(true, false, undefined, false, { screeningLanes: 3, workers: 2, hostPlaces: 1, boatProbeMs: 10, remoteVerification: boat.remote, gates: (root) => [holdingGate(root)] });
  try {
    await hold(f);
    // A migration change is not predicted past, so the landing after it screens on the tip alone.
    const a = f.submit(await f.candidate("schema/table.sql"));
    f.queue.wake();
    await until(() => placements(f, a).length || undefined);
    // The host place is busy, so the next gate goes to boat, which is down: the hold opens and it waits queued.
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(() => f.log.events().some(({ event }) => event.type === "boat_circuit" && event.state === "open" && event.hostPlace) || undefined);
    await release(f);
    const [first, second] = await terminal(f, a, b);
    assert.equal(first?.type, "landed");
    assert.equal(second?.type, "landed", JSON.stringify(second));
    assert.deepEqual(placements(f, b), ["host"], "the held landing gated in the host place once it was free");
    assert.equal(boat.opened.length, 0);
    const circuits = f.log.events().flatMap(({ event }) => event.type === "boat_circuit" ? [event.state] : []);
    assert.deepEqual(circuits, ["open"], "boat is still held");
  } finally { await release(f); available = true; await f.dispose(); }
}, 240_000);

/** The failure `boat-verifier.ts` throws for a slot whose disk boat never restored. */
const SLOT_NOT_READY = "Remote executor unavailable (boat): slipjay-fixture-repo-0-screen not reachable: state idle, disk still restoring after 300s";

test("a retry of a VM that was not ready runs in the host place when it finds it free", async () => {
  let refused = 0;
  const boat = fakeBoat(async () => refused++ ? undefined : Object.assign(new Error(SLOT_NOT_READY), { machineUnavailable: true }));
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, workers: 2, hostPlaces: 1, remoteVerification: boat.remote, gates: (root) => [holdingGate(root)] });
  try {
    await hold(f);
    const a = f.submit(await f.candidate("a.txt"));
    f.queue.wake();
    await until(() => placements(f, a).length || undefined);
    // The host place is busy, so the gate behind it opens boat, whose VM is not ready; it retries once the one ahead lands.
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(() => refused || undefined);
    await release(f);
    const [first, second] = await terminal(f, a, b);
    assert.equal(first?.type, "landed");
    assert.equal(second?.type, "landed", JSON.stringify(second));
    assert.deepEqual(f.log.events({ operationId: b }).flatMap(({ event }) => event.type === "yielded" ? [event.to] : []), ["a remote executor that was not ready"]);
    assert.deepEqual(placements(f, b), ["host"], "the retry found the host place free and ran there");
    assert.equal(boat.opened.length, 0);
  } finally { await release(f); await f.dispose(); }
}, 240_000);

test("a retry of a VM that was not ready waits on boat while the host place is busy", async () => {
  let refused = 0;
  const boat = fakeBoat(async () => refused++ ? undefined : Object.assign(new Error(SLOT_NOT_READY), { machineUnavailable: true }));
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, workers: 2, hostPlaces: 1, remoteVerification: boat.remote, gates: (root) => [holdingGate(root)] });
  try {
    await hold(f);
    const a = f.submit(await f.candidate("shared.txt"));
    f.queue.wake();
    await until(() => placements(f, a).length || undefined);
    // A landing that conflicts with the one ahead screens on the tip alone, so its retry does not wait for that one.
    jj(f.author, ["new", "-m", "Rewrite shared.txt", "main@origin"]);
    await writeFile(join(f.author, "shared.txt"), "conflicting\n");
    const b = f.submit(await f.push());
    f.queue.wake();
    await until(() => placements(f, b).length || undefined);
    assert.deepEqual(placements(f, b), ["boat"]);
    assert.deepEqual(f.log.events({ operationId: b }).flatMap(({ event }) => event.type === "yielded" && event.to === "a remote executor that was not ready" ? [event.to] : []), ["a remote executor that was not ready"]);
    assert.deepEqual(boat.opened.map((entry) => entry.retrying), [true], "the retry waits on the slot's VM, forking none");
    assert.equal(hostGatesNow(f), 1, "the host place still holds the gate ahead");
    await release(f);
    // Whichever publishes first, the other then conflicts with it.
    const results = await terminal(f, a, b);
    assert.deepEqual(results.map((result) => result?.type).sort(), ["failed", "landed"], JSON.stringify(results));
  } finally { await release(f); await f.dispose(); }
}, 240_000);

test("with hostPlaces 0 every attempt of YardSmith's shape gates on boat; a bad hostPlaces is refused at load", async () => {
  const boat = fakeBoat();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, hostPlaces: 0, remoteVerification: boat.remote, gates: (root) => [holdingGate(root)] });
  try {
    const ids = [f.submit(await f.candidate("a.txt")), f.submit(await f.candidate("b.txt"))];
    const results = await terminal(f, ...ids);
    assert.deepEqual(results.map((result) => result?.type), ["landed", "landed"]);
    assert.deepEqual(placements(f), ["boat", "boat"]);
  } finally { await f.dispose(); }

  const config = (entry: RunnerConfig["repos"][string]): RunnerConfig => ({ repos: { "pechhe/yardsmith": entry }, boat: { image: "bx_image" }, jj: { "user.name": "Runner", "user.email": "runner@example.com" } });
  assert.equal(runnerConfigProblem(config({ url: "u", verifier: "boat", screeningLanes: 3, hostPlaces: 1 })), null);
  assert.equal(runnerConfigProblem(config({ url: "u", verifier: "boat", screeningLanes: 3, hostPlaces: 0 })), null);
  assert.match(runnerConfigProblem(config({ url: "u", verifier: "boat", hostPlaces: 2 as 1 })) ?? "", /"hostPlaces" must be 0 or 1/);
  assert.match(runnerConfigProblem(config({ url: "u", hostPlaces: 1 })) ?? "", /"hostPlaces" needs a "verifier"/);
}, 240_000);

test("a boat hold of a repository with a host place says a free host place still takes a gate", async () => {
  const log = openOperationLog(":memory:");
  const id = newOperationId();
  log.append(id, { type: "submitted", repo: "pechhe/yardsmith", changeId: "c".repeat(32), commitId: "a".repeat(40), bookmark: "slipjay/changes/x", submittedBy: "test" });
  log.append(RUNNER_CONTROL_ID, { type: "boat_circuit", repo: "pechhe/yardsmith", state: "open", reason: "could not reach the Boat API", hostPlace: true });
  assert.equal(log.openOperations().find((operation) => operation.id === id)?.waitingFor, "boat: could not reach the Boat API; a free runner-host gate place still takes a gate");
});
