import type { CandidateContext, LandingIO } from "./landing-candidate.ts";
import type { VerificationEvidence } from "../policy/verification-policy.ts";
import { finalizePostIntegration } from "../release/post-integration-finalization.ts";
import { prepareWorkspaceDependencies } from "../workspace/workspace-dependencies.ts";
import { jj, revisionExists, revisionFacts, run } from "../infra/workspace-jj.ts";
import { readJsonOptional, statePath } from "../workspace/workspace-state.ts";
import { isTransientRemotePushFailure, remotePushRetryDelaysMs } from "../infra/remote-push.ts";
import { artifactPublished, assertSingleVisibleCopy, conflictedPaths, fetchIntegration, fetchIntegrationIfMoved, landingPreview, publicationRemote } from "./landing-remote.ts";
import { ensureLandingDescription, finishLandedWorkspace, refreshPrimaryCheckoutDependencies, writeLandingState } from "./landing-client-steps.ts";

export { artifactPublished, assertSingleVisibleCopy, conflictedPaths, fetchIntegration, fetchIntegrationIfMoved, landingPreview, publicationRemote } from "./landing-remote.ts";
export { finishLandedWorkspace } from "./landing-client-steps.ts";

/** Result of the push step that ends every landing. */
export interface LandingPublication {
  ok: boolean;
  status: "pushed" | "push_failed" | "not_declared" | "blocked";
  commitId: string;
  remote?: string;
  branch?: string;
  reason?: string;
}
/** Options for finalization and publication after integration. */
export type LandingTailOptions = {
  /** Human approval for an `explicit-human` post-integration step; see post-integration-policy. */
  postIntegrationApproval?: unknown;
  environment?: () => NodeJS.ProcessEnv;
  /** Called once finalization has succeeded, just before the push. */
  onPublishing?: () => void;
  /** Called before a command could touch the target, or when an earlier attempt may have. */
  onTargetReached?: () => void;
  /** Speculative publication requires this exact remote predecessor, including at push time. */
  expectedBase?: string;
  runCommand?: import("./landing-candidate.ts").CandidateOptions["runCommand"];
};
/** Finalization, publication and timing outcome of a landing. */
export type LandingTail = {
  ok: boolean;
  postIntegration: import("../release/post-integration-finalization.ts").PostIntegrationResult;
  publication: LandingPublication;
  /** Wall-clock (epoch ms) starts of post-integration finalization and publication, for timing output only. */
  timings?: { finalizingStartedAt: number; publishingStartedAt: number; finishedAt: number };
};
/** Immutable revision facts used throughout landing. */
export type LandingRevision = { commitId: string; changeId: string; empty: boolean; conflict: boolean; description: string };
/** The runner's seams into a candidate landing: its gate, and (in tests) a stand-in for migration finalization. */
export type LandingAdapter = {
  finalizeCandidate?: (candidate: LandingRevision, base: LandingRevision) => Promise<LandingRevision>;
  verify: (identity: { base: string; candidate: string }) => Promise<VerificationEvidence>;
};

async function assertStackConflictFree(cwd: string, branch: string, changeId: string): Promise<void> {
  const conflicts = await jj(cwd, [
    "log",
    "-r",
    `conflicts() & (${branch}..${changeId})`,
    "--no-graph",
    "-T",
    'commit_id.short() ++ " " ++ description.first_line() ++ "\\n"',
  ]);
  if (conflicts.trim())
    throw new Error(
      `Rebase produced conflicts; resolve them in this workspace and retry:\n${conflicts}`,
    );
}

/**
 * A frozen install of the rebased candidate, before migration generation and
 * verification read `node_modules`: the workspace installed for the integration
 * tip it was allocated from, and the rebase may have brought in dependencies or
 * workspace packages since. An install that changes tracked source is undone and
 * fails the landing.
 */
async function prepareCandidateDependencies(cwd: string, context: CandidateContext, candidate: LandingRevision, onProgress: (line: string) => void = (line) => console.log(line), runCommand?: import("./landing-candidate.ts").CandidateOptions["runCommand"]): Promise<void> {
  const drift = () => jj(cwd, ["diff", "--from", candidate.commitId, "--to", "@", "--summary"]);
  if (await drift()) throw new Error("Verification checkout differs from the landing candidate; repair and rerun landing");
  const before = (await revisionFacts(cwd, "@")).commitId;
  onProgress("[deps] preparing frozen candidate dependencies");
  await prepareWorkspaceDependencies(context.current.root, { quiet: true, runCommand });
  if ((await revisionFacts(cwd, "@")).commitId === before && !await drift()) return;
  await jj(cwd, ["restore", "--from", candidate.commitId, "--into", "@"]);
  throw new Error("Dependency preparation changed the landing candidate's source; it was restored. Fix the install script and rerun landing");
}

