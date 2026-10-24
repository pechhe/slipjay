import assert from "node:assert/strict";
import { test } from "bun:test";
import { chooseFiles, mergeJunitReports, mergeVitestReports, repositoryKeyFromRemote, runtimeFiles } from "./test-file-cost.ts";
import { parseTestReport } from "../src/lib/runner/test-reports.ts";

test("reads the repository key from each remote form the runner checks out with", () => {
  assert.equal(repositoryKeyFromRemote("git@github.com:pechhe/slipjay.git"), "pechhe/slipjay");
  assert.equal(repositoryKeyFromRemote("ssh://git@github.com/pechhe/slipjay.git"), "pechhe/slipjay");
  assert.equal(repositoryKeyFromRemote("https://github.com/pechhe/slipjay"), "pechhe/slipjay");
  assert.equal(repositoryKeyFromRemote("https://github.com/pechhe/slipjay.git"), "pechhe/slipjay");
  assert.equal(repositoryKeyFromRemote("git@host.example:owner/name"), "owner/name");
  assert.equal(repositoryKeyFromRemote("/srv/git/repo.git"), null);
  assert.equal(repositoryKeyFromRemote(""), null);
});

test("measures the metrics' cost candidates first, then its flags and slowest, never twice and never a path the checkout lacks", () => {
  const exists = (file: string) => file !== "tests/gone.test.ts";
  const metrics = {
    costCandidates: [
      { file: "tests/slowest.test.ts", suite: "vitest", samples: 12, medianMs: 74_000 },
      { file: "tests/gone.test.ts", suite: "vitest", samples: 6, medianMs: 40_000 },
    ],
    testFilesOverBudget: [{ file: "tests/already-costed.test.ts", suite: "file-cost", samples: 6, medianMs: 31_000 }],
    slowestTestFiles: [
      { file: "tests/slowest.test.ts", suite: "vitest", samples: 12, medianMs: 74_000 },
      { file: "scripts/housekeeping.test.ts", suite: "runtimes", samples: 8, medianMs: 60_000 },
      { file: "src/not-a-test.test.ts", suite: "vitest", samples: 9, medianMs: 50_000 },
      { file: "tests/third.test.ts", suite: "vitest", samples: 9, medianMs: 45_000 },
    ],
  };
  assert.deepEqual(chooseFiles(metrics, exists), ["tests/slowest.test.ts", "scripts/housekeeping.test.ts", "tests/third.test.ts"]);
  assert.deepEqual(chooseFiles(metrics, exists, 2), ["tests/slowest.test.ts", "scripts/housekeeping.test.ts"]);
  assert.deepEqual(chooseFiles(undefined, exists), []);
  // A landing or audit row the old CLI reported over budget is still a candidate: the fallback must not be dead.
  assert.deepEqual(chooseFiles({ testFilesOverBudget: [{ file: "tests/legacy.test.ts", suite: "vitest", samples: 9, medianMs: 44_000 }] }, exists), ["tests/legacy.test.ts"]);
});

test("takes every cost candidate the metrics name, up to the run's own cap", () => {
  const exists = () => true;
  const candidates = Array.from({ length: 45 }, (_, index) => ({ file: `tests/slow-${String(index).padStart(2, "0")}.test.ts`, suite: "vitest", samples: 9, medianMs: 40_000 - index * 10 }));
  const chosen = chooseFiles({ costCandidates: candidates }, exists);
  assert.equal(chosen.length, 40, "the default cap is the run's, not the metrics' ten-row listing");
  assert.deepEqual(chosen.slice(0, 11).map((file) => file.endsWith("slow-10.test.ts")), [false, false, false, false, false, false, false, false, false, false, true], "more than ten can be selected");
  assert.equal(chooseFiles({ costCandidates: candidates }, exists, 45).length, 45);
});

test("finds the runtime lane the checkout declares, and only its Bun test files", () => {
  assert.deepEqual(runtimeFiles({ scripts: { "test:runtimes": "bun test scripts/a.test.ts scripts/b.test.ts" } }), ["scripts/a.test.ts", "scripts/b.test.ts"]);
  assert.deepEqual(runtimeFiles({ scripts: { "test:runtimes": "bun test tests/not-runtime.test.ts" } }), []);
  assert.deepEqual(runtimeFiles({}), []);
});

test("merges every runtime file's JUnit suites, nested ones included, so an earlier measured file is never lost", () => {
  const wrapped = '<?xml version="1.0"?><testsuites><testsuite file="scripts/a.test.ts" tests="2" failures="0">'
    + '<testsuite name="nested" file="scripts/a.test.ts" tests="1" failures="1"></testsuite></testsuite></testsuites>';
  const bare = '<testsuite file="scripts/b.test.ts" tests="1" failures="0"><testcase name="b" time="0.5"/></testsuite>';
  const merged = mergeJunitReports([wrapped, bare]);
  assert.match(merged, /scripts\/a\.test\.ts/);
  assert.match(merged, /scripts\/b\.test\.ts/);
  assert.match(merged, /<testsuite name="nested"/);
  // The real parser is the judge: a truncated or unclosed suite is a malformed report, not a short one.
  assert.deepEqual(parseTestReport(merged, "bun-junit").map((file) => [file.file, file.status]), [["scripts/a.test.ts", "passed"], ["scripts/b.test.ts", "passed"]]);
  assert.throws(() => mergeJunitReports(["<testsuites></testsuites>"]), /no testsuite/);
});

test("merges measured runs into one report, and refuses a run that wrote no results", () => {
  const report = (name: string) => JSON.stringify({ testResults: [{ name, startTime: 0, endTime: 10, status: "passed" }] });
  const merged = JSON.parse(mergeVitestReports([report("a.test.ts"), report("b.test.ts")])) as { testResults: { name: string }[] };
  assert.deepEqual(merged.testResults.map((file) => file.name), ["a.test.ts", "b.test.ts"]);
  assert.throws(() => mergeVitestReports([JSON.stringify({})]), /no testResults/);
});
