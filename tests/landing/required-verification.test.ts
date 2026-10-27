import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { RequiredVerificationError, runRequiredVerification } from "../../src/lib/landing/required-verification.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "../../src/lib/infra/bounded-process.ts";

/** A check that records the directory it ran in. */
const recordCwd = (marker: string) => ({ executable: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.cwd())`] });

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "peach-required-verification-")));
  const root = path.join(base, "checkout");
  const outside = path.join(base, "outside");
  await mkdir(path.join(root, "packages", "app"), { recursive: true });
  await mkdir(outside);
  await symlink(outside, path.join(root, "escape"));
  const marker = path.join(base, "ran-in.txt");
  const run = (checks: object[]) => runRequiredVerification({ root, checks });
  return { root, marker, run, dispose: () => rm(base, { recursive: true, force: true }) };
}

test("a check runs in its declared relative cwd inside the checkout", async () => {
  const f = await fixture();
  try {
    await f.run([{ ...recordCwd(f.marker), cwd: "packages/app" }]);
    assert.equal(await readFile(f.marker, "utf8"), path.join(f.root, "packages", "app"));
  } finally { await f.dispose(); }
});

test("a check whose cwd is a symlink out of the checkout is refused before it runs", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run([{ ...recordCwd(f.marker), cwd: "escape" }]),
      /Required verification check 1 cwd "escape" resolves outside the checkout/);
    await assert.rejects(readFile(f.marker, "utf8"), { code: "ENOENT" });
  } finally { await f.dispose(); }
});

test("a capability probe whose cwd is a symlink out of the checkout is refused before it runs", async () => {
  const f = await fixture();
  try {
    const capability = { id: "fixture", probe: { ...recordCwd(f.marker), cwd: "escape" }, onUnavailable: "continue", unavailableExitCodes: [19], unavailableStderrIncludes: ["unavailable"] };
    await assert.rejects(f.run([{ executable: process.execPath, args: ["-e", ""], capability }]),
      /Required verification check 1 capability probe fixture cwd "escape" resolves outside the checkout/);
    await assert.rejects(readFile(f.marker, "utf8"), { code: "ENOENT" });
  } finally { await f.dispose(); }
});

test("a nested noisy check retains middle diagnostics before both output edges are dropped", async () => {
  const f = await fixture();
  try {
    const child = `const fs=require('node:fs'); const noise='ordinary progress\\n'.repeat(7000);
      fs.writeSync(2,noise); fs.writeSync(2,' FAIL tests/hidden.test.ts > rejects stale source\\nAssertionError: stale source was accepted\\n ❯ tests/hidden.test.ts:27:3\\n');
      fs.writeSync(2,noise); process.exitCode=1;`;
    const wrapper = `require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'}); process.exitCode=1;`;
    await assert.rejects(f.run([{ executable: process.execPath, args: ["-e", wrapper] }]), (error: unknown) => {
      assert.ok(error instanceof RequiredVerificationError);
      const summary = error.message.split("\n").slice(1).join("\n");
      assert.match(summary, /tests\/hidden.test.ts > rejects stale source/);
      assert.match(summary, /AssertionError: stale source was accepted/);
      assert.match(summary, /tests\/hidden.test.ts:27:3/);
      assert.equal(error.evidence.diagnosticCapture, "selected");
      assert.equal(error.evidence.stderrTailTruncated, true);
      assert.ok(!error.evidence.stderrTail.includes("hidden.test.ts"), "the raw tail alone cannot explain this failure");
      return true;
    });
  } finally { await f.dispose(); }
});

test("an executor without streaming diagnostics reports capture unavailable", async () => {
  const f = await fixture();
  try {
    await assert.rejects(runRequiredVerification({ root: f.root, checks: [{ executable: "node", args: ["check.js"] }],
      run: async () => ({ stdout: "", stderr: "wrapper exited 1", stdoutTruncated: false, stderrTruncated: true,
        exitCode: 1, signal: null, timedOut: false, cancelled: false, outputSha256: "fixture", finishedAt: new Date().toISOString() }),
    }), (error: unknown) => {
      assert.ok(error instanceof RequiredVerificationError);
      assert.equal(error.evidence.diagnosticCapture, "unavailable");
      assert.match(error.message, /Diagnostic capture: unavailable/);
      return true;
    });
  } finally { await f.dispose(); }
});

type FakeResult = Partial<BoundedProcessResult>;
const result = (over: FakeResult = {}): BoundedProcessResult => ({ stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
  exitCode: 0, signal: null, timedOut: false, cancelled: false, outputSha256: "fixture", finishedAt: new Date().toISOString(), ...over });
const failing = (name: string, extra: FakeResult = {}) => result({ exitCode: 1, stderr: `FAIL tests/${name}.test.ts > ${name} breaks\nAssertionError: ${name}\n`, ...extra });

