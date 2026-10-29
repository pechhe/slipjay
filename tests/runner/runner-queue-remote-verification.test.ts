import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";
import { createRunnerQueue } from "../../src/lib/runner/runner-queue.ts";
import { pipelineMetrics } from "../../src/lib/runner/pipeline-metrics.ts";
import type { RemoteAttempt, RemoteVerification } from "../../src/lib/runner/runner-types.ts";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { fixture, test, until } from "./fixtures/runner-queue-fixture.ts";

/** A remote verifier whose "machine" runs commands on this host, recording what the queue asked of it. */
function fakeRemote(failOpen?: string, treeAfter = "t".repeat(40), billed = true) {
  const opened: { slot: number; candidate: string; base: string; integrationBranch: string }[] = [];
  let closed = 0;
  const remote: RemoteVerification = {
    async open({ slot, candidate, base, integrationBranch }): Promise<RemoteAttempt> {
      if (failOpen) throw Object.assign(new Error(failOpen), failOpen.includes("(setup)")
        ? { remote: { machine: { verifier: "boat", id: "bx_fake", name: "slipjay-fixture-repo-0", size: "default", image: "bx_image" }, usageBefore: { seconds: 10, dollars: 0.0001 }, usage: { seconds: 40, dollars: 0.0004 } } } : {});
      opened.push({ slot, candidate, base, integrationBranch });
      return {
        executor: { host: "boat:fake-0", run: runBoundedProcess, runtime: { name: "bun", version: "9.9.9", path: "/vm/bun", sha256: "f".repeat(64) } },
        machine: { verifier: "boat", id: "bx_fake", name: "slipjay-fixture-repo-0", size: "default", image: "bx_image" },
        tree: "t".repeat(40),
        usage: billed ? { seconds: 100, dollars: 0.001 } : null,
        finish: async () => treeAfter === "t".repeat(40)
          ? { tree: treeAfter, trackedChanges: 0, usage: billed ? { seconds: 160, dollars: 0.0016 } : null }
          : { tree: null, trackedChanges: 2, usage: { seconds: 160, dollars: 0.0016 } },
        close: async () => { closed += 1; },
      };
    },
  };
  return { remote, opened, closed: () => closed };
}

test("a repository verifying remotely runs only its gate on the remote machine and records the machine", async () => {
  const fake = fakeRemote();
  const f = await fixture(false, false, undefined, false, { remoteVerification: fake.remote });
  try {
    const landed = await f.land(f.submit(await f.candidate("remote.txt")));
    assert.equal(landed?.type, "landed", JSON.stringify(landed));
    assert.equal(fake.opened.length, 1);
    assert.equal(fake.opened[0]!.integrationBranch, "main");
    assert.equal(fake.closed(), 1, "the attempt's machine is released");

    const events = f.log.events().map(({ event }) => event);
    const runs = events.flatMap((event) => event.type === "run_started" ? [event] : []);
    assert.ok(runs.some((run) => run.purpose === "gate"));
    for (const run of runs) assert.equal(run.host, run.purpose === "gate" ? "boat:fake-0" : runs.find((other) => other.purpose !== "gate")!.host, `${run.purpose} ran where expected`);
    assert.notEqual(runs.find((run) => run.purpose === "dependencies")?.host, "boat:fake-0", "preparation stays on the runner host");

    const remote = events.flatMap((event) => event.type === "remote_verification" ? [event] : []);
    assert.deepEqual(remote.map((event) => event.phase), ["ready", "finished"]);
    const base = events.find((event) => event.type === "verification_base");
    assert.equal(remote[0]?.phase === "ready" && remote[0].candidate, base?.type === "verification_base" ? base.candidate : undefined);
    assert.equal(remote[1]?.phase === "finished" && remote[1].tree, "t".repeat(40));
    const landing = pipelineMetrics(f.log.events(), "1970-01-01T00:00:00.000Z").groups.find((group) => group.kind === "landing");
    assert.equal(landing?.remote?.attempts, 1, "metrics report the remote attempt");
    assert.ok((landing?.remote?.machineMs ?? -1) >= 0);
    assert.equal(landing?.remote?.dollars, 0.0006, "spend is what the machine was billed across the window");
    const gate = runs.find((run) => run.purpose === "gate");
    assert.equal(gate?.commandEvidence?.status === "recorded" && gate.commandEvidence.runtime?.path, "/vm/bun", "evidence names the Bun that ran");
  } finally { await f.dispose(); }
}, 120_000);

