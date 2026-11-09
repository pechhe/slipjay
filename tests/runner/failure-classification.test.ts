import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { classifyEvent, classifyFailure, classifyVerificationFailures, FAILURE_COMMAND_PATTERNS, FAILURE_RULE_VERSION, failureCategory, failureCategoryOf, parseFailureOutput } from "../../src/lib/runner/failure-classification.ts";
import { OWNER_KILL_REASON } from "../../src/lib/runner/runner-contract.ts";
import { verificationDiagnosticCollector } from "../../src/lib/infra/verification-failure.ts";
import type { ClassifiedFact, OperationEvent, StoredEvent, VerificationFailureRef } from "../../src/lib/runner/runner-types.ts";

test("parses Vitest, Bun and node TAP failures as concrete test execution", () => {
  const vitest = parseFailureOutput([
    "\u001b[31mFAIL\u001b[39m tests/unit/plan.test.ts > plan > rejects an empty route",
    "  × rejects an empty route 12ms",
  ].join("\n"));
  assert.deepEqual(vitest.failingTests, ["tests/unit/plan.test.ts > plan > rejects an empty route"]);
  assert.equal(vitest.testBodyRan, true);

  const bun = parseFailureOutput("plan.test.ts:\n(pass) creates a route [0.3ms]\n(fail) rejects an empty route [2ms]");
  assert.deepEqual(bun.failingTests, ["plan.test.ts > rejects an empty route"]);
  assert.equal(bun.testBodyRan, true);

  const tap = parseFailureOutput("ok 1 - creates a route\nnot ok 2 - rejects an empty route\n  location: '/repo/plan.test.mjs:4:1'");
  assert.deepEqual(tap.failingTests, ["/repo/plan.test.mjs > rejects an empty route"]);
  assert.equal(tap.testBodyRan, true);
});

test("bounds parsed identities and diagnostics and clips each entry", () => {
  const output = [
    ...Array.from({ length: 130 }, (_, index) => ` FAIL tests/${index}.test.ts > ${"t".repeat(540)}`),
    ...Array.from({ length: 130 }, (_, index) => `src/${index}.ts:1:1: error lint(rule): ${"d".repeat(540)}`),
  ].join("\n");
  const parsed = parseFailureOutput(output);
  assert.equal(parsed.failingTests.length, 100);
  assert.equal(parsed.diagnostics.length, 100);
  assert.ok(parsed.failingTests.every((identity) => identity.length <= 500));
  assert.ok(parsed.diagnostics.every((diagnostic) => diagnostic.length <= 500));
});

test("does not treat a test command as evidence that test bodies ran", () => {
  const event: OperationEvent = { type: "failed", stage: "verifying", reason: "Command exited 1", command: "vp test run tests/a.test.ts" };
  assert.equal(parseFailureOutput("vp test run tests/a.test.ts exited with code 1").testBodyRan, false);
  assert.equal(parseFailureOutput("FAIL tests/a.test.ts [ tests/a.test.ts ]\nError: Cannot find package").testBodyRan, false);
  assert.equal(classifyFailure({ ...event, reason: "Required verification failed (spawn_failure)" }, { paused: false, held: false }).cause, "infrastructure");
  assert.equal(classifyFailure(event as Extract<OperationEvent, { type: "failed" }>, { paused: false, held: false }).cause, "gate");
});

