import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { FAILING_TESTS_LIMIT, flakyVerifies, PREBUILD_KEY, prebuildFailuresMatch, prebuildFailureSignature, runBatchCheck, type BatchRun, type BatchScope, type SuiteState } from "../../src/lib/release/batch-check.ts";

const landing = (n: number) => ({ commitId: String(n).padEnd(40, "a"), operationId: `op-${n}` });
const L = [1, 2, 3, 4, 5].map(landing);
const fail = (suites: Record<string, "passed" | "failed" | "missing">, failingTests: string[] = []): BatchRun =>
  ({ status: "failed", failedChecks: [0], command: "bun run test:release:batch", suites, failingTests, output: "FAIL" });
const pass = (suites: Record<string, "passed" | "failed" | "missing"> = {}): BatchRun => ({ status: "passed", suites });

test("a suite that breaks, recovers and breaks again is bisected to its active regression", async () => {
  const states: Record<string, BatchRun> = {
    [L[0]!.commitId]: pass({ workbench: "passed" }),
    [L[1]!.commitId]: fail({ workbench: "failed" }, ["a > breaks"]),
    [L[2]!.commitId]: pass({ workbench: "passed" }),
    [L[3]!.commitId]: fail({ workbench: "failed" }, ["b > breaks"]),
    [L[4]!.commitId]: fail({ workbench: "failed" }, ["b > breaks"]),
  };
  const sixth = landing(6);
  states[sixth.commitId] = states[L[4]!.commitId]!;
  const calls: { commit: string; scope: BatchScope | null; phase: string }[] = [];
  const outcome = await runBatchCheck({ head: sixth.commitId, landings: [...L, sixth],
    run: async (commit, scope, phase) => { calls.push({ commit, scope, phase }); return states[commit]!; } });
  assert.equal(outcome.outcome, "red");
  if (outcome.outcome !== "red") return;
  assert.deepEqual(outcome.culprits.map((culprit) => culprit.operationId), ["op-4"]);
  assert.deepEqual(outcome.culprits.map((culprit) => culprit.failingTests), [["b > breaks"]]);
  assert.equal(outcome.shorterCandidate, L[2]!.commitId);
  assert.deepEqual(calls.filter(({ phase }) => phase === "diagnosis").map(({ commit }) => commit), [L[2]!.commitId, L[3]!.commitId]);
});

async function independentRegressions(size: number, testBreak: number, buildBreak: number) {
  const landings = Array.from({ length: size }, (_, index) => landing(index + 1));
  const probes: { op: number; scope: BatchScope | null }[] = [];
  const outcome = await runBatchCheck({ head: landings.at(-1)!.commitId, landings, run: async (commit, scope, phase) => {
    const op = landings.findIndex((entry) => entry.commitId === commit) + 1;
    if (phase === "diagnosis") probes.push({ op, scope });
    const suites: Record<string, SuiteState> = {};
    if (!scope || scope.suites.includes("workbench")) suites.workbench = op >= testBreak ? "failed" : "passed";
    if (!scope || scope.suites.includes(PREBUILD_KEY)) suites[PREBUILD_KEY] = op >= buildBreak ? "failed" : "passed";
    const testsFailed = suites.workbench === "failed";
    return testsFailed || suites[PREBUILD_KEY] === "failed"
      ? { ...fail(suites, testsFailed ? ["workbench > breaks"] : []), failedChecks: testsFailed ? [0] : [] }
      : pass(suites);
  } });
  assert.ok(outcome.outcome === "red");
  assert.equal(outcome.diagnosis, "complete");
  assert.deepEqual(outcome.unattributed, []);
  assert.deepEqual(outcome.culprits.map(({ operationId, keys }) => [operationId, keys]), [
    [`op-${testBreak}`, ["workbench"]], [`op-${buildBreak}`, [PREBUILD_KEY]],
  ]);
  assert.equal(outcome.shorterCandidate, landings[testBreak - 2]!.commitId);
  return probes;
}