test("a remote verifier that cannot supply a machine fails the landing as infrastructure, naming it, and runs no gate", async () => {
  const fake = fakeRemote("Remote executor unavailable (boat): boat fork: Start the $20/month Boat plan to create sandboxes");
  const f = await fixture(false, false, undefined, false, { remoteVerification: fake.remote });
  try {
    const failed = await f.land(f.submit(await f.candidate("remote.txt")));
    assert.equal(failed?.type, "failed", JSON.stringify(failed));
    assert.match(failed?.type === "failed" ? failed.reason : "", /Remote executor unavailable \(boat\): boat fork/);
    const events = f.log.events().map(({ event }) => event);
    assert.ok(!events.some((event) => event.type === "run_started" && event.purpose === "gate"), "no gate command ran anywhere");
    const classified = events.find((event) => event.type === "classified");
    assert.equal(classified?.type === "classified" && classified.cause, "infrastructure");
  } finally { await f.dispose(); }
}, 120_000);

test("a gate that changes the candidate's files on the remote machine is no evidence: the landing fails", async () => {
  const fake = fakeRemote(undefined, "u".repeat(40));
  const f = await fixture(false, false, undefined, false, { remoteVerification: fake.remote });
  try {
    const failed = await f.land(f.submit(await f.candidate("remote.txt")));
    assert.equal(failed?.type, "failed", JSON.stringify(failed));
    assert.match(failed?.type === "failed" ? failed.reason : "", /changed 2 file\(s\) of the candidate on boat:fake-0/);
    assert.ok(!f.log.events().some(({ event }) => event.type === "verification_passed"));
    assert.equal(fake.closed(), 1);
  } finally { await f.dispose(); }
}, 120_000);

test("a reading boat could not give leaves the window's billed spend unavailable, never $0", async () => {
  const fake = fakeRemote(undefined, undefined, false);
  const f = await fixture(false, false, undefined, false, { remoteVerification: fake.remote });
  try {
    const landed = await f.land(f.submit(await f.candidate("remote.txt")));
    assert.equal(landed?.type, "landed", JSON.stringify(landed));
    const landing = pipelineMetrics(f.log.events(), "1970-01-01T00:00:00.000Z").groups.find((group) => group.kind === "landing");
    assert.equal(landing?.remote?.attempts, 1);
    assert.equal(landing?.remote?.dollars, null);
  } finally { await f.dispose(); }
}, 120_000);

test("a setup that fails on a machine is recorded with the machine's billing, so the window's spend still counts it", async () => {
  const fake = fakeRemote("Remote executor unavailable (setup): check out the candidate on slipjay-fixture-repo-0 exited 1: bun install failed");
  const f = await fixture(false, false, undefined, false, { remoteVerification: fake.remote });
  try {
    const failed = await f.land(f.submit(await f.candidate("remote.txt")));
    assert.equal(failed?.type, "failed", JSON.stringify(failed));
    const remote = f.log.events().flatMap(({ event }) => event.type === "remote_verification" ? [event] : []);
    assert.deepEqual(remote.map((event) => event.phase), ["failed"]);
    assert.equal(remote[0]?.usage?.dollars, 0.0004);
    const landing = pipelineMetrics(f.log.events(), "1970-01-01T00:00:00.000Z").groups.find((group) => group.kind === "landing");
    assert.equal(landing?.remote?.attempts, 0, "no attempt reached the gate");
    assert.equal(landing?.remote?.dollars, 0.0003, "the failed setup's spend, from its readings before and after");
    assert.match(remote[0]?.phase === "failed" ? remote[0].reason : "", /bun install failed/);
  } finally { await f.dispose(); }
}, 120_000);


