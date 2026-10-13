/**
 * Migration-input coverage for post-integration finalization: when an already
 * finalized artifact proves another artifact's external state without running
 * its command. Pure Git evidence plus the private receipt store; no external effects.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { BoundedProcessResult } from "./bounded-process.ts";
import { runBoundedProcess } from "./bounded-process.ts";
import { EXECUTION_POLICY_PATH } from "./execution-policy.ts";
import type { FinalizationCommand, PostIntegrationPolicy } from "./post-integration-policy.ts";
import { postIntegrationPolicyDigest } from "./post-integration-policy.ts";
import type { PostIntegrationResult } from "./post-integration-finalization.ts";
import type { PostIntegrationInput } from "./post-integration-finalization.ts";
import { readExactExecutionPolicy, readPostIntegrationPolicy } from "./post-integration-source.ts";
import { writeWorkspaceJson } from "./workspace-transaction.ts";

export class HistoricalMigrationFailure extends Error {}

/** The declared post-integration commands, read raw from the exact policy (not yet normalized). */
type DeclaredPostIntegration = { command: FinalizationCommand; targetProbe: FinalizationCommand };
/** One target's latest outcome, as stored. */
type TargetOutcome = {
  version: 1;
  gitDirectory: string;
  target: string;
  policyDigest: string;
  commitSha: string;
  status: "running" | "complete" | "failed";
  anchorCommitSha?: string;
};

const SHA = /^[a-f0-9]{40}$/;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** The external-state idempotency key of one artifact, policy and target. */
export const artifactKey = (gitDirectory: string, commit: string, policyDigest: string, target: string): string => digest([gitDirectory, commit, policyDigest, target]);
export const receiptPath = (stateDirectory: string, gitDirectory: string, commit: string): string => path.join(stateDirectory, `${digest([gitDirectory, commit])}.json`);
/** The key of one repository's external target: its lease and latest outcome. */
export const targetKeyOf = (gitDirectory: string, target: string): string => digest([gitDirectory, target]);

function gitSucceeded(result: BoundedProcessResult): boolean {
  return result.exitCode === 0 && !result.timedOut && !result.error && !result.signal
    && !result.stdoutTruncated && !result.stderrTruncated;
}

export async function isAncestor(gitDirectory: string, ancestorCommit: string, descendantCommit: string, environmentFactory: () => NodeJS.ProcessEnv, abortSignal?: AbortSignal): Promise<boolean> {
  return gitSucceeded(await runBoundedProcess({
    executable: "git", args: ["--git-dir", gitDirectory, "merge-base", "--is-ancestor", ancestorCommit, descendantCommit],
    cwd: gitDirectory, env: environmentFactory(), abortSignal, timeoutMs: 30000, maxOutputBytes: 1024,
  }));
}

/**
 * Prove `other` has the same migration inputs as `exact`, judged by `exact`'s
 * policy: the policy file (`slipjay.json`), the declared trigger and artifact paths, and
 * the finalization command and probe packages and script directories.
 */