test("independent test and prebuild regressions share probes and stop running outside their own search windows", async () => {
  const probes = await independentRegressions(5, 2, 4);
  assert.deepEqual(probes, [
    { op: 2, scope: { checks: [0], suites: ["workbench", PREBUILD_KEY] } },
    { op: 3, scope: { checks: [], suites: [PREBUILD_KEY] } },
    { op: 1, scope: { checks: [0], suites: ["workbench"] } },
    { op: 4, scope: { checks: [], suites: [PREBUILD_KEY] } },
  ]);
});

test("a 46-landing batch with two independent regressions is diagnosed in at most 12 probes", async () => {
  const probes = await independentRegressions(46, 12, 35);
  assert.ok(probes.length <= 12, `used ${probes.length} diagnosis probes`);
});

test("the head rerun is reused, even if there are no landings or the head is unlisted", async () => {
  const head = L[1]!.commitId;
  for (const landings of [[], [L[1]!], [L[0]!]]) {
    const commits: string[] = [];
    const outcome = await runBatchCheck({ head, landings, run: async (commit) => {
      commits.push(commit);
      return commit === head ? fail({ workbench: "failed" }, ["a", "a"]) : pass({ workbench: "passed" });
    } });
    assert.ok(outcome.outcome === "red");
    if (!landings.length) {
      assert.deepEqual(outcome, { outcome: "red", keys: ["workbench"], diagnosis: "complete",
        culprits: [], unattributed: [], shorterCandidate: null });
    } else if (landings[0]!.commitId === head) {
      assert.deepEqual(outcome.culprits, [{ ...L[1]!, keys: ["workbench"], failingTests: ["a"], command: "bun run test:release:batch", output: "FAIL" }]);
    } else {
      assert.deepEqual(outcome.culprits, []);
      assert.deepEqual(outcome.unattributed, [{ keys: ["workbench"], after: L[0]!.commitId, firstFailing: head }]);
      assert.equal(outcome.shorterCandidate, L[0]!.commitId);
      assert.equal(outcome.diagnosis, "incomplete");
    }
    assert.deepEqual(commits, landings[0]?.commitId === L[0]!.commitId ? [head, head, L[0]!.commitId] : [head, head]);
  }
});

test("a failure that passes its rerun is flaky and diagnoses nothing; infrastructure is never a regression", async () => {
  let runs = 0;
  const flaky = await runBatchCheck({ head: L[0]!.commitId, landings: L.slice(0, 1),
    run: async () => (runs++ === 0 ? fail({ weave: "failed" }) : pass({ weave: "passed" })) });
  assert.deepEqual(flaky, { outcome: "flaky", keys: ["weave"], failingTests: [], rerunPassed: true });
  assert.equal(runs, 2);

  const machine = await runBatchCheck({ head: L[0]!.commitId, landings: L.slice(0, 1),
    run: async () => ({ status: "infrastructure", reason: "Remote executor unavailable (boat): not reachable" }) });
  assert.deepEqual(machine, { outcome: "infrastructure", reason: "Remote executor unavailable (boat): not reachable" });

  let second = 0;
  const rerunLost = await runBatchCheck({ head: L[0]!.commitId, landings: L.slice(0, 1),
    run: async () => (second++ === 0 ? fail({ weave: "failed" }) : { status: "infrastructure", reason: "ssh lost" }) });
  assert.equal(rerunLost.outcome, "infrastructure");
});