test("classifies terminal precedence, rebase conflicts, verification infrastructure and command families", () => {
  const failed = (stage: Extract<OperationEvent, { type: "failed" }>["stage"], reason = "failed", output?: string): Extract<OperationEvent, { type: "failed" }> => ({
    type: "failed", stage, reason, ...(output ? { output } : {}),
  });
  const classify = (event: Extract<OperationEvent, { type: "failed" | "declined" | "cancelled" | "superseded" }>, context = { paused: false, held: false }) => classifyFailure(event, context);

  assert.equal(classify({ type: "cancelled", reason: OWNER_KILL_REASON }, { paused: true, held: false }).cause, "killed");
  assert.equal(classify({ type: "cancelled", reason: "owner paused the runner" }, { paused: true, held: false }).cause, "paused_out");
  assert.equal(classify({ type: "declined", reason: "migration artifact", paths: [] }).cause, "policy");
  assert.equal(classify({ type: "superseded", by: "newer" }).cause, "superseded");
  assert.equal(classify(failed("rebasing", "Rebase produced conflicts" )).cause, "conflict");
  assert.equal(classify(failed("rebasing", "Rebase command failed")).cause, "infrastructure");
  assert.equal(classify(failed("rebasing", "Landing rename conflict: integration changed a renamed path after the candidate's original base")).cause, "conflict");
  assert.equal(classify(failed("rebasing", "Could not check landing rename safety: diagnostic mentions conflict.ts. Repair the check and land again")).cause, "infrastructure");
  assert.equal(classify(failed("verifying", "Timed out"), { paused: false, held: false }).cause, "infrastructure");
  assert.equal(classifyFailure(failed("verifying", "Timed out"), {
    paused: false, held: false, run: { runId: "r", command: "bun test", host: "runner", startedAt: "now", testBodyRan: true },
  }).cause, "gate");
  assert.equal(classify(failed("verifying", "executor lost connection")).cause, "infrastructure");
  assert.equal(classify(failed("publishing", "push failed"), { paused: false, held: true }).cause, "held");
  assert.equal(classify(failed("fetching", "fetch failed")).cause, "infrastructure");

  for (const command of ["bun test tests/fetch.test.ts", "bun test tests/install.test.ts"]) {
    assert.equal(classifyFailure({
      ...failed("verifying", "test assertion failed", ` FAIL ${command.slice("bun test ".length)} > named assertion`), command,
    }, { paused: false, held: false }).cause, "gate", `${command} is a test command`);
  }
  assert.equal(classifyFailure({ ...failed("verifying", "fetch failed"), command: "git fetch origin" }, { paused: false, held: false }).cause, "infrastructure");
  assert.equal(classifyFailure({ ...failed("verifying", "install failed"), command: "bun install" }, { paused: false, held: false }).cause, "infrastructure");

  assert.deepEqual(FAILURE_COMMAND_PATTERNS.map(({ kind }) => kind), ["fetch", "install", "test", "lint", "typecheck"]);
  assert.equal(FAILURE_RULE_VERSION, 3);
});

test("combines per-check causes: gate if any check is a gate failure, infrastructure only if all are", () => {
  const timeout: VerificationFailureRef = { checkIndex: 0, command: "bun run check:slow", outcome: "timeout", runId: "r-timeout" };
  const tests: VerificationFailureRef = { checkIndex: 1, command: "vp test run", outcome: "nonzero_exit", runId: "r-test" };
  const run = (runId: string, command: string, extra: object = {}) => ({ runId, command, host: "runner", startedAt: "now", ...extra });
  const event = (failures: VerificationFailureRef[]): Extract<OperationEvent, { type: "failed" }> => ({
    type: "failed", stage: "verifying", reason: "1. bun run check:slow timed out\n2. vp test run failed", command: failures[0]!.command, failures,
  });
  const context = { paused: false, held: false };
  const timedOut = { timedOut: true, testBodyRan: false };
  const testRun = { testBodyRan: true, failingTests: ["tests/a.test.ts > breaks"] };

  const mixed = classifyVerificationFailures(event([timeout, tests]), context, [
    { failure: timeout, run: run("r-timeout", timeout.command, timedOut) },
    { failure: tests, run: run("r-test", tests.command, testRun) },
  ]);
  assert.equal(mixed.cause, "gate");
  assert.deepEqual(mixed.checks?.map((check) => [check.command, check.cause, check.runId]), [
    ["bun run check:slow", "infrastructure", "r-timeout"], ["vp test run", "gate", "r-test"],
  ]);
  assert.deepEqual(mixed.failingTests, ["tests/a.test.ts > breaks"]);
  assert.deepEqual(mixed.checks?.[0]?.failingTests, []);

  const only = classifyVerificationFailures(event([timeout]), context, [{ failure: timeout, run: run("r-timeout", timeout.command, timedOut) }]);
  assert.equal(only.cause, "infrastructure");
  // The index text of a gate failure must not make the timeout look like a timeout-with-body or vice versa.
  assert.equal(classifyVerificationFailures(event([tests]), context, [{ failure: tests, run: run("r-test", tests.command, testRun) }]).cause, "gate");
});