/** Checks are `node <name>`; `outcomes` maps a name to its result, in call order for duplicates. */
function scripted(outcomes: Record<string, FakeResult[]>) {
  const started: string[] = [];
  let runs = 0;
  const run = async (request: BoundedProcessRequest) => {
    const name = request.args[0]!;
    started.push(name);
    const next = outcomes[name]?.shift() ?? {};
    return result({ ...next, runId: `run-${++runs}` });
  };
  return { started, run };
}
const decl = (name: string, extra: object = {}) => ({ executable: "node", args: [name], ...extra });

async function failedWith(checks: object[], run: (request: BoundedProcessRequest) => Promise<BoundedProcessResult>, extra: object = {}) {
  const f = await fixture();
  try {
    return await runRequiredVerification({ root: f.root, checks, run, ...extra }).then(() => assert.fail("expected a failure"), (error: unknown) => {
      assert.ok(error instanceof RequiredVerificationError);
      return error;
    });
  } finally { await f.dispose(); }
}

test("two sequential failures and a later pass are all reported with an index", async () => {
  const s = scripted({ a: [failing("a")], b: [failing("b")], c: [{}] });
  const error = await failedWith([decl("a"), decl("b"), decl("c")], s.run);
  assert.deepEqual(s.started, ["a", "b", "c"]);
  assert.deepEqual(error.evidence.failures.map((failure) => failure.checkIndex), [0, 1]);
  assert.deepEqual(error.evidence.failures.map((failure) => failure.runId), ["run-1", "run-2"]);
  assert.equal(error.evidence.checkIndex, 0);
  assert.equal(error.evidence.runId, "run-1");
  assert.deepEqual(error.evidence.checks.map((check) => check.outcome), ["failed", "failed", "passed"]);
  assert.equal(error.evidence.checks[0]!.failingTests, 1);
  assert.match(error.message, /^Required verification failed \(nonzero_exit\): node a \(check 1\)\nChecks:\n1\. node a: failed \(1 failing test\)\n2\. node b: failed \(1 failing test\)\n3\. node c: passed\n/);
  assert.match(error.message, /Check 1 \(node a\):[\s\S]*tests\/a\.test\.ts[\s\S]*Check 2 \(node b\):[\s\S]*tests\/b\.test\.ts/);
});

test("stopOnFailure stops later stages after concurrent siblings settle and marks them not run", async () => {
  const s = scripted({ install: [failing("install")], one: [failing("one")], two: [{}] });
  const error = await failedWith([decl("install"), decl("one", { concurrent: true, stopOnFailure: true }), decl("two", { concurrent: true }), decl("later")], s.run);
  assert.equal(s.started[0], "install");
  assert.deepEqual([...s.started].sort(), ["install", "one", "two"]);
  assert.deepEqual(error.evidence.checks.map((check) => check.outcome), ["failed", "failed", "passed", "not_run"]);
  assert.equal(error.evidence.checks[3]!.command, "node later");
  assert.match(error.message, /4\. node later: not run/);
});

test("once the abort signal fires, a check that came back signalled is followed by no other", async () => {
  const controller = new AbortController();
  const s = scripted({ one: [{}], two: [failing("two", { exitCode: null, signal: "SIGKILL" })], three: [{}] });
  const run = async (request: BoundedProcessRequest) => {
    if (request.args[0] === "two") controller.abort();
    return s.run(request);
  };
  const error = await failedWith([decl("one"), decl("two"), decl("three")], run, { abortSignal: controller.signal });
  assert.deepEqual(s.started, ["one", "two"]);
  assert.deepEqual(error.evidence.checks.map((check) => check.outcome), ["passed", "failed", "not_run"]);
});

test("a stopOnFailure check that passes does not stop later checks", async () => {
  const s = scripted({ install: [{}], a: [failing("a")] });
  await failedWith([decl("install", { stopOnFailure: true }), decl("a")], s.run);
  assert.deepEqual(s.started, ["install", "a"]);
});

test("two concurrent failures are reported in declaration order", async () => {
  const s = scripted({ slow: [failing("slow")], fast: [failing("fast")] });
  const error = await failedWith([decl("slow", { concurrent: true }), decl("fast", { concurrent: true })], s.run);
  assert.deepEqual(error.evidence.failures.map((failure) => failure.command), ["node slow", "node fast"]);
});

test("the same command declared twice keeps a distinct runId for each failure", async () => {
  const s = scripted({ same: [failing("same"), failing("same")] });
  const error = await failedWith([decl("same"), decl("same")], s.run);
  assert.deepEqual(error.evidence.failures.map((failure) => failure.runId), ["run-1", "run-2"]);
  assert.deepEqual(error.evidence.checks.map((check) => check.runId), ["run-1", "run-2"]);
});

