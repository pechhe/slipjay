import type { PostIntegrationPolicy } from "./post-integration-policy.ts";

export type PostIntegrationResult = {
  ok: boolean;
  sourceIntegrated: true;
  status: "not_declared" | "approval_required" | "running" | "failed" | "complete" | "covered";
  integratedCommitSha: string;
  policyDigest?: string;
  target?: string;
  idempotencyKey?: string;
  attempt?: number;
  approved?: true;
  authorization?: "human" | "repository-policy";
  coverage?: "descendant" | "ancestor";
  coveredByCommitSha?: string;
  coveredByPolicyDigest?: string;
  priorFailure?: { attempt: number; reason: string };
  /** The failing probe's or command's output, redacted, when a step failed. */
  output?: string;
  reason?: string;
};

export type PostIntegrationInput = {
  gitDirectory: string;
  integratedCommitSha: string;
  readIntegrationTip: () => Promise<string>;
  approval?: unknown;
  abortSignal?: AbortSignal;
  recoverDescendant?: boolean;
  /** Internal test/storage seam, never accepted from delivery tool input. */
  stateDirectory?: string;
  environment?: () => NodeJS.ProcessEnv;
};

import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { writeWorkspaceJson } from "./workspace-transaction.ts";
import { runBoundedProcess, sanitizedProcessEnv } from "./bounded-process.ts";
import { exactPostIntegrationApproval, postIntegrationPolicyDigest } from "./post-integration-policy.ts";
import { checkoutCwd } from "./checkout-cwd.ts";
import { redactMigrationOutput } from "./migration-command-evidence.ts";
import { postIntegrationHome } from "./workspace-paths.ts";
import { SourcePreparationFailure, readPostIntegrationPolicy, withFinalizationSource } from "./post-integration-source.ts";
import { HistoricalMigrationFailure, artifactKey, coveredByCompletedAncestor, historicalMigrationTip, isAncestor, readState, receiptPath,
  targetKeyOf, verifyHistoricalMigrationSpan, writeTargetOutcome } from "./post-integration-coverage.ts";

// The original v1 normalizer omitted approvalMode. Reuse only a completed,
// explicitly approved legacy receipt for this exact operation, never its grant
// for unfinished work. Returning the original record preserves its audit key.
function completedLegacyReceipt(previous: PostIntegrationResult & { attempt: number }, gitDirectory: string, commit: string, policy: PostIntegrationPolicy): boolean {
  if (previous.status !== "complete" || previous.ok !== true || previous.approved !== true
    || previous.attempt < 1 || previous.integratedCommitSha !== commit || previous.target !== policy.target) return false;
  const legacyPolicy = {
    version: policy.version,
    target: policy.target,
    idempotency: policy.idempotency,
    command: policy.command,
    targetProbe: policy.targetProbe,
    timeoutMs: policy.timeoutMs,
    environmentKeys: policy.environmentKeys,
  };
  const digest = createHash("sha256").update(JSON.stringify(legacyPolicy)).digest("hex");
  const key = createHash("sha256").update(JSON.stringify([gitDirectory, commit, digest, policy.target])).digest("hex");
  return previous.policyDigest === digest && previous.idempotencyKey === key;
}

