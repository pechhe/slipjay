import assert from "node:assert/strict";
import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";
import { pipelineMetrics } from "../../src/lib/runner/pipeline-metrics.ts";
import type { RemoteAttempt, RemoteVerification } from "../../src/lib/runner/runner-types.ts";
import { fixture, test } from "./fixtures/runner-queue-fixture.ts";

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
