import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { summarizeVerificationFailure, verificationDiagnosticCollector } from "../../src/lib/infra/verification-failure.ts";

const section = (summary: string, heading: string) => {
  const lines = summary.split("\n");
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) return [];
  const end = lines.findIndex((line, index) => index > start && !line.startsWith("  "));
  return lines.slice(start + 1, end < 0 ? undefined : end).map((line) => line.trim());
};

test("a Vitest failure names the failing test and its first error despite trailing fixture noise", () => {
  const noise = Array.from({ length: 80 }, (_, index) => `Working copy  (@) now at: vusruknq ${index} Issue #830`);
  const summary = summarizeVerificationFailure({
    code: 1,
    stdout: [
      "landing-integration-tests: related, 12 of 67 files",
      ...Array.from({ length: 12 }, (_, index) => `  apps/desktop/tests/unit/file-${index}.test.ts`),
      " RUN  v4.1.11 /work/apps/desktop",
      " \u001b[31m❯\u001b[39m tests/unit/migration.test.ts (4 tests | 1 failed) 11390ms",
      "   × rolls generated artifacts back 2850ms",
      " Test Files  1 failed | 66 passed (67)",
      "      Tests  1 failed | 628 passed | 1 skipped (630)",
    ].join("\n"),
    stderr: [
      "(node:1) ExperimentalWarning: SQLite is experimental",
      ...noise,
      "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
      " FAIL  tests/unit/migration.test.ts > rolls generated artifacts back",
      "AssertionError: The input did not match the regular expression /exited with code 23/. Input:",
      "'Error: jj op restore failed: Internal error'",
      " ❯ tests/unit/migration.test.ts:114:5",
      "    114|     await assert.rejects(landWorkspace(created.workspacePath), /Migrat…",
      "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯",
    ].join("\n"),
  });
  assert.match(summary, /^Failure: assertion$/m);
  assert.deepEqual(section(summary, "Failing tests"), ["tests/unit/migration.test.ts > rolls generated artifacts back"]);
  assert.deepEqual(section(summary, "First error"), [
    "AssertionError: The input did not match the regular expression /exited with code 23/. Input:",
    "'Error: jj op restore failed: Internal error'",
  ]);
  assert.ok(section(summary, "Output tail").length <= 30);
  assert.ok(!summary.includes("\u001b["));
  assert.ok(!summary.includes("ExperimentalWarning"));
});

test("a Vitest timeout is reported as a timeout", () => {
  const summary = summarizeVerificationFailure({
    code: 1,
    stdout: " Test Files  1 failed (1)\n      Tests  1 failed (1)",
    stderr: [
      " FAIL  tests/b.test.ts > slow",
      "Error: Test timed out in 50ms.",
      "If this is a long-running test, pass a timeout value as the last argument.",
      " ❯ tests/b.test.ts:3:1",
    ].join("\n"),
  });
  assert.match(summary, /^Failure: timeout$/m);
  assert.deepEqual(section(summary, "Failing tests"), ["tests/b.test.ts > slow"]);
  assert.equal(section(summary, "First error")[0], "Error: Test timed out in 50ms.");
});

test("a Bun test failure names each failing test with its file", () => {
  const summary = summarizeVerificationFailure({
    code: 1,
    stdout: "bun test v1.4.2",
    stderr: [
      "a.test.ts:",
      "2 | test(\"adds\", () => { expect(1).toBe(2); });",
      "error: expect(received).toBe(expected)",
      "",
      "Expected: 2",
      "Received: 1",
      "      at <anonymous> (/tmp/a.test.ts:2:32)",
      "(fail) adds [0.33ms]",
      "(fail) slow [51.05ms]",
      "  ^ this test timed out after 50ms.",
      " 0 pass",
      " 2 fail",
    ].join("\n"),
  });
  assert.deepEqual(section(summary, "Failing tests"), ["a.test.ts > adds", "a.test.ts > slow"]);
  assert.deepEqual(section(summary, "First error"), ["error: expect(received).toBe(expected)", "Expected: 2", "Received: 1"]);
  assert.match(summary, /^Failure: timeout and assertion$/m);
});

