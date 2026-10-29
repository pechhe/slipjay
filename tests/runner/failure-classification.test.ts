import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { classifyFailure, classifyVerificationFailures, FAILURE_COMMAND_PATTERNS, FAILURE_RULE_VERSION, parseFailureOutput } from "../../src/lib/runner/failure-classification.ts";
import { OWNER_KILL_REASON } from "../../src/lib/runner/runner-contract.ts";
import type { OperationEvent, VerificationFailureRef } from "../../src/lib/runner/runner-types.ts";

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
  assert.equal(FAILURE_RULE_VERSION, 2);
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
  assert.equal(fact.ruleVersion, 2);
  assert.equal(fact.checks?.[0]?.firstErrors?.length, 1, "the run's and the output's pairing of one test count once");
  assert.deepEqual(fact.checks?.[1]?.failureCauses, ["lint: 3 errors"]);
  assert.deepEqual(fact.failureCauses, ["core typecheck: src/a.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.", "lint: 3 errors"]);
  assert.equal(fact.firstErrors?.[0]?.error, "AssertionError: expected 1 to be 2");
});