export async function verifyUnchangedMigrationInputs(gitDirectory: string, exactCommit: string, otherCommit: string, policyDigest: string, environmentFactory: () => NodeJS.ProcessEnv, abortSignal?: AbortSignal): Promise<string[]> {
  const [exact, other] = await Promise.all([
    readExactExecutionPolicy(gitDirectory, exactCommit, environmentFactory),
    readExactExecutionPolicy(gitDirectory, otherCommit, environmentFactory),
  ]);
  const migration = exact.configuration?.migrationFinalization;
  if (migration?.mode !== "late_bound_serialized"
    || JSON.stringify(migration) !== JSON.stringify(other.configuration?.migrationFinalization)
    || postIntegrationPolicyDigest((await readPostIntegrationPolicy(gitDirectory, otherCommit, environmentFactory)).policy) !== policyDigest)
    throw new HistoricalMigrationFailure("Historical migration policy changed or is not recoverable");
  if (!Array.isArray(migration.triggerPaths) || !Array.isArray(migration.artifactPaths))
    throw new HistoricalMigrationFailure("Historical migration input paths are missing");
  const commandInputs = [(exact.configuration!.postIntegration as DeclaredPostIntegration).command, (exact.configuration!.postIntegration as DeclaredPostIntegration).targetProbe]
    .flatMap((command) => {
      const cwd = command.cwd ?? ".";
      return [path.posix.join(cwd, "package.json"), ...command.args
        .filter((arg: string) => /\.(?:[cm]?js|ts)$/.test(arg) && !arg.startsWith("-"))
        .map((arg: string) => path.posix.dirname(path.posix.join(cwd, arg)))];
    });
  const protectedPaths = [...new Set([
    EXECUTION_POLICY_PATH,
    ...migration.triggerPaths, ...migration.artifactPaths,
    ...commandInputs,
  ])];
  if (protectedPaths.some((value) => typeof value !== "string" || !value || path.isAbsolute(value)
    || value.startsWith(":") || value.includes("\\") || value.split("/").includes("..")))
    throw new HistoricalMigrationFailure("Historical migration input paths are unsafe");
  const unchanged = await runBoundedProcess({
    executable: "git", args: ["--git-dir", gitDirectory, "diff", "--quiet", otherCommit, exactCommit, "--", ...protectedPaths],
    cwd: gitDirectory, env: environmentFactory(), abortSignal, timeoutMs: 30000, maxOutputBytes: 1024,
  });
  if (!gitSucceeded(unchanged))
    throw new HistoricalMigrationFailure("Historical migration inputs changed after integration");
  return protectedPaths;
}

/** No commit between `from` and `to` touched the paths: a migration added and later reverted is not "unchanged". */
async function untouchedSince(gitDirectory: string, from: string, to: string, paths: string[], environmentFactory: () => NodeJS.ProcessEnv, abortSignal?: AbortSignal): Promise<boolean> {
  const result = await runBoundedProcess({
    executable: "git", args: ["--git-dir", gitDirectory, "rev-list", "--count", "--full-history", `${from}..${to}`, "--", ...paths],
    cwd: gitDirectory, env: environmentFactory(), abortSignal, timeoutMs: 30000, maxOutputBytes: 1024,
  });
  return gitSucceeded(result) && result.stdout.trim() === "0";
}

export async function verifyHistoricalMigrationSpan(input: PostIntegrationInput, gitDirectory: string, commit: string, tip: string, policyDigest: string, environmentFactory: () => NodeJS.ProcessEnv, abortSignal?: AbortSignal): Promise<void> {
  if (!input.recoverDescendant || !SHA.test(tip))
    throw new HistoricalMigrationFailure("Integration tip changed before finalization");
  if (!await isAncestor(gitDirectory, commit, tip, environmentFactory, abortSignal))
    throw new HistoricalMigrationFailure("Historical artifact is no longer in integration history");
  await verifyUnchangedMigrationInputs(gitDirectory, commit, tip, policyDigest, environmentFactory, abortSignal);
}

export async function historicalMigrationTip(input: PostIntegrationInput, gitDirectory: string, commit: string, policyDigest: string, environmentFactory: () => NodeJS.ProcessEnv, abortSignal?: AbortSignal): Promise<void> {
  const tip = (await input.readIntegrationTip()).trim();
  if (tip === commit) return;
  await verifyHistoricalMigrationSpan(input, gitDirectory, commit, tip, policyDigest, environmentFactory, abortSignal);
}

export async function readState(file: string): Promise<(PostIntegrationResult & { attempt: number }) | null> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as PostIntegrationResult & { attempt: number; coverage: string };
    if (!value || typeof value !== "object" || !["approval_required", "running", "failed", "complete", "covered"].includes(value.status) || value.sourceIntegrated !== true || !Number.isInteger(value.attempt) || value.attempt < 0 || value.ok !== (["complete", "covered"].includes(value.status))
      || value.status === "covered" && (!["descendant", "ancestor"].includes(value.coverage) || !SHA.test(value.coveredByCommitSha ?? "")))
      throw new Error("Invalid post-integration state");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return null;
    throw error;
  }
}

