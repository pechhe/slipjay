import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import type { BoundedProcessResult } from "../../src/lib/infra/bounded-process.ts";
import { prepareWorkspaceDependencies } from "../../src/lib/workspace/workspace-dependencies.ts";

const missing = 'error: No version matching "1.0.1" found for specifier "sj89-fixture" (but package exists)';
const result = (stderr = "", overrides: Partial<BoundedProcessResult> = {}): BoundedProcessResult => ({
  exitCode: stderr ? 1 : 0, stdout: "", stderr, signal: null, timedOut: false, cancelled: false,
  stdoutTruncated: false, stderrTruncated: false, finishedAt: new Date().toISOString(), outputSha256: "fixture", ...overrides,
});
async function fixture(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "sj89-recovery-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "bun@1.4.3", dependencies: { "sj89-fixture": "1.0.1" } }));
    await writeFile(join(root, "bun.lock"), '{"packages":{"sj89-fixture":["sj89-fixture@1.0.1", "", {}]}}');
    await work(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("exact locked Bun resolution failure gets one frozen manifest refresh and retains both attempts", () => fixture(async (root) => {
  const commands: string[][] = [];
  const before = await readFile(join(root, "bun.lock"), "utf8");
  const ready = await prepareWorkspaceDependencies(root, { quiet: true, runCommand: async (request) => {
    assert.equal(request.cwd, root);
    commands.push([...request.args]);
    return result(commands.length === 1 ? missing : "");
  } });
  assert.equal(ready.state, "ready");
  assert.deepEqual(commands, [
    ["install", "--frozen-lockfile", "--prefer-offline", "--backend=clonefile"],
    ["install", "--frozen-lockfile", "--no-cache", "--backend=clonefile"],
  ]);
  assert.deepEqual(ready.installAttempts?.map((attempt) => attempt.outcome), ["nonzero_exit", "success"]);
  assert.match(String(ready.installAttempts?.[0]?.stderr), /No version matching/);
  assert.equal(await readFile(join(root, "bun.lock"), "utf8"), before);
}));

test("coloured Bun diagnostics still recover the exact locked version", () => fixture(async (root) => {
  let calls = 0;
  const ready = await prepareWorkspaceDependencies(root, { quiet: true, runCommand: async () =>
    result(++calls === 1 ? `\u001b[31merror\u001b[0m: ${missing.slice(7)}` : "") });
  assert.equal(ready.state, "ready");
  assert.equal(calls, 2);
}));

test("an absent locked version fails after the bounded recovery with both diagnostics", () => fixture(async (root) => {
  let calls = 0;
  await assert.rejects(prepareWorkspaceDependencies(root, { quiet: true, runCommand: async () => {
    calls++;
    return result(missing);
  } }), (error: unknown) => {
    const failure = error as Error & { evidence: { installAttempts: Record<string, unknown>[] } };
    assert.equal(failure.evidence.installAttempts.length, 2);
    assert.ok(failure.evidence.installAttempts.every((attempt) => String(attempt.stderr).includes(missing)));
    assert.match(failure.message, /No version matching/);
    return true;
  });
  assert.equal(calls, 2);
}));

for (const [name, failure] of Object.entries({
  unrelated: result("error: lifecycle script failed"),
  range: result(missing.replace('"1.0.1"', '"^1.0.1"')),
  unpinned: result(missing.replace('"1.0.1"', '"1.0.2"')),
  cancelled: result(missing, { cancelled: true }),
  signalled: result(missing, { signal: "SIGTERM" }),
  timeout: result(missing, { timedOut: true }),
  spawn: result(missing, { error: "executor unavailable" }),
})) test(`${name} install failure is never retried`, () => fixture(async (root) => {
  let calls = 0;
  await assert.rejects(prepareWorkspaceDependencies(root, { quiet: true, runCommand: async () => { calls++; return failure; } }));
  assert.equal(calls, 1);
}));
