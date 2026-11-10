import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { FAILING_TESTS_LIMIT, PREBUILD_KEY, runBatchCheck, type BatchRun, type BatchScope } from "../../src/lib/release/batch-check.ts";

const landing = (n: number) => ({ commitId: `${n}`.repeat(40).slice(0, 40), operationId: `op-${n}` });
const L = [1, 2, 3, 4, 5].map(landing);
const fail = (suites: Record<string, "passed" | "failed" | "missing">, failingTests: string[] = []): BatchRun =>
  ({ status: "failed", failedChecks: [0], command: "bun run test:release:batch", suites, failingTests, output: "FAIL" });
const pass = (suites: Record<string, "passed" | "failed" | "missing"> = {}): BatchRun => ({ status: "passed", suites });

test("a five-landing batch with two independent regressions names the second and fourth landings as separate culprits", async () => {
  // Landing 2 breaks the suite, landing 3 repairs it, landing 4 breaks it again independently, and landing 5 depends on landing 2.
  const states: Record<string, BatchRun> = {
    [L[0]!.commitId]: pass({ workbench: "passed" }),
    [L[1]!.commitId]: fail({ workbench: "failed" }, ["a > breaks"]),
    [L[2]!.commitId]: pass({ workbench: "passed" }),
    [L[3]!.commitId]: fail({ workbench: "failed" }, ["b > breaks"]),
    [L[4]!.commitId]: fail({ workbench: "failed" }, ["b > breaks"]),
  };
  const calls: { commit: string; scope: BatchScope | null; phase: string }[] = [];
  const outcome = await runBatchCheck({ head: L[4]!.commitId, landings: L,
    run: async (commit, scope, phase) => { calls.push({ commit, scope, phase }); return states[commit]!; } });
  assert.equal(outcome.outcome, "red");
  if (outcome.outcome !== "red") return;
  assert.deepEqual(outcome.culprits.map((culprit) => culprit.operationId), ["op-2", "op-4"]);
  assert.deepEqual(outcome.culprits.map((culprit) => culprit.failingTests), [["a > breaks"], ["b > breaks"]]);
  // The only offer is the commit before the first culprit, which still needs its own complete check.
  assert.equal(outcome.shorterCandidate, L[0]!.commitId);
  // Complete check and rerun at the head, then only the failing suite at each earlier landing, in landing order.
  assert.deepEqual(calls.map((call) => [call.phase, call.commit]), [
    ["complete", L[4]!.commitId], ["rerun", L[4]!.commitId],
    ...L.slice(0, 4).map((entry) => ["diagnosis", entry.commitId]),
  ]);
  assert.deepEqual(calls.slice(1).map((call) => call.scope), Array(5).fill({ checks: [0], suites: ["workbench"] }));
});

test("a failure that passes its rerun is flaky and diagnoses nothing; infrastructure is never a regression", async () => {
  let runs = 0;
  const flaky = await runBatchCheck({ head: L[0]!.commitId, landings: L.slice(0, 1),
    run: async () => (runs++ === 0 ? fail({ weave: "failed" }) : pass({ weave: "passed" })) });
  assert.deepEqual(flaky, { outcome: "flaky", keys: ["weave"], failingTests: [] });
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
  assert.deepEqual(unstable, { outcome: "flaky", keys: ["ui", "weave"], failingTests: ["weave > a", "ui > b"] });
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
  assert.deepEqual(calls, ["complete:4", "rerun:4", "diagnosis:1", "diagnosis:2", "diagnosis:2", "diagnosis:3"]);

  // A lost step that a retry recovers changes nothing: landing 2 is named.
  let lost = true;
  const retried = await runBatchCheck({ head: L[2]!.commitId, landings: L.slice(0, 3), run: async (commit) => {
    if (commit === L[0]!.commitId) return pass({ workbench: "passed" });
    if (commit === L[1]!.commitId && lost) { lost = false; return { status: "infrastructure", reason: "ssh lost" }; }
    return fail({ workbench: "failed" });
  } });
  assert.ok(retried.outcome === "red" && retried.diagnosis === "complete" && retried.unattributed.length === 0);
  if (retried.outcome === "red") assert.deepEqual(retried.culprits.map((culprit) => culprit.operationId), ["op-2"]);
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
  assert.deepEqual(flaky, { outcome: "flaky", keys: [PREBUILD_KEY], failingTests: [] });
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