// The most recent outcome that could have changed a target's external state. A
// sibling directory, so the receipt scan of `*.json` never reads it.
const outcomePath = (stateDirectory: string, targetKey: string): string => path.join(stateDirectory, "targets", `${targetKey}.json`);

/**
 * Record the target's latest outcome under the caller's target lease. Only a
 * successful command run (or an ancestor coverage that re-asserts its anchor)
 * records `complete`; `running` is written before any external work starts.
 */
export async function writeTargetOutcome(stateDirectory: string, targetKey: string, outcome: Omit<TargetOutcome, "version">): Promise<void> {
  await mkdir(path.dirname(outcomePath(stateDirectory, targetKey)), { recursive: true, mode: 448 });
  await writeWorkspaceJson(outcomePath(stateDirectory, targetKey), { version: 1, ...outcome });
}

async function readTargetOutcome(stateDirectory: string, targetKey: string): Promise<TargetOutcome | null> {
  try {
    const value = JSON.parse(await readFile(outcomePath(stateDirectory, targetKey), "utf8")) as TargetOutcome | null;
    return value?.version === 1 ? value : null;
  } catch {
    return null; // Missing or unreadable evidence only disables coverage.
  }
}

/**
 * The target's latest outcome is a completed run of ancestor A with this exact
 * policy, and C's migration inputs are unchanged since A: the external state is
 * already C's. Any doubt returns null and the exact source runs instead.
 */
export async function coveredByCompletedAncestor(input: PostIntegrationInput, { gitDirectory, commit, policy, policyDigest, stateDirectory, targetKey }: { gitDirectory: string; commit: string; policy: PostIntegrationPolicy; policyDigest: string; stateDirectory: string; targetKey: string }, environmentFactory: () => NodeJS.ProcessEnv, abortSignal?: AbortSignal): Promise<{ coveredByCommitSha: string; coveredByPolicyDigest: string } | null> {
  const last = await readTargetOutcome(stateDirectory, targetKey);
  const anchor = last?.anchorCommitSha;
  if (last?.status !== "complete" || last.gitDirectory !== gitDirectory || last.target !== policy.target
    || last.policyDigest !== policyDigest || !SHA.test(anchor ?? "") || anchor === commit) return null;
  let receipt;
  try { receipt = await readState(receiptPath(stateDirectory, gitDirectory, anchor!)); } catch { return null; }
  if (receipt?.status !== "complete" || receipt.approved !== true || receipt.attempt < 1
    || receipt.integratedCommitSha !== anchor || receipt.target !== policy.target || receipt.policyDigest !== policyDigest
    || receipt.idempotencyKey !== artifactKey(gitDirectory, anchor!, policyDigest, policy.target)) return null;
  if (!await isAncestor(gitDirectory, anchor!, commit, environmentFactory, abortSignal)) return null;
  try {
    const paths = await verifyUnchangedMigrationInputs(gitDirectory, commit, anchor!, policyDigest, environmentFactory, abortSignal);
    // A run this record never saw (another machine or build) may have applied a
    // migration that a later commit reverted; any protected-path history runs.
    if (!await untouchedSince(gitDirectory, anchor!, commit, paths, environmentFactory, abortSignal)) return null;
    // Never more permissive about the integration tip than running would be.
    await historicalMigrationTip(input, gitDirectory, commit, policyDigest, environmentFactory, abortSignal);
  } catch (error) {
    if (error instanceof HistoricalMigrationFailure) return null;
    throw error;
  }
  return { coveredByCommitSha: anchor!, coveredByPolicyDigest: policyDigest };
}