test("a gate's failure summary pairs each failing test with its first error and names causes that are not a test", () => {
  const summary = [
    "landing tests workbench failed: …",
    "Landing failure summary:",
    "FAIL apps/workbench/src/plan.spec.ts > plan > rejects an empty route",
    "  first error: AssertionError: expected 1 to be 2",
    "FAIL packages/core/src/a.test.ts > adds",
    "Failure cause: core typecheck: src/a.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    "error: Related landing tests failed: 2 failing tests; 1 suite failed without a named test (core typecheck)",
  ].join("\n");
  const parsed = parseFailureOutput(summary);
  assert.deepEqual(parsed.failingTests, ["apps/workbench/src/plan.spec.ts > plan > rejects an empty route", "packages/core/src/a.test.ts > adds"]);
  assert.deepEqual(parsed.firstErrors, [{ test: "apps/workbench/src/plan.spec.ts > plan > rejects an empty route", error: "AssertionError: expected 1 to be 2" }]);
  assert.deepEqual(parsed.failureCauses, ["core typecheck: src/a.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'."]);
  // A failure that names neither keeps the earlier shape.
  assert.deepEqual(Object.keys(parseFailureOutput("Error: Related landing tests failed")), ["failingTests", "diagnostics", "testBodyRan"]);

  // Each check keeps what it named, and the fact merges them: from the run the runner recorded and from the event's output.
  const failures: VerificationFailureRef[] = [
    { checkIndex: 0, command: "bun run test:landing:affected", outcome: "nonzero_exit", runId: "r-tests" },
    { checkIndex: 1, command: "bun run check", outcome: "nonzero_exit", runId: "r-check" },
  ];
  const fact = classifyVerificationFailures({ type: "failed", stage: "verifying", reason: "Required verification failed", failures, output: summary }, { paused: false, held: false }, [
    { failure: failures[0]!, run: { runId: "r-tests", command: failures[0]!.command, host: "runner", startedAt: "now", firstErrors: [{ test: "apps/workbench/src/plan.spec.ts > plan > rejects an empty route", error: "AssertionError: expected 1 to be 2" }] } },
    { failure: failures[1]!, run: { runId: "r-check", command: failures[1]!.command, host: "runner", startedAt: "now", failureCauses: ["lint: 3 errors"] } },
  ]);
  assert.equal(fact.ruleVersion, 3);
  assert.equal(fact.checks?.[0]?.firstErrors?.length, 1, "the run's and the output's pairing of one test count once");
  assert.deepEqual(fact.checks?.[1]?.failureCauses, ["lint: 3 errors"]);
  assert.deepEqual(fact.failureCauses, ["core typecheck: src/a.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.", "lint: 3 errors"]);
  assert.equal(fact.firstErrors?.[0]?.error, "AssertionError: expected 1 to be 2");
});

test("bun's closing recap is no file's failure, and each failing test is named once", () => {
  // The shape of the seeded YardSmith landing's output (SJ-140.1): the wrapper's suite log, then its summary.
  const output = [
    "test/sj140-seed.test.ts:",
    "error: expect(received).toBe(expected)",
    "(fail) SJ-140 seeded failure names its test and first error [0.71ms]",
    "test/plan.test.ts:",
    "(pass) credit arithmetic > plan configuration gaps name what is missing [0.25ms]",
    "1 tests failed:",
    "(fail) SJ-140 seeded failure names its test and first error [0.71ms]",
    "Landing failure summary:",
    "FAIL packages/ai-usage/test/sj140-seed.test.ts > SJ-140 seeded failure names its test and first error",
    "  first error: error: expect(received).toBe(expected)",
  ].join("\n");
  assert.deepEqual(parseFailureOutput(output).failingTests, ["packages/ai-usage/test/sj140-seed.test.ts > SJ-140 seeded failure names its test and first error"]);

  // A run's identities and its event's merge without repeating one test under a shorter alias.
  const fact = classifyFailure({ type: "failed", stage: "verifying", reason: "failed", command: "vp test run", output: " × adds 3ms" },
    { paused: false, held: false, run: { runId: "r", command: "vp test run", host: "runner", startedAt: "now", failingTests: ["tests/a.test.ts > adds"] } });
  assert.deepEqual(fact.failingTests, ["tests/a.test.ts > adds"]);
});

test("a gate's summary names its failures alone; two files whose paths share a suffix stay two", () => {
  const output = ["FAIL test/a.test.ts > fails", "Landing failure summary:", "FAIL test/a.test.ts > fails", "FAIL packages/x/test/a.test.ts > fails"].join("\n");
  assert.deepEqual(parseFailureOutput(output).failingTests, ["test/a.test.ts > fails", "packages/x/test/a.test.ts > fails"]);
  // A summary that names only causes names no test, whatever the output around it printed.
  assert.deepEqual(parseFailureOutput("other.test.ts:\n(fail) noise\nLanding failure summary:\nFailure cause: core typecheck: error TS2322").failingTests, []);
});