test("a boat outage holds only that repository, frees its worker, and resumes the same queued landings", async () => {
  const fake = fakeRemote();
  const originalOpen = fake.remote.open;
  let available = false;
  let opens = 0;
  let probes = 0;
  fake.remote.open = async (input) => {
    opens++;
    if (!available) throw Object.assign(new Error("Remote executor unavailable (boat): could not reach the Boat API"), { boatUnavailable: true });
    return originalOpen(input);
  };
  fake.remote.probe = async () => {
    probes++;
    if (!available) throw new Error("still unreachable");
  };
  const f = await fixture(false, false, undefined, false, { remoteVerification: fake.remote, boatProbeMs: 10, workers: 1, other: true, verificationDepth: 2 });
  try {
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    const other = f.submit(await f.candidate("other.txt", f.otherAuthor, "fixture/other"));
    f.queue.wake();
    await until(() => f.log.operation(a)?.status === "queued" && f.log.operation(a)?.waitingFor?.includes("boat:") || undefined);
    await f.queue.idle();
    assert.equal(f.result(other)?.type, "landed", "the unavailable repository holds no worker");
    for (const id of [a, b]) {
      assert.equal(f.log.operation(id)?.status, "queued");
      assert.equal(f.log.operation(id)?.stage, "paused");
      assert.match(f.log.operation(id)?.waitingFor ?? "", /boat:.*could not reach the Boat API/);
      assert.equal(f.result(id), undefined, "an outage is no terminal failure");
    }
    assert.equal(opens, 1, "the next landing never attempts the unavailable VM");
    await until(() => probes >= 2 || undefined);
    const events = f.log.events().map(({ event }) => event);
    assert.equal(events.filter((event) => event.type === "boat_circuit" && event.state === "open").length, 1);
    assert.ok(!events.some((event) => event.type === "classified" && event.cause === "infrastructure"));

    available = true;
    await until(() => f.result(a)?.type === "landed" && f.result(b)?.type === "landed" || undefined);
    await f.queue.idle();
    assert.equal(opens, 3);
    const attempts = f.log.events({ operationId: a }).flatMap(({ event }) => event.type === "attempt_started" ? [event.attempt] : []);
    assert.deepEqual(attempts, [1, 2], "resuming makes a fresh attempt, retaining the submission");
    const circuits = f.log.events().flatMap(({ event }) => event.type === "boat_circuit" ? [event.state] : []);
    assert.deepEqual(circuits, ["open", "closed"]);
  } finally { await f.dispose(); }
});

test("killing a boat-held landing cancels it promptly and it is never resumed", async () => {
  const fake = fakeRemote();
  let available = false;
  let opens = 0;
  const originalOpen = fake.remote.open;
  fake.remote.open = async (input) => {
    opens++;
    if (!available) throw Object.assign(new Error("Remote executor unavailable (boat): connection refused"), { boatUnavailable: true });
    return originalOpen(input);
  };
  fake.remote.probe = async () => { if (!available) throw new Error("unreachable"); };
  const f = await fixture(false, false, undefined, false, { remoteVerification: fake.remote, boatProbeMs: 10, verificationDepth: 2 });
  try {
    const id = f.submit(await f.candidate("remote.txt"));
    f.queue.wake();
    await until(() => f.log.operation(id)?.status === "queued" && f.log.operation(id)?.stage === "paused" || undefined);
    const start = Date.now();
    assert.equal(f.queue.kill(id).status, "killed");
    assert.equal(f.result(id)?.type, "cancelled");
    assert.ok(Date.now() - start < 1000);
    available = true;
    await until(() => f.log.events().some(({ event }) => event.type === "boat_circuit" && event.state === "closed") || undefined);
    await f.queue.idle();
    assert.equal(opens, 1);
    assert.equal(f.result(id)?.type, "cancelled");
    const operation = f.log.operation(id)!;
    assert.equal(execFileSync("git", ["--git-dir", f.origin, "for-each-ref", `refs/heads/${operation.kind === "landing" ? operation.bookmark : ""}`], { encoding: "utf8" }).trim(), "", "cancellation removes the held prefix's candidate bookmark");
  } finally { await f.dispose(); }
});