/** Push the integration bookmark and confirm the remote-tracking bookmark contains the artifact. */
export async function publishIntegration(cwd: string, remote: string, branch: string, commitId: string, expectedBase?: string): Promise<LandingPublication> {
  const tracked = `${branch}@${remote}`;
  for (let attempt = 0; ; attempt++) {
    // JJ's push uses the remote-tracking old ref as its server-side precondition. Do not
    // refresh it or accept ancestry after refusal: that would weaken exact-prefix admission.
    if (expectedBase !== undefined) {
      const local = await revisionFacts(cwd, branch, { ignoreWorkingCopy: true });
      const base = await revisionFacts(cwd, tracked, { ignoreWorkingCopy: true });
      if (local.commitId !== commitId || base.commitId !== expectedBase)
        return { ok: false, status: "push_failed", remote, branch, commitId, reason: "Exact publication candidate or expected remote base changed; retained integration requires reconciliation" };
    }
    // A colocated import can leave the remote bookmark untracked; jj refuses to push it then.
    if (attempt === 0) await run("jj", ["--color=never", "bookmark", "track", tracked], { cwd });
    const pushed = await run("jj", ["--color=never", "git", "push", "--remote", remote, "--bookmark", branch], { cwd });
    const delay = remotePushRetryDelaysMs[attempt];
    if (pushed.code !== 0 && delay !== undefined && isTransientRemotePushFailure(`${pushed.stderr}\n${pushed.stdout}`)) {
      if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      continue;
    }
    const detail = (pushed.stderr || pushed.stdout).trim();
    if (expectedBase !== undefined) return pushed.code === 0
      ? { ok: true, status: "pushed", remote, branch, commitId }
      : { ok: false, status: "push_failed", remote, branch, commitId, reason: `Exact-parent publication failed; the local integration is kept: ${detail}` };
    // Without an exact predecessor, a remote that another landing already advanced past this artifact also counts.
    if (pushed.code !== 0) await fetchIntegration(cwd, remote, branch);
    if (await revisionExists(cwd, `${commitId} & ::${tracked}`))
      return { ok: true, status: "pushed", remote, branch, commitId };
    return { ok: false, status: "push_failed", remote, branch, commitId,
      reason: `Push of ${branch} to ${remote} failed${detail ? `: ${detail}` : ""}. The local integration is kept; rerun land to retry the push.` };
  }
}

/**
 * The tail every landing shares once the integration bookmark has moved: the
 * repository's declared external-state step (for example a development database
 * migration), then the push. A blocked or failed step keeps the local
 * integration; rerunning land retries it without re-verifying landed source.
 */
export function completeLanding(cwd: string, context: { integrationBranch: string; configuration: { remote?: string | null } }, commitId: string, options?: LandingTailOptions): Promise<LandingTail>;
export async function completeLanding(cwd: string, context: { integrationBranch: string; configuration: { remote?: string | null } }, commitId: string, options: LandingTailOptions = {}): Promise<Omit<LandingTail, "timings"> & { timings?: { finalizingStartedAt: number; publishingStartedAt?: number; finishedAt: number } }> {
  // Wall-clock stage starts for the CLI's timing line; not landing evidence.
  // The implementation tracks construction; publishingStartedAt is assigned before either return.
  const timings: { finalizingStartedAt: number; publishingStartedAt?: number } = { finalizingStartedAt: Date.now() };
  // A secondary workspace never exports to the colocated Git repository, and an
  // Isolated landing may run no JJ command in the primary checkout, so export the
  // integration bookmark for Git-level consumers. Finalization reads the exact
  // object, not this ref, so an export JJ declines does not block publication.
  await jj(cwd, ["--ignore-working-copy", "git", "export"]);
  const gitDirectory = await jj(cwd, ["--ignore-working-copy", "git", "root"]);
  const postIntegration = await finalizePostIntegration({
    gitDirectory, integratedCommitSha: commitId, approval: options.postIntegrationApproval,
    onTargetReached: options.onTargetReached,
    // A retry after a later landing: a completed descendant with unchanged migration
    // inputs covers this artifact, or its exact source runs; drift still fails closed.
    recoverDescendant: true,
    readIntegrationTip: async () => (await revisionFacts(cwd, context.integrationBranch)).commitId,
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.runCommand ? { runCommand: options.runCommand } : {}),
  });
  timings.publishingStartedAt = Date.now();
  const remote = publicationRemote(context);
  if (!postIntegration.ok) {
    const failure = `Post-integration ${postIntegration.status}${postIntegration.reason ? `: ${postIntegration.reason}` : ""}.`;
    // The caller fetched the remote: a later landing that already pushed this artifact ran its own step first.
    const published = remote && postIntegration.status === "failed"
      && await revisionExists(cwd, `${commitId} & ::${context.integrationBranch}@${remote}`);
    return { ok: false, postIntegration, timings: { ...timings, finishedAt: timings.publishingStartedAt }, publication: { ok: false, status: "blocked", commitId,
      reason: published
        ? `${failure} A later landing already published ${commitId.slice(0, 9)} to ${context.integrationBranch}@${remote} after its own post-integration step, so nothing remains to land; run \`slipjay cleanup\` to release this workspace.`
        : `${failure} The local integration is kept; resolve it and rerun land.` } };
  }
  options.onPublishing?.();
  const publication: LandingPublication = remote
    ? await publishIntegration(cwd, remote, context.integrationBranch, commitId, options.expectedBase)
    : { ok: true, status: "not_declared", commitId };
  return { ok: publication.ok, postIntegration, publication, timings: { ...timings, finishedAt: Date.now() } };
}

/** What the landing candidate (landing-candidate.ts) needs from the land command. */
export const landingIO: LandingIO = {
  landingPreview, ensureLandingDescription, jj,
  assertStackConflictFree, revisionFacts, prepareCandidateDependencies, writeLandingState,
  readJsonOptional, statePath,
  refreshPrimaryDependencies: refreshPrimaryCheckoutDependencies,
};