test("a node:test TAP failure names the test with its location", () => {
  const summary = summarizeVerificationFailure({
    code: 1,
    stdout: [
      "# Subtest: adds",
      "not ok 1 - adds",
      "  ---",
      "  location: '/work/scripts/n.test.mjs:2:1'",
      "  error: |-",
      "    Expected values to be strictly equal:",
      "    1 !== 2",
      "  code: 'ERR_ASSERTION'",
      "# fail 1",
    ].join("\n"),
  });
  assert.deepEqual(section(summary, "Failing tests"), ["/work/scripts/n.test.mjs > adds"]);
  assert.deepEqual(section(summary, "First error"), ["error: |-", "Expected values to be strictly equal:", "1 !== 2"]);
  assert.match(summary, /^Failure: assertion$/m);
});

test("typecheck and lint failures report their first diagnostics", () => {
  const typecheck = summarizeVerificationFailure({
    code: 2,
    stdout: [
      "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "/work/src/View.svelte:5:3",
      "Error: Property 'x' does not exist on type 'Props'. (ts)",
    ].join("\n"),
    stderr: "error: script \"typecheck\" exited with code 2",
  });
  assert.match(typecheck, /^Failure: diagnostics$/m);
  assert.deepEqual(section(typecheck, "First diagnostics"), [
    "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "/work/src/View.svelte:5:3 Error: Property 'x' does not exist on type 'Props'. (ts)",
  ]);
  assert.equal(section(typecheck, "First error").length, 0);

  const lint = summarizeVerificationFailure({
    code: 1,
    stdout: "src/b.ts:2:5: error eslint(no-unused-vars): Variable 'unused' is declared but never used.\nFound 0 warnings and 1 error.",
  });
  assert.deepEqual(section(lint, "First diagnostics"), [
    "src/b.ts:2:5: error eslint(no-unused-vars): Variable 'unused' is declared but never used.",
  ]);
});

test("the summary stays bounded for huge outputs", () => {
  const failures = Array.from({ length: 500 }, (_, index) => ` FAIL  tests/t${index}.test.ts > case ${"x".repeat(1000)}`);
  const summary = summarizeVerificationFailure({ code: 1, stderr: [...failures, "Error: boom"].join("\n") });
  assert.ok(summary.length <= 6_000);
  assert.match(summary, /Failing tests \(500\):/);
  assert.match(summary, /… 490 more/);
});

test("SIGTERM alone does not diagnose a timeout", () => {
  assert.match(summarizeVerificationFailure({ signal: "SIGTERM", stderr: "stopped externally" }), /^Failure: error \(signal SIGTERM\)$/m);
  assert.match(summarizeVerificationFailure({ signal: "SIGTERM", timedOut: true }), /^Failure: timeout \(signal SIGTERM\)$/m);
});

test("streaming diagnostic selection redacts split secrets, skips private keys and retains nearby file context", () => {
  const collector = verificationDiagnosticCollector();
  const secret = "ghp_" + "q".repeat(30);
  for (const part of ["noise\nsrc/View.svelte:4:2\nError: Authorization: Bear", `er ${secret.slice(0, 10)}`, `${secret.slice(10)}\n`,
    "-----BEGIN PRIVATE KEY-----\nError: private material\n-----END PRIVATE KEY-----\n",
    "Error: useful ünicode diagnostic\n"]) collector.add(Buffer.from(part));
  const result = collector.finish();
  assert.match(result.output, /src\/View.svelte:4:2\nError: Authorization: Bearer \[REDACTED\]/);
  assert.match(result.output, /useful ünicode diagnostic/);
  assert.ok(!result.output.includes(secret));
  assert.ok(!result.output.includes("private material"));
  assert.equal(result.incomplete, true);
});

test("diagnostic selection bounds oversized lines and reports exhausted capacity", () => {
  const collector = verificationDiagnosticCollector();
  collector.add(Buffer.from(`Error: SECRET_TOKEN=${"x".repeat(20_000)}\nError: retained afterwards\n`));
  for (let i = 0; i < 1000; i++) collector.add(Buffer.from(`Error: distinct diagnostic ${i}\n`));
  const result = collector.finish();
  assert.ok(Buffer.byteLength(result.output) <= 16_384);
  assert.ok(!result.output.includes("SECRET_TOKEN"));
  assert.match(result.output, /retained afterwards/);
  assert.equal(result.incomplete, true);
});

test("streaming selection preserves a Bun filename across source and progress noise", () => {
  const collector = verificationDiagnosticCollector();
  collector.add(Buffer.from(`tests/bun.test.ts:\n${"source context\\n".repeat(40)}\n(fail) rejects stale source [0.3ms]\n`));
  const summary = summarizeVerificationFailure({ stderr: collector.finish().output, code: 1 });
  assert.deepEqual(section(summary, "Failing tests"), ["tests/bun.test.ts > rejects stale source"]);
});