test("a gate failure is never retried and never opens the boat circuit", async () => {
  const fake = fakeRemote();
  fake.remote.probe = async () => {};
  const f = await fixture(false, false, undefined, false, { remoteVerification: fake.remote, gates: () => ["process.exit(7)"] });
  try {
    const result = await f.land(f.submit(await f.candidate("remote.txt")));
    assert.equal(result?.type, "failed");
    assert.equal(fake.opened.length, 1);
    assert.ok(!f.log.events().some(({ event }) => event.type === "boat_circuit" || event.type === "yielded"));
    assert.equal(f.log.events().filter(({ event }) => event.type === "run_started" && event.purpose === "gate").length, 1);
  } finally { await f.dispose(); }
});

test("pausing during boat admission stops the wait and leaves the landing queued until resume", async () => {
  const fake = fakeRemote();
  const originalOpen = fake.remote.open;
  let opening = false;
  fake.remote.open = async ({ signal }) => {
    opening = true;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
  const f = await fixture(false, false, undefined, false, { remoteVerification: fake.remote });
  try {
    const id = f.submit(await f.candidate("remote.txt"));
    f.queue.wake();
    await until(() => opening || undefined);
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "test" });
    await f.queue.idle();
    assert.equal(f.log.operation(id)?.status, "queued");
    assert.equal(f.log.operation(id)?.stage, "paused");
    assert.equal(f.result(id), undefined);
    assert.ok(!f.log.events().some(({ event }) => event.type === "boat_circuit"));
    fake.remote.open = originalOpen;
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "test" });
    assert.equal((await f.land(id))?.type, "landed");
  } finally { await f.dispose(); }
});


test("a runner restart preserves the boat hold and probes before reopening the landing", async () => {
  const fake = fakeRemote();
  const originalOpen = fake.remote.open;
  let available = false;
  let opens = 0;
  fake.remote.open = async (input) => {
    opens++;
    if (!available) throw Object.assign(new Error("Remote executor unavailable (boat): connection refused"), { boatUnavailable: true });
    return originalOpen(input);
  };
  fake.remote.probe = async () => { if (!available) throw new Error("unreachable"); };
  const f = await fixture(false, false, undefined, false, { remoteVerification: fake.remote, boatProbeMs: 10, durable: true });
  let restarted: ReturnType<typeof createRunnerQueue> | undefined;
  try {
    const id = f.submit(await f.candidate("remote.txt"));
    f.queue.wake();
    await until(() => f.log.operation(id)?.status === "queued" && f.log.operation(id)?.stage === "paused" || undefined);
    await f.queue.idle();
    f.queue.close();
    restarted = createRunnerQueue({ log: f.log, executor: f.executor, home: f.home, config: { repos: { "fixture/repo": { url: f.origin, verifier: "boat" } } }, remoteVerification: fake.remote, boatProbeMs: 10 });
    restarted.wake();
    await restarted.idle();
    assert.equal(opens, 1, "restart does not try the VM while the circuit is open");
    assert.match(f.log.operation(id)?.waitingFor ?? "", /boat:/);
    const later = f.submit(await f.candidate("later.txt"));
    const snapshot = f.log.events({ operationId: later }).find(({ event }) => event.type === "queue_snapshot")?.event;
    assert.equal(snapshot?.type === "queue_snapshot" && snapshot.waitingFor?.includes("boat:"), true);
    available = true;
    await until(() => f.result(id)?.type === "landed" && f.result(later)?.type === "landed" || undefined);
    await restarted.idle();
    assert.equal(opens, 3);
  } finally { restarted?.close(); await restarted?.idle(); await f.dispose(); }
});