test("a failure outside the runner carries no runId", async () => {
  const error = await failedWith([decl("a")], async () => failing("a"));
  assert.equal(error.evidence.runId, undefined);
  assert.equal("runId" in error.evidence.failures[0]!, false);
});

test("a timeout aggregates with the other failures", async () => {
  const s = scripted({ slow: [{ exitCode: null, timedOut: true, signal: "SIGKILL" }], b: [failing("b")] });
  const error = await failedWith([decl("slow"), decl("b")], s.run);
  assert.deepEqual(error.evidence.checks.map((check) => check.outcome), ["timed_out", "failed"]);
  assert.equal(error.evidence.failures[0]!.outcome, "timeout");
});

test("a baseline-accepted failure and a capability gap are not failures", async () => {
  const s = scripted({ base: [failing("base")], a: [failing("a")], cap: [{}] });
  const capability = { id: "gap", probe: { executable: "node", args: ["probe"] }, onUnavailable: "continue", unavailableExitCodes: [19], unavailableStderrIncludes: ["unavailable"] };
  const run = async (request: BoundedProcessRequest) => request.args[0] === "probe"
    ? result({ exitCode: 19, stderr: "unavailable" }) : s.run(request);
  const error = await failedWith([decl("base"), decl("cap", { capability }), decl("a")], run,
    { acceptFailure: async (check: { args: string[] }) => check.args[0] === "base" ? "node base" : null });
  assert.deepEqual(error.evidence.checks.map((check) => check.outcome), ["accepted_by_baseline", "capability_unavailable", "failed"]);
  assert.deepEqual(error.evidence.failures.map((failure) => failure.checkIndex), [2]);
  assert.match(error.message, /1\. node base: accepted by baseline\n2\. node cap: capability unavailable/);
});

test("a cancelled check ends verification at once without running later checks", async () => {
  const s = scripted({ a: [failing("a")], b: [{ exitCode: null, cancelled: true, signal: "SIGTERM" }], c: [{}] });
  const error = await failedWith([decl("a"), decl("b"), decl("c")], s.run);
  assert.deepEqual(s.started, ["a", "b"]);
  assert.equal(error.evidence.outcome, "cancelled");
  assert.equal(error.evidence.failures.length, 1);
});

test("a spawn failure ends verification at once", async () => {
  const s = scripted({ a: [{ exitCode: null, error: "spawn ENOENT" }], b: [{}] });
  const error = await failedWith([decl("a"), decl("b")], s.run);
  assert.deepEqual(s.started, ["a"]);
  assert.equal(error.evidence.outcome, "spawn_failure");
});

test("the reason stays within the cap and says how much it omitted, while the evidence stays complete", async () => {
  const names = Array.from({ length: 40 }, (_, index) => `check${index}`);
  const s = scripted(Object.fromEntries(names.map((name) => [name, [failing(name, { stderr: `${`${"n".repeat(200)}\n`.repeat(400)}FAIL tests/${name}.test.ts > x\n` })]])));
  const error = await failedWith(names.map((name) => decl(name)), s.run);
  assert.ok(error.message.length <= 24_000, `${error.message.length}`);
  assert.match(error.message, /omitted \d+ failure summaries/);
  assert.equal(error.evidence.failures.length, 40);
  assert.equal(error.evidence.checks.length, 40);
});

test("when even the index cannot fit, later index lines are omitted too", async () => {
  const names = Array.from({ length: 300 }, (_, index) => `check${index}`);
  const long = "x".repeat(200);
  const s = scripted(Object.fromEntries(names.map((name) => [name, [failing(name)]])));
  const error = await failedWith(names.map((name) => ({ executable: "node", args: [name, long] })), s.run);
  assert.ok(error.message.length <= 24_000);
  assert.match(error.message, /index lines/);
});

test("an invalid stopOnFailure value is refused before anything runs", async () => {
  const s = scripted({});
  const f = await fixture();
  try {
    await assert.rejects(runRequiredVerification({ root: f.root, checks: [decl("a", { stopOnFailure: "yes" })], run: s.run }), /Malformed requiredLandingVerification command/);
    assert.deepEqual(s.started, []);
  } finally { await f.dispose(); }
});

test("a passing run reports passed commands unchanged", async () => {
  const s = scripted({});
  const f = await fixture();
  try {
    const evidence = await runRequiredVerification({ root: f.root, checks: [decl("a"), decl("b", { stopOnFailure: true })], run: s.run });
    assert.deepEqual(evidence.passed, ["node a", "node b"]);
    assert.equal(evidence.status, "passed");
  } finally { await f.dispose(); }
});