test("a regression is the same failure twice: a rerun failing only other tests is flaky, unless it cannot be told", async () => {
  const head = L[0]!.commitId;
  const twice = (first: BatchRun, second: BatchRun) => {
    let runs = 0;
    return runBatchCheck({ head, landings: [L[0]!], run: async () => (runs++ === 0 ? first : second) });
  };
  // A loaded machine fails a different timing test in the same suites each time.
  const unstable = await twice(fail({ weave: "failed", ui: "failed" }, ["weave > a", "ui > b"]), fail({ weave: "failed", ui: "failed" }, ["weave > c", "ui > d"]));
  assert.deepEqual(unstable, { outcome: "flaky", keys: ["ui", "weave"], failingTests: ["weave > a", "ui > b"], rerunPassed: false });
  // One test failing in both runs keeps every suite that failed twice.
  const broken = await twice(fail({ weave: "failed", ui: "failed" }, ["weave > a", "ui > b"]), fail({ weave: "failed", ui: "failed" }, ["weave > a", "ui > d"]));
  assert.equal(broken.outcome, "red");
  if (broken.outcome === "red") assert.deepEqual(broken.keys, ["ui", "weave"]);
  // Without names, or with either list at its bound and so maybe leaving the repeated test out, a suite failing twice counts.
  assert.equal((await twice(fail({ weave: "failed" }), fail({ weave: "failed" }, ["weave > c"]))).outcome, "red");
  const capped = Array.from({ length: FAILING_TESTS_LIMIT }, (_, index) => `weave > ${index}`);
  assert.equal((await twice(fail({ weave: "failed" }, capped), fail({ weave: "failed" }, ["weave > other"]))).outcome, "red");
  assert.equal((await twice(fail({ weave: "failed" }, ["weave > other"]), fail({ weave: "failed" }, capped))).outcome, "red");
  // A build is not a test: one that fails twice is broken, whatever the tests beside it did.
  const build = await twice(fail({ weave: "failed", [PREBUILD_KEY]: "failed" }, ["weave > a"]), fail({ weave: "failed", [PREBUILD_KEY]: "failed" }, ["weave > c"]));
  assert.equal(build.outcome, "red");
  if (build.outcome === "red") assert.deepEqual(build.keys, [PREBUILD_KEY]);
});

test("a flaky check verifies its head under promoteFlaky only when its rerun passed every failed suite and its images built", async () => {
  const head = L[0]!.commitId;
  const twice = (first: BatchRun, second: BatchRun) => {
    let runs = 0;
    return runBatchCheck({ head, landings: [L[0]!], run: async () => (runs++ === 0 ? first : second) });
  };
  // A suite the rerun never reported was not run again: it says nothing, so the rerun did not pass it.
  const unrun = await twice(fail({ weave: "failed" }, ["weave > a"]), pass({ weave: "missing" }));
  assert.deepEqual(unrun, { outcome: "flaky", keys: ["weave"], failingTests: ["weave > a"], rerunPassed: false });
  const passed = await twice(fail({ weave: "failed" }, ["weave > a"]), pass({ weave: "passed" }));
  const otherFailures = await twice(fail({ weave: "failed" }, ["weave > a"]), fail({ weave: "failed" }, ["weave > b"]));
  assert.ok(passed.outcome === "flaky" && otherFailures.outcome === "flaky" && unrun.outcome === "flaky");
  if (passed.outcome !== "flaky" || otherFailures.outcome !== "flaky" || unrun.outcome !== "flaky") return;
  // No build belongs to the check (a boat pool), or the head's images built in the complete run.
  assert.equal(flakyVerifies(passed, { ran: false, complete: undefined }), true);
  assert.equal(flakyVerifies(passed, { ran: true, complete: "passed" }), true);
  // A rerun that failed other tests, or never ran a failed suite, verifies nothing.
  assert.equal(flakyVerifies(otherFailures, { ran: true, complete: "passed" }), false);
  assert.equal(flakyVerifies(unrun, { ran: true, complete: "passed" }), false);
  // A build that could not run in the complete run proves nothing about the images.
  assert.equal(flakyVerifies(passed, { ran: true, complete: undefined }), false);
  // A build that failed once and built on its rebuild verifies, like any suite that passed its rerun.
  let builds = 0;
  const rebuilt = await runBatchCheck({ head, landings: [L[0]!], run: async () => ++builds === 1
    ? { status: "failed", failedChecks: [], command: "bun scripts/images.ts build", suites: { [PREBUILD_KEY]: "failed" }, failingTests: [], output: "killed" }
    : pass({ [PREBUILD_KEY]: "passed" }) });
  assert.ok(rebuilt.outcome === "flaky");
  if (rebuilt.outcome === "flaky") assert.equal(flakyVerifies(rebuilt, { ran: true, complete: "failed" }), true);
});

