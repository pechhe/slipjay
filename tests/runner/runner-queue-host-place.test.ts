import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { newOperationId } from "../../src/lib/runner/runner-log.ts";
import { pipelineMetrics } from "../../src/lib/runner/pipeline-metrics.ts";
import { runnerConfigProblem } from "../../src/lib/runner/runner-config.ts";
import type { RunnerConfig } from "../../src/lib/runner/runner-types.ts";
import { fixture, test, until } from "./fixtures/queue-verifier-fixture.ts";
import { fakeBoat, hold, holdingGate, hostGatesNow, placements, release, terminal } from "./fixtures/host-place-fixture.ts";

/**
 * SJ-189: a remote-verifying repository with `hostPlaces: 1` gates in the runner host's one gate place when it is free
 * as its commands are about to run, and on its boat VM otherwise.
 */

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
  await Promise.all(([1, 0] as const).map(async (hostPlaces) => {
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
        // The other repository's landing would start immediately with a free worker; it waits for the host gate.
        await new Promise((resolve) => setTimeout(resolve, 350));
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
  }));
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

test("with hostPlaces 0 every attempt of YardSmith's shape gates on boat; a bad hostPlaces is refused at load", async () => {
  const boat = fakeBoat();
  const f = await fixture(false, false, undefined, false, { screeningLanes: 3, hostPlaces: 0, remoteVerification: boat.remote, gates: (root) => [holdingGate(root)] });
  try {
    const ids = [f.submit(await f.candidate("a.txt")), f.submit(await f.candidate("b.txt"))];
    const results = await terminal(f, ...ids);
    assert.deepEqual(results.map((result) => result?.type), ["landed", "landed"]);
    assert.deepEqual(placements(f), ["boat", "boat"]);
  } finally { await f.dispose(); }

  const config = (entry: RunnerConfig["repos"][string]): RunnerConfig => ({ repos: { "pechhe/yardsmith": entry }, boat: { image: "gate-image" }, jj: { "user.name": "Runner", "user.email": "runner@example.com" } });
  assert.equal(runnerConfigProblem(config({ url: "u", verifier: "boat", screeningLanes: 3, hostPlaces: 1 })), null);
  assert.equal(runnerConfigProblem(config({ url: "u", verifier: "boat", screeningLanes: 3, hostPlaces: 0 })), null);
  assert.match(runnerConfigProblem(config({ url: "u", verifier: "boat", hostPlaces: 2 as 1 })) ?? "", /"hostPlaces" must be 0 or 1/);
  assert.match(runnerConfigProblem(config({ url: "u", hostPlaces: 1 })) ?? "", /"hostPlaces" needs a "verifier"/);
}, 240_000);
