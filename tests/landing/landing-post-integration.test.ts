import { project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createHash } from "node:crypto";
import { finalizePostIntegration } from "../../src/lib/release/post-integration-finalization.ts";
import { postIntegrationPolicyDigest } from "../../src/lib/policy/post-integration-policy.ts";
import { readPostIntegrationPolicy } from "../../src/lib/release/post-integration-source.ts";

// Finalization and its retry run on the runner (tests/runner/runner-queue.test.ts); these
// cases cover the policy path and descendant recovery.

/** A development-only step that appends to `ledger`. */
function finalization(ledger: string) {
  return {
    version: 1, target: "fixture-development-db", idempotency: "artifact-key", approvalMode: "automatic-development", timeoutMs: 30_000,
    command: { executable: "node", args: ["-e", `require("node:fs").appendFileSync(${JSON.stringify(ledger)}, "ran\\n")`] },
    targetProbe: { executable: "node", args: ["-e", "console.log(JSON.stringify({ target: \"fixture-development-db\" }))"] },
  };
}

// YardSmith ys-skip-optimiser / ys-1269: a completed receipt whose commit still carries the
// retired slipway.json cannot cover an older artifact, and must not crash the scan.
test("a completed receipt on a retired-policy commit is skipped, not thrown, by descendant recovery", async () => {
  const external = await mkdtemp(join(tmpdir(), "peach-finalization-target-"));
  const f = await project({ postIntegration: finalization(join(external, "ledger.jsonl")) });
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.repo, encoding: "utf8" }).trim();
    const older = git("rev-parse", "HEAD");
    git("mv", "slipjay.json", "slipway.json");
    git("commit", "-qm", "Retired policy path");
    const newer = git("rev-parse", "HEAD");
    const gitDirectory = join(f.repo, ".git");
    const { policy } = await readPostIntegrationPolicy(gitDirectory, older);
    assert.ok(policy);
    const policyDigest = postIntegrationPolicyDigest(policy);
    // The receipt and idempotency-key hashes finalization uses to find a descendant receipt.
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const stateDirectory = join(external, "state");
    await mkdir(stateDirectory);
    await writeFile(join(stateDirectory, `${digest([gitDirectory, newer])}.json`), JSON.stringify({
      ok: true, status: "complete", sourceIntegrated: true, approved: true, attempt: 1, integratedCommitSha: newer,
      policyDigest, target: policy.target, idempotencyKey: digest([gitDirectory, newer, policyDigest, policy.target]) }));
    const outcome = await finalizePostIntegration({ gitDirectory, integratedCommitSha: older, stateDirectory,
      recoverDescendant: true, readIntegrationTip: async () => newer });
    // A former filename cannot supply the canonical policy or prove a matching receipt.
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "Historical migration policy changed or is not recoverable", JSON.stringify(outcome));
    await assert.rejects(readFile(join(external, "ledger.jsonl")), { code: "ENOENT" });
  } finally {
    await Promise.all([f.dispose(), rm(external, { recursive: true, force: true })]);
  }
}, 120_000);