test("a suite missing at an older landing keeps its last state, and a command with no suites is diagnosed by its check", async () => {
  // The failing suite does not exist before landing 3, which adds it already failing.
  const missing = await runBatchCheck({ head: L[3]!.commitId, landings: L.slice(0, 4), run: async (commit) =>
    commit === L[0]!.commitId || commit === L[1]!.commitId ? pass({ added: "missing" }) : fail({ added: "failed" }) });
  assert.equal(missing.outcome, "red");
  if (missing.outcome === "red") assert.deepEqual(missing.culprits.map((culprit) => culprit.operationId), ["op-3"]);

  const bare = await runBatchCheck({ head: L[1]!.commitId, landings: L.slice(0, 2), run: async (commit) =>
    commit === L[0]!.commitId ? pass() : fail({}) });
  assert.equal(bare.outcome, "red");
  if (bare.outcome === "red") {
    assert.deepEqual(bare.keys, ["check 1"]);
    assert.deepEqual(bare.culprits.map((culprit) => [culprit.operationId, culprit.keys]), [["op-2", ["check 1"]]]);
  }
});

test("a diagnosis step lost to infrastructure twice leaves the failure unattributed instead of blaming the next landing", async () => {
  // Landing 2 breaks the suite, but the machine is lost at landing 2 both times; landing 3 is then seen failing.
  const calls: string[] = [];
  const outcome = await runBatchCheck({ head: L[3]!.commitId, landings: L.slice(0, 4), run: async (commit, _scope, phase) => {
    calls.push(`${phase}:${commit[0]}`);
    if (commit === L[0]!.commitId) return pass({ workbench: "passed" });
    if (commit === L[1]!.commitId) return { status: "infrastructure", reason: "ssh lost" };
    return fail({ workbench: "failed" }, ["a > breaks"]);
  } });
  assert.equal(outcome.outcome, "red");
  if (outcome.outcome !== "red") return;
  assert.deepEqual(outcome.culprits, [], "landing 3 is not blamed for a failure that may have started at landing 2");
  assert.deepEqual(outcome.unattributed, [{ keys: ["workbench"], after: L[0]!.commitId, firstFailing: L[2]!.commitId }]);
  assert.equal(outcome.diagnosis, "incomplete");
  assert.match(outcome.reason!, /ssh lost/);
  // Only the part before the landing diagnosis could not see is offered.
  assert.equal(outcome.shorterCandidate, L[0]!.commitId);
  assert.deepEqual(calls, ["complete:4", "rerun:4", "diagnosis:2", "diagnosis:2", "diagnosis:1", "diagnosis:3"]);

  // A lost step that a retry recovers changes nothing: landing 2 is named.
  let lost = true;
  const retried = await runBatchCheck({ head: L[3]!.commitId, landings: L.slice(0, 4), run: async (commit) => {
    if (commit === L[0]!.commitId) return pass({ workbench: "passed" });
    if (commit === L[1]!.commitId && lost) { lost = false; return { status: "infrastructure", reason: "ssh lost" }; }
    return fail({ workbench: "failed" });
  } });
  assert.ok(retried.outcome === "red" && retried.diagnosis === "complete" && retried.unattributed.length === 0);
  if (retried.outcome === "red") assert.deepEqual(retried.culprits.map((culprit) => culprit.operationId), ["op-2"]);
});

test("a missing suite after an unknown probe keeps the failure unattributed", async () => {
  const outcome = await runBatchCheck({ head: L[3]!.commitId, landings: L.slice(0, 4), run: async (commit) => {
    if (commit === L[0]!.commitId) return pass({ workbench: "passed" });
    if (commit === L[1]!.commitId) return { status: "infrastructure", reason: "ssh lost" };
    if (commit === L[2]!.commitId) return pass();
    return fail({ workbench: "failed" });
  } });
  assert.ok(outcome.outcome === "red");
  assert.deepEqual(outcome.culprits, []);
  assert.deepEqual(outcome.unattributed, [{ keys: ["workbench"], after: L[0]!.commitId, firstFailing: L[3]!.commitId }]);
  assert.equal(outcome.shorterCandidate, L[0]!.commitId);
});