async function coveredByCompletedDescendant(input: PostIntegrationInput, gitDirectory: string, commit: string, policy: PostIntegrationPolicy, policyDigest: string, stateDirectory: string, environmentFactory: () => NodeJS.ProcessEnv, abortSignal?: AbortSignal): Promise<{ coveredByCommitSha: string; coveredByPolicyDigest: string | undefined } | null> {
  if (!input.recoverDescendant) return null;
  // A completed later artifact proves this target only when its migration inputs
  // still matched the older artifact. Drift after that completion is irrelevant.
  const tip = (await input.readIntegrationTip()).trim();
  if (tip === commit || !/^[a-f0-9]{40}$/.test(tip)
    || !await isAncestor(gitDirectory, commit, tip, environmentFactory, abortSignal)) return null;
  for (const entry of await readdir(stateDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    // A receipt this build cannot validate (e.g. a newer format) only cannot cover.
    const receipt = await readState(path.join(stateDirectory, entry.name)).catch(() => null);
    const descendant = receipt?.integratedCommitSha;
    if (receipt?.status !== "complete" || receipt.approved !== true || receipt.attempt < 1
      || receipt.target !== policy.target || !/^[a-f0-9]{40}$/.test(descendant ?? "")
      || descendant === commit || !await isAncestor(gitDirectory, descendant!, tip, environmentFactory, abortSignal)) continue;
    // A receipt whose commit still carries the retired policy path cannot cover.
    const candidate = await readPostIntegrationPolicy(gitDirectory, descendant!, environmentFactory)
      .catch((error) => { if ((error as NodeJS.ErrnoException)?.code === "SLIPJAY_RETIRED_POLICY_PATH") return null; throw error; });
    if (!candidate?.policy || postIntegrationPolicyDigest(candidate.policy) !== policyDigest
      || !(receipt.policyDigest === policyDigest
        && receipt.idempotencyKey === artifactKey(gitDirectory, descendant!, policyDigest, policy.target)
        || completedLegacyReceipt(receipt, gitDirectory, descendant!, candidate.policy))) continue;
    try {
      await verifyHistoricalMigrationSpan(input, gitDirectory, commit, descendant!, policyDigest, environmentFactory, abortSignal);
    } catch (error) {
      if (error instanceof HistoricalMigrationFailure) continue;
      throw error;
    }
    const currentTip = (await input.readIntegrationTip()).trim();
    if (!/^[a-f0-9]{40}$/.test(currentTip)
      || !await isAncestor(gitDirectory, descendant!, currentTip, environmentFactory, abortSignal)) return null;
    return { coveredByCommitSha: descendant!, coveredByPolicyDigest: receipt.policyDigest };
  }
  return null;
}
export async function finalizePostIntegration(input: PostIntegrationInput): Promise<PostIntegrationResult> {
  const commit = input.integratedCommitSha;
  const environmentFactory = input.environment ?? sanitizedProcessEnv;
  const { gitDirectory, policy } = await readPostIntegrationPolicy(input.gitDirectory, commit, environmentFactory);
  if (!policy) return { ok: true, sourceIntegrated: true, status: "not_declared", integratedCommitSha: commit };
  const policyDigest = postIntegrationPolicyDigest(policy);
  const identity = artifactKey(gitDirectory, commit, policyDigest, policy.target);
  const stateDirectory = input.stateDirectory ?? postIntegrationHome();
  const statePath = receiptPath(stateDirectory, gitDirectory, commit);
  await mkdir(stateDirectory, { recursive: true, mode: 448 });
  const targetKey = targetKeyOf(gitDirectory, policy.target);
  const { abortSignal } = input;
  const previous = await readState(statePath);
  if (previous && (previous.integratedCommitSha !== commit || previous.policyDigest !== policyDigest || previous.target !== policy.target || previous.idempotencyKey !== identity)
    && !completedLegacyReceipt(previous, gitDirectory, commit, policy)) {
    throw new Error("Post-integration identity drift requires reconciliation");
  }
  if (previous?.status === "complete" || previous?.status === "covered")
    return previous;
  const evidence: Pick<PostIntegrationResult, "sourceIntegrated" | "integratedCommitSha" | "policyDigest" | "target" | "idempotencyKey"> = { sourceIntegrated: true, integratedCommitSha: commit, policyDigest, target: policy.target, idempotencyKey: identity };
  const policyApproved = policy.approvalMode === "automatic-development";
  const humanApproved = exactPostIntegrationApproval(input.approval, commit, policyDigest, policy.target);
  const approved = policyApproved || input.approval === undefined && previous?.approved === true || humanApproved;
  if (!approved) {
    const pending: PostIntegrationResult = {
      ...evidence,
      ok: false,
      status: "approval_required",
      attempt: previous?.attempt ?? 0,
      reason: "Explicit approval for this integrated artifact, policy and external target is required"
    };
    if (!previous || previous.status === "approval_required")
      await writeWorkspaceJson(statePath, pending);
    return pending;
  }
  const accepted: typeof evidence & Pick<PostIntegrationResult, "approved" | "authorization"> = {
    ...evidence,
    approved: true,
    authorization: policyApproved ? "repository-policy" : previous?.authorization ?? "human"
  };
  // The target's latest outcome: only a successful run here records `complete`.
  const outcome = { gitDirectory, target: policy.target, policyDigest, commitSha: commit };
  const coverByDescendant = await coveredByCompletedDescendant(input, gitDirectory, commit, policy, policyDigest,
    stateDirectory, environmentFactory, abortSignal);
  const coverByAncestor = coverByDescendant ? null : await coveredByCompletedAncestor(input,
    { gitDirectory, commit, policy, policyDigest, stateDirectory, targetKey }, environmentFactory, abortSignal);
  const coverage = coverByDescendant ?? coverByAncestor;
  if (coverage) {
    // An interrupted step records nothing.
    if (abortSignal?.aborted) throw new Error("Finalization interrupted before coverage was recorded; rerun land");
    const covered: PostIntegrationResult = { ...accepted, ok: true, status: "covered", coverage: coverByDescendant ? "descendant" : "ancestor", ...coverage,
      attempt: previous?.attempt ?? 0,
      ...(previous?.status === "failed" ? { priorFailure: { attempt: previous.attempt, reason: previous.reason! } } : {}) };
    await writeWorkspaceJson(statePath, covered);
    // Ancestor coverage re-asserts its completed anchor. Descendant coverage
    // leaves the record alone: a later failure must stay the latest outcome.
    if (coverByAncestor) await writeTargetOutcome(stateDirectory, targetKey, { ...outcome, status: "complete", anchorCommitSha: coverage.coveredByCommitSha });
    return covered;
  }
  const attempt = (previous?.attempt ?? 0) + 1;
  // Invalidate the target's coverage before any external work, so an
  // interrupted run can never be skipped over.
  await writeTargetOutcome(stateDirectory, targetKey, { ...outcome, status: "running" });
  await writeWorkspaceJson(statePath, { ...accepted, ok: false, status: "running", attempt });
  let reason = "Integration tip changed before finalization";
  let output: string | undefined;
  // Redacted before clipping; a truncated stream may still split a credential, so it is withheld.
  const failureOutput = (result: { stdout: string; stderr: string; stdoutTruncated?: boolean; stderrTruncated?: boolean; error?: string }) =>
    [result.stdoutTruncated ? "[truncated output withheld]" : result.stdout, result.stderrTruncated ? "[truncated output withheld]" : result.stderr, result.error]
      .filter(Boolean).join("\n").trim().slice(-8192) || undefined;
  try {
    await historicalMigrationTip(input, gitDirectory, commit, policyDigest, environmentFactory, abortSignal);
    reason = "Exact source preparation failed";
    const complete = await withFinalizationSource<PostIntegrationResult>(gitDirectory, commit, async (root) => {
      const environment = environmentFactory();
      for (const key of policy.environmentKeys) {
        if (process.env[key] !== undefined)
          environment[key] = process.env[key];
      }
      Object.assign(environment, {
        SLIPJAY_FINALIZATION_COMMIT: commit, SLIPJAY_FINALIZATION_KEY: identity, SLIPJAY_FINALIZATION_TARGET: policy.target,
      });
      reason = "External target could not be verified";
      const probe = await runBoundedProcess({
        executable: policy.targetProbe.executable,
        args: policy.targetProbe.args,
        cwd: await checkoutCwd(root, policy.targetProbe.cwd, "Finalization target probe"),
        env: environment, abortSignal,
        timeoutMs: 30000,
        maxOutputBytes: 16 * 1024
      });
      // Parsed raw; only the recorded copy is redacted.
      const probeOutput = () => failureOutput({ ...probe, stdout: redactMigrationOutput(probe.stdout, root, { ...process.env, ...environment }), stderr: redactMigrationOutput(probe.stderr, root, { ...process.env, ...environment }) });
      if (probe.exitCode !== 0 || probe.timedOut || probe.error || probe.signal || probe.stdoutTruncated || probe.stderrTruncated) {
        output = probeOutput();
        throw new Error(reason);
      }
      let target: { target?: unknown } | null = null;
      try { target = JSON.parse(probe.stdout) as { target?: unknown } | null; } catch { /* reported below */ }
      if (!target || target.target !== policy.target) {
        output = probeOutput();
        throw new Error(reason);
      }
      reason = "Integration tip changed before external-state finalization";
      await historicalMigrationTip(input, gitDirectory, commit, policyDigest, environmentFactory, abortSignal);
      reason = "Finalization command failed or its outcome is unknown; retry with the same artifact key";
      const result = await runBoundedProcess({
        executable: policy.command.executable,
        args: policy.command.args,
        cwd: await checkoutCwd(root, policy.command.cwd, "Finalization command"),
        env: environment, abortSignal,
        timeoutMs: policy.timeoutMs,
        maxOutputBytes: 16 * 1024,
        redactOutput: (value) => redactMigrationOutput(value, root, { ...process.env, ...environment })
      });
      if (result.exitCode !== 0 || result.timedOut || result.error || result.signal) {
        output = failureOutput(result);
        throw new Error(reason);
      }
      reason = "Integration tip changed during finalization; external outcome requires reconciliation";
      await historicalMigrationTip(input, gitDirectory, commit, policyDigest, environmentFactory, abortSignal);
      return { ...accepted, ok: true, status: "complete", attempt };
    }, environmentFactory, abortSignal);
    reason = "Finalization interrupted; external outcome requires reconciliation";
    if (abortSignal?.aborted) throw new Error(reason);
    reason = "External finalization succeeded but its local receipt could not be persisted; retry with the same key";
    await writeWorkspaceJson(statePath, complete);
    await writeTargetOutcome(stateDirectory, targetKey, { ...outcome, status: "complete", anchorCommitSha: commit });
    return complete;
  } catch (error) {
    if (error instanceof HistoricalMigrationFailure) reason = error.message;
    else if (error instanceof SourcePreparationFailure) reason = `Exact source preparation failed: ${error.message}`;
    const failed: PostIntegrationResult = { ...accepted, ok: false, status: "failed", attempt, reason, ...(output ? { output } : {}) };
    await writeTargetOutcome(stateDirectory, targetKey, { ...outcome, status: "failed" });
    await writeWorkspaceJson(statePath, failed);
    return failed;
  }
}