test("the selected diagnostics never file bun's recap under the last file, however long the passing results before it", () => {
  const collector = verificationDiagnosticCollector();
  const passing = Array.from({ length: 40 }, (_, index) => `(pass) plans ${index} [0.25ms]`);
  collector.add(Buffer.from([
    "test/seed.test.ts:", "error: expect(received).toBe(expected)", "(fail) seeded [0.71ms]",
    "test/plan.test.ts:", ...passing, "", "1 tests failed:", "(fail) seeded [0.71ms]", " 26 pass", " 1 fail", "",
  ].join("\n")));
  const selected = collector.finish().output;
  assert.match(selected, /1 tests failed:/);
  assert.doesNotMatch(selected, /test\/plan\.test\.ts:\n\(fail\)/);
  assert.deepEqual(parseFailureOutput(selected).failingTests, ["test/seed.test.ts > seeded"]);
});

const factOf = (extra: Partial<ClassifiedFact> = {}): ClassifiedFact => ({ type: "classified", ruleVersion: 3, cause: "gate", failingTests: [], diagnostics: [], ...extra });
const gateReason = (kind: string, tail = "") => `Required verification failed (nonzero_exit): bun run test (check 1)\nChecks:\n1. bun run test: failed\nCheck 1 (bun run test):\nFailure: ${kind}\n${tail}`;

test("a failure is a regression when its check names a test, an error or a diagnostic, and unresolved when it names none (SJ-215)", () => {
  const named = failureCategory({ reason: gateReason("error", "Failing tests (1):\n  a.test.ts > breaks\nFirst error:\n  AssertionError: expected 1 to be 2"), fact: factOf({ failingTests: ["a.test.ts > breaks"] }) });
  assert.deepEqual(named, { kind: "regression", evidence: "AssertionError: expected 1 to be 2" });
  const testTimeout = failureCategory({ reason: gateReason("error", "Failing tests (1):\n  a.test.ts > slow\nOutput tail (last 1 of 1 lines):\n  ^ this test timed out after 50ms."), fact: factOf({ failingTests: ["a.test.ts > slow"] }) });
  assert.notEqual(testTimeout.kind, "infrastructure", "a test's own timeout wording in captured output is not a runner breakage");
  const laterCheck = `${gateReason("error", "Output tail (last 1 of 1 lines):\n  noise")}\nCheck 2 (bun run lint):\nFailure: error\nexecutor lost`;
  assert.equal(failureCategory({ reason: laterCheck, fact: factOf() }).kind, "infrastructure", "a later check's own runner wording still counts after an earlier check's captured output");
  assert.equal(failureCategory({ reason: gateReason("diagnostics"), fact: factOf({ diagnostics: ["src/a.ts(1,1): error TS2345: bad"] }) }).kind, "regression");
  assert.equal(failureCategory({ reason: gateReason("error"), fact: factOf({ failureCauses: ["architecture: scoped-static exited 1"] }) }).kind, "regression");
  assert.equal(failureCategory({ reason: gateReason("error"), fact: factOf() }).kind, "unresolved");
});

test("tests that timed out are the host's only when it was loaded past two runs per CPU, else unresolved", () => {
  const timeout = { reason: gateReason("timeout and assertion"), fact: factOf({ failingTests: ["a.test.ts > one", "a.test.ts > two"] }) };
  assert.equal(failureCategory({ ...timeout, load: { load1: 43, cpus: 14 } }).kind, "infrastructure");
  assert.equal(failureCategory({ ...timeout, load: { load1: 20, cpus: 14 } }).kind, "unresolved");
  assert.equal(failureCategory(timeout).kind, "unresolved");
});

test("the runner, a remote or a credential breaking is infrastructure by what the event says, not by the stage it failed in", () => {
  const infrastructure = (reason: string) => failureCategory({ reason, fact: factOf({ cause: "infrastructure" }) }).kind;
  assert.equal(infrastructure("runner restarted during verifying; land again"), "infrastructure");
  assert.equal(infrastructure("executor lost: ssh to machine peach-box (ssh ended by SIGKILL)"), "infrastructure");
  assert.equal(infrastructure("Remote executor unavailable (boat): boat resume: no answer from boat within 30s"), "infrastructure");
  assert.equal(infrastructure("jj --color=never git fetch failed: git@github.com: Permission denied (publickey)."), "infrastructure");
  // A failed event in an infrastructure stage that names no breakage decides nothing.
  assert.equal(infrastructure("b5cb02eb8006 is already on master"), "unresolved");
  assert.equal(infrastructure("Invalid reset identity, deadline or interval"), "unresolved");
});