test("an inconclusive prebuild is unattributed at the boundary, but a tighter bound can rule it out", async () => {
  for (const before of ["passed", "failed"] as const) {
    for (const after of ["passed", "failed"] as const) {
      const probes: string[] = [];
      const outcome = await runBatchCheck({ head: L[4]!.commitId, landings: L, run: async (commit, scope, phase) => {
        if (phase === "diagnosis") {
          assert.deepEqual(scope, { checks: [], suites: [PREBUILD_KEY] });
          probes.push(commit);
        }
        if (commit === L[1]!.commitId) return pass();
        const state = commit === L[0]!.commitId ? before : commit === L[2]!.commitId ? after : "failed";
        return state === "passed" ? pass({ [PREBUILD_KEY]: state })
          : { ...fail({ [PREBUILD_KEY]: state }), failedChecks: [] };
      } });
      assert.ok(outcome.outcome === "red");
      assert.equal(probes[0], L[1]!.commitId);
      assert.equal(probes.filter((commit) => commit === L[1]!.commitId).length, 1, "an inconclusive build is not an infrastructure retry");
      if (before === "passed" && after === "failed") {
        assert.equal(outcome.diagnosis, "incomplete");
        assert.match(outcome.reason!, /prebuild was inconclusive/);
        assert.deepEqual(outcome.culprits, []);
        assert.deepEqual(outcome.unattributed, [{ keys: [PREBUILD_KEY], after: L[0]!.commitId, firstFailing: L[2]!.commitId }]);
        assert.equal(outcome.shorterCandidate, L[0]!.commitId);
      } else {
        assert.equal(outcome.diagnosis, "complete");
        assert.equal(outcome.reason, undefined);
        assert.deepEqual(outcome.unattributed, []);
        assert.deepEqual(outcome.culprits.map(({ operationId }) => operationId), [before === "failed" ? "op-1" : "op-4"]);
        assert.equal(outcome.shorterCandidate, before === "failed" ? null : L[2]!.commitId);
      }
    }
  }
});

test("a build that breaks is diagnosed like a suite, and a check failure beside it keeps its own key", async () => {
  // Landing 3 breaks the build; landing 4 also fails a check that names no suite.
  const build = (state: "passed" | "failed"): BatchRun => state === "passed" ? pass({ [PREBUILD_KEY]: "passed" })
    : { status: "failed", failedChecks: [], command: "bun scripts/images.ts build", suites: { [PREBUILD_KEY]: "failed" }, failingTests: [], output: "exit code: 1" };
  const head = L[3]!.commitId;
  const states: Record<string, BatchRun> = {
    [L[0]!.commitId]: build("passed"), [L[1]!.commitId]: build("passed"), [L[2]!.commitId]: build("failed"),
    [head]: { status: "failed", failedChecks: [0], command: "bun run check", suites: { [PREBUILD_KEY]: "failed" }, failingTests: [], output: "typecheck" },
  };
  const calls: { commit: string; scope: BatchScope | null }[] = [];
  const outcome = await runBatchCheck({ head, landings: L.slice(0, 4), run: async (commit, scope) => { calls.push({ commit, scope }); return states[commit]!; } });
  assert.equal(outcome.outcome, "red");
  if (outcome.outcome !== "red") return;
  assert.deepEqual(outcome.keys, ["check 1", PREBUILD_KEY]);
  assert.deepEqual(outcome.culprits.map((culprit) => [culprit.operationId, culprit.keys]), [["op-3", [PREBUILD_KEY]], ["op-4", ["check 1"]]]);
  assert.equal(outcome.shorterCandidate, L[1]!.commitId);
  assert.deepEqual(calls[1]!.scope, { checks: [0], suites: [PREBUILD_KEY] }, "the rerun repeats the failed check and rebuilds");
});

