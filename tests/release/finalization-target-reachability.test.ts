import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vite-plus/test";
import type { PostIntegrationResult } from "../../src/lib/release/post-integration-finalization.ts";

const seams = vi.hoisted(() => ({
  previous: null as PostIntegrationResult | null,
  readPolicy: vi.fn(), source: vi.fn(), writes: [] as Record<string, unknown>[],
}));
vi.mock("../../src/lib/release/post-integration-source.ts", () => ({
  SourcePreparationFailure: class extends Error {},
  readPostIntegrationPolicy: (...args: unknown[]) => seams.readPolicy(...args),
  withFinalizationSource: (...args: unknown[]) => seams.source(...args),
}));
vi.mock("../../src/lib/release/post-integration-coverage.ts", () => ({
  HistoricalMigrationFailure: class extends Error {},
  artifactKey: () => "identity", receiptPath: (directory: string) => join(directory, "receipt.json"), targetKeyOf: () => "target",
  readState: async () => seams.previous, coveredByCompletedAncestor: async () => null,
  historicalMigrationTip: async () => {}, writeTargetOutcome: async () => {},
  isAncestor: async () => false, verifyHistoricalMigrationSpan: async () => {},
}));
vi.mock("../../src/lib/infra/workspace-transaction.ts", () => ({
  writeWorkspaceJson: async (_file: string, value: Record<string, unknown>) => { seams.writes.push(value); },
}));
vi.mock("../../src/lib/infra/checkout-cwd.ts", () => ({ checkoutCwd: async (root: string) => root }));
import { finalizePostIntegration } from "../../src/lib/release/post-integration-finalization.ts";
import { postIntegrationPolicyDigest } from "../../src/lib/policy/post-integration-policy.ts";

const commit = "a".repeat(40);
const command = { executable: "step", args: [], cwd: "." };
const policy = { version: 1 as const, target: "development-db", idempotency: "artifact-key" as const,
  command, targetProbe: { ...command, executable: "probe" }, timeoutMs: 1000, environmentKeys: [],
  approvalMode: "automatic-development" as const, readByGate: true };
const success = (stdout = "") => ({ exitCode: 0, stdout, stderr: "", stdoutTruncated: false, stderrTruncated: false, timedOut: false, cancelled: false, signal: null, outputSha256: "fixture", finishedAt: new Date().toISOString() });
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  seams.previous = null; seams.writes = [];
  seams.readPolicy.mockReset().mockResolvedValue({ gitDirectory: "/git", policy });
  seams.source.mockReset().mockImplementation(async (_git, _commit, body) => body("/exact"));
  const stateDirectory = await mkdtemp(join(tmpdir(), "reachability-")); directories.push(stateDirectory);
  let reached = false;
  const calls: string[] = [];
  const input = { gitDirectory: "/git", integratedCommitSha: commit, stateDirectory,
    readIntegrationTip: async () => commit, onTargetReached: () => { reached = true; },
    runCommand: async (request: { executable: string }) => {
      calls.push(request.executable);
      if (request.executable === "step") assert.equal(seams.writes.at(-1)?.targetReached, true, "persisted before spawn");
      return request.executable === "probe" ? success(JSON.stringify({ target: policy.target })) : { ...success(), exitCode: 3 };
    } };
  return { input, calls, reached: () => reached };
}

test("policy and exact-source failures before a command leave the target unreached", async () => {
  const f = await fixture();
  seams.readPolicy.mockRejectedValueOnce(new Error("Invalid reset identity, deadline or interval"));
  await assert.rejects(finalizePostIntegration(f.input), /Invalid reset/);
  assert.equal(f.reached(), false); assert.deepEqual(f.calls, []);
  seams.source.mockRejectedValueOnce(new Error("source unavailable"));
  const failed = await finalizePostIntegration(f.input);
  assert.equal(failed.targetReached, false); assert.equal(f.reached(), false); assert.deepEqual(f.calls, []);
});

test("a failed target probe never starts the finalization command", async () => {
  const f = await fixture();
  const result = await finalizePostIntegration({ ...f.input, runCommand: async () => ({ ...success(), exitCode: 2 }) });
  assert.equal(result.status, "failed"); assert.equal(result.targetReached, false); assert.equal(f.reached(), false);
});

test("a failed command records reached before spawn and preserves it through the failure receipt", async () => {
  const f = await fixture();
  const result = await finalizePostIntegration(f.input);
  assert.equal(result.status, "failed"); assert.equal(result.targetReached, true); assert.equal(f.reached(), true);
  assert.deepEqual(f.calls, ["probe", "step"]);
  assert.equal(seams.writes.at(-1)?.targetReached, true);
});

test("an earlier reached or unknown attempt stays reached even when this retry fails in the probe", async () => {
  for (const targetReached of [true, undefined]) {
    const f = await fixture();
    seams.previous = { ok: false, sourceIntegrated: true, status: "failed", attempt: 1, integratedCommitSha: commit,
      target: policy.target, policyDigest: postIntegrationPolicyDigest(policy), idempotencyKey: "identity", targetReached };
    const result = await finalizePostIntegration({ ...f.input, runCommand: async () => ({ ...success(), exitCode: 2 }) });
    assert.equal(result.targetReached, true); assert.equal(f.reached(), true);
  }
});
