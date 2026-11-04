import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { parseExecutionPolicy } from "../../src/lib/policy/execution-policy.ts";

const policy = (extra: Record<string, unknown>) => JSON.stringify({ version: 1, integrationBranch: "develop", requiredLandingVerification: [], releaseBranch: "master", requiredReleaseVerification: [], ...extra });

test("batch verification is opt-in per repository, names its machine pool, and needs a release branch", () => {
  assert.equal(parseExecutionPolicy(policy({})).batchVerification, undefined);
  assert.deepEqual(parseExecutionPolicy(policy({ batchVerification: { machine: "release-check" } })).batchVerification, { machine: "release-check" });
  assert.throws(() => parseExecutionPolicy(policy({ batchVerification: { machine: "0" } })), /machine pool name/);
  assert.throws(() => parseExecutionPolicy(policy({ batchVerification: { machine: "batch", every: 5 } })), /unknown fields: every/);
  assert.throws(() => parseExecutionPolicy(JSON.stringify({ version: 1, requiredLandingVerification: [], batchVerification: { machine: "batch" } })), /without a releaseBranch/);
});