test("a build that fails and then builds is flaky, and one that never says anything leaves the head green", async () => {
  const head = L[0]!.commitId;
  let builds = 0;
  const flaky = await runBatchCheck({ head, landings: [L[0]!], run: async () => ++builds === 1
    ? { status: "failed", failedChecks: [], command: "bun scripts/images.ts build", suites: { [PREBUILD_KEY]: "failed" }, failingTests: [], output: "killed" }
    : pass({ [PREBUILD_KEY]: "passed" }) });
  assert.deepEqual(flaky, { outcome: "flaky", keys: [PREBUILD_KEY], failingTests: [], rerunPassed: true });
  assert.deepEqual(await runBatchCheck({ head, landings: [L[0]!], run: async () => pass() }), { outcome: "green" });
});

test("a failed build whose rebuild could not run is infrastructure, never flaky", async () => {
  const head = L[0]!.commitId;
  let runs = 0;
  const outcome = await runBatchCheck({ head, landings: [L[0]!], run: async () => ++runs === 1
    ? { status: "failed", failedChecks: [], command: "bun scripts/images.ts build", suites: { [PREBUILD_KEY]: "failed" }, failingTests: [], output: "exit code: 1" }
    : pass() });
  assert.equal(outcome.outcome, "infrastructure");
});

test("diagnosis skips unrelated old build failures and matches normalized cause subsets", async () => {
  const active = "the app image build failed (exit 1):\n#29 2.31 apps/server/chunks/workflows-QONTBCTQ.js -> ../../../workflows/booking-reminder\n#29 3.0 RolldownError: bundle budget exceeded: 426 kB";
  const earlier = "the app image build failed (exit 1):\n#2 5.1 apps/server/chunks/elk-QONTBCTQ.js -> ./elk-api.js";
  const combined = active.replace("QONTBCTQ", "ABCDEFGH").replace("426 kB", "427 kB")
    + "\n#12 0.1 apps/server/chunks/wav-AGGTTHHB.js -> ./wav.js";
  assert.equal(prebuildFailuresMatch(active, combined), true);
  assert.equal(prebuildFailuresMatch(active, earlier), false);
  assert.equal(prebuildFailuresMatch(active, combined.replace("the app image", "the api image")), false);
  assert.equal(prebuildFailuresMatch(active, "ERROR: failed to build: process exited 1"), true);
  assert.equal(prebuildFailureSignature('#7 1.0 error: script "build" exited with code 1\n#7 ERROR: process failed\nBun v1.2'), null);
  const broken = (output: string): BatchRun => ({
    status: "failed", suites: { prebuild: "failed" }, output, failedChecks: [], command: "build", failingTests: [],
  });
  const outcome = await runBatchCheck({ head: L[4]!.commitId, landings: L,
    run: async (commit) => broken(commit === L[4]!.commitId ? active : commit === L[3]!.commitId ? combined : earlier) });
  assert.ok(outcome.outcome === "red");
  assert.deepEqual(outcome.culprits.map(({ operationId }) => operationId), ["op-4"]);
});

test("stopping a diagnosis during a probe preserves earlier bounds and never retries or queues a shorter candidate", async () => {
  const diagnosis = new AbortController();
  const probes: string[] = [];
  const outcome = await runBatchCheck({ head: L[4]!.commitId, landings: L, diagnosisSignal: diagnosis.signal, diagnosisStopReason: () => "owner confirmed",
    run: async (commit, _scope, phase) => {
      if (phase !== "diagnosis") return fail({ suite: "failed" });
      probes.push(commit);
      if (probes.length === 1) return pass({ suite: "passed" });
      diagnosis.abort();
      return { status: "infrastructure", reason: "stopped" };
    } });
  assert.deepEqual(probes, [L[1]!.commitId, L[2]!.commitId]);
  assert.deepEqual(outcome, { outcome: "red", culprits: [], keys: ["suite"], diagnosis: "incomplete", reason: "owner confirmed", shorterCandidate: null,
    unattributed: [{ keys: ["suite"], after: L[1]!.commitId, firstFailing: L[4]!.commitId }] });
});