test("a conflict or an invalidated prefix is a moved base, and a batch check's own flake finding is a flake", () => {
  assert.equal(failureCategory({ reason: "Rebase produced conflicts; resolve them in this workspace and retry:\nabc A change", fact: factOf({ cause: "conflict" }) }).kind, "moved_base");
  assert.equal(failureCategory({ reason: "Exact predecessor invalidated this attempt; its verification does not diagnose the submitted source", fact: factOf({ cause: "infrastructure" }) }).kind, "moved_base");
  assert.deepEqual(failureCategory({ reason: "Batch check of 44f99cfcf49c was flaky: forge-build-database failed and passed on its rerun", fact: factOf() }),
    { kind: "flake", evidence: "Batch check of 44f99cfcf49c was flaky: forge-build-database failed and passed on its rerun" });
});

test("classifying an event records its category on failures only, from the operation's own host load", () => {
  const stage = { type: "stage", stage: "verifying", health: { load1: 43, cpus: 14, freeMemoryBytes: 1, totalMemoryBytes: 2, running: 1 } } as const;
  const history: StoredEvent[] = [{ seq: 1, operationId: "op", at: "2026-11-09T00:00:00.000Z", event: stage }];
  const failed: OperationEvent = { type: "failed", stage: "verifying", reason: gateReason("timeout", "Failing tests (1):\n  a.test.ts > slow"), command: "bun run test", output: " FAIL a.test.ts > slow\nTest timed out in 5000ms." };
  const fact = classifyEvent({ event: failed, operation: null, history, paused: false, held: false });
  assert.equal(fact.ruleVersion, 3);
  assert.equal(fact.category?.kind, "infrastructure");
  assert.equal(classifyEvent({ event: { type: "superseded", by: "newer" }, operation: null, history, paused: false, held: false }).category, undefined);
  assert.equal(failureCategoryOf([...history, { seq: 2, operationId: "op", at: "2026-11-09T00:01:00.000Z", event: failed }, { seq: 3, operationId: "op", at: "2026-11-09T00:01:00.000Z", event: fact }])?.kind, "infrastructure");
  assert.equal(failureCategoryOf(history), undefined);
});

test("a failure recorded before rule 3 is a regression only on an error that is its own: a thrown error, a type error or a failed static check", () => {
  const old = (extra: Partial<ClassifiedFact>) => factOf({ ruleVersion: 2, ...extra });
  // The summary's first error was then the first anywhere in the output: a logged line is no evidence.
  assert.equal(failureCategory({ reason: gateReason("error", "Failing tests (1):\n  a.test.ts > b\nFirst error:\n  error: {"), fact: old({ failingTests: ["a.test.ts > b"] }) }).kind, "unresolved");
  assert.equal(failureCategory({ reason: gateReason("error", "Failing tests (1):\n  a.test.ts > b\nFirst error:\n  AssertionError: expected 1 to be 2"), fact: old({ failingTests: ["a.test.ts > b"] }) }).kind, "regression");
  const script = gateReason("error", 'Output tail (last 2 of 2 lines):\nerror: script "check:weave-names" exited with code 1\nerror: script "check:landing" exited with code 1');
  assert.deepEqual(failureCategory({ reason: script, fact: old({}) }), { kind: "regression", evidence: "check:weave-names exited 1" });
  // A test runner's own script exiting says nothing about why.
  assert.equal(failureCategory({ reason: gateReason("error", 'error: script "test:landing:affected" exited with code 1'), fact: old({}) }).kind, "unresolved");
  // From rule 3 the summary prints the failing test's own error, so a plain line is evidence.
  assert.equal(failureCategory({ reason: gateReason("error", "Failing tests (1):\n  a.test.ts > b\nFirst error:\n  error: expect(received).toBe(expected)"), fact: factOf({ failingTests: ["a.test.ts > b"] }) }).kind, "regression");
});

test("a stale receipt and a moved parent during verification are a moved base", () => {
  assert.equal(failureCategory({ reason: "stale receipt: reviewed aaa onto bbb, candidate merges aaa onto ccc", fact: factOf() }).kind, "moved_base");
  assert.equal(failureCategory({ reason: gateReason("diagnostics", "Error: Candidate or integration parent moved during verification"), fact: factOf() }).kind, "moved_base");
});
