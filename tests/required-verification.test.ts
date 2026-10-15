import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { RequiredVerificationError, runRequiredVerification } from "../src/lib/required-verification.ts";

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
