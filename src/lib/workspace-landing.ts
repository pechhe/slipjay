import type { WorkspaceContext } from "./workspace-jj.ts";
import type { LandingAdapter, LandingRevision, LandingTail, LandingTailOptions } from "./landing-steps.ts";

/** Host options for serialized landing, publication, verification, and cleanup. */
export type LandWorkspaceOptions = LandingTailOptions & {
  allowDefaultWorkspace?: boolean;
  operationId?: string;
  onStage?: (stage: "preparing" | "fetching" | "queued" | "rebasing" | "verifying" | "integrating" | "cleaning") => void;
  adapter?: LandingAdapter;
  /** `false` for a host that releases its own checkout records; otherwise other disposable workspaces are swept after landing. */
  sweepOtherWorkspaces?: boolean;
  /** `false` to keep the landed workspace itself; otherwise it is removed after landing unless another process holds it. Independent of `sweepOtherWorkspaces`. */
  releaseLandedWorkspace?: boolean;
  /** Receives one concise line per verification step; defaults to stdout. */
  onProgress?: (line: string) => void;
  /** Environment for the background post-land verification; defaults to `environment`. */
  postLandEnvironment?: () => NodeJS.ProcessEnv;
  /** Detached command that runs one post-land record file (appended), for a caller that exits after landing; long-lived hosts omit it and run in-process. */
  postLandRunner?: string[];
};

/** Delivered artifact and its verification, publication, and cleanup outcomes. */
export type LandWorkspaceResult = LandingTail & {
  artifact: LandingRevision; context: WorkspaceContext | import("./landing-candidate.ts").CandidateContext;
  cleanupPending?: boolean; cleanupError?: string;
  /** Whether the primary checkout was moved onto the new integration or left in place. */
  primaryCheckout?: import("./landing-candidate.ts").PrimaryCheckoutOutcome;
  verification: import("./verification-policy.ts").VerificationEvidence;
  /** The integration branch tip this landing verified against and advanced; absent when a rerun only republished. */
  base?: string;
  /** The declared background verification this landing started. */
  postLand?: { status: string; commit?: string; log?: string; reason?: string };
  /** An earlier landing's background verification on this repository did not pass. */
  postLandWarning?: string;
  /** What this landing's sweep of other disposable workspaces removed and kept. */
  sweep?: import("./workspace-sweep.ts").SweepResult;
  /** Whether this landing removed its own, now delivered, workspace; when kept, why (naming any other process holding it). */
  released?: { cleaned: boolean; reason?: string; holders?: import("./workspace-holders.ts").ProcessWorkingDirectory[] };
};

import { integrateLandingCandidate, finishLanding } from "./landing-candidate.ts";
import { completeLanding, artifactPublished, fetchIntegration, landingIO, landingPreview, publicationRemote, waitForLandingSlot } from "./landing-steps.ts";
import { githubRepository, originatingIssue } from "./post-land-issue.ts";
import { describePostLandFailure, latestPostLandResult, startPostLandVerification } from "./post-land-verification.ts";
import { withVerificationSlot } from "./verification-slot.ts";
import { createWorkspace } from "./workspace-create.ts";
import { jj, revisionExists, revisionFacts, workspaceContext, workspaceHasUnintegratedWork } from "./workspace-jj.ts";
import { assertWorkspaceMutationAllowed, readLandingState, statePath, workspaceMetadata } from "./workspace-state.ts";
import { sweepDisposableWorkspaces } from "./workspace-sweep.ts";
import { cleanupLandedWorkspace, describeRetention } from "./workspace-lifecycle.ts";
import { callerPids, describeHolders, workspaceHolders } from "./workspace-holders.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "./workspace-transaction.ts";
import { readExecutionPolicy, readExecutionPolicyAtCommit } from "./execution-policy.ts";
import { resolve } from "node:path";

const PUBLICATION_RECOVERY_PHASES: ReadonlyArray<string | undefined> = ["landed", "recovering"];

/** Only the recorded unpublished artifact and the published tip may explain a conflict. */
async function publicationRecovery(cwd: string, context: WorkspaceContext) {
  const prior = await readLandingState(context.current.name, { readOnly: true });
  if (context.current.name === "default" || !prior || !PUBLICATION_RECOVERY_PHASES.includes(prior.phase) || prior.verification !== "passed"
    || prior.workspaceName !== context.current.name || prior.workspacePath !== context.current.root
    || prior.integrationRoot !== context.integration.root || prior.integrationBranch !== context.integrationBranch
    || prior.localOnly === true) throw new Error("Conflicted integration requires a recorded unpublished isolated landing");
  const artifact = await readExecutionPolicyAtCommit(cwd, prior.artifactCommitId);
  const policy = artifact.policy;
  if (!policy?.remote || policy.integrationBranch !== context.integrationBranch)
    throw new Error("Publication recovery requires the recorded artifact's declared branch and remote");
  const remoteTip = await revisionFacts(cwd, `${context.integrationBranch}@${policy.remote}`);
  const published = await readExecutionPolicyAtCommit(cwd, remoteTip.commitId);
  if (JSON.stringify(policy) !== JSON.stringify(published.policy))
    throw new Error("Publication recovery refused: committed integration policies disagree");
  const heads = (await jj(cwd, ["--ignore-working-copy", "log", "-r", `bookmarks(exact:${JSON.stringify(context.integrationBranch)})`, "--no-graph", "-T", 'commit_id ++ "\\n"'])).trim().split("\n");
  if (heads.length !== 2 || !heads.includes(prior.artifactCommitId) || !heads.includes(published.commitId))
    throw new Error("Publication recovery refused: integration conflict contains an unexplained head");
  const current = await revisionFacts(cwd, "@");
  const parent = await revisionFacts(cwd, "@-");
  if (!current.empty || current.conflict || parent.commitId !== prior.artifactCommitId)
    throw new Error("Publication recovery refused: workspace differs from its recorded landing");
  const metadata = await workspaceMetadata(context.current.name);
  if ((prior.issueNumber ?? null) !== (metadata?.issueNumber ?? null))
    throw new Error("Publication recovery refused: workspace Issue changed");
  if (metadata?.implementationChangeId && metadata.implementationChangeId !== (prior.workspaceImplementationChangeId ?? prior.artifactChangeId))
    throw new Error("Publication recovery refused: workspace implementation ownership changed");
  return { prior, published, policy };
}

async function landingContext(cwd: string): Promise<WorkspaceContext | null> {
  try { return await workspaceContext(cwd); }
  catch (error) {
    // The working policy only names the branch to inspect; both committed policies
    // must agree before the landing can reach its serialized recovery transition.
    const hint = await readExecutionPolicy(cwd);
    if (!hint?.integrationBranch) throw error;
    const context = await workspaceContext(cwd, hint.integrationBranch);
    if (!context) throw error;
    const recovery = await publicationRecovery(cwd, context);
    return { ...context, configuration: recovery.policy };
  }
}

/**
 * The land command: one serialized landing of a workspace, its background
 * verification, and the delivered-source proof a continuation requires.
 */

/** Landing is one operation: fetch → rebase → verify → move bookmark → push. */
export async function landWorkspace(cwd: string = process.cwd(), options: LandWorkspaceOptions = {}): Promise<LandWorkspaceResult> {
  const context = await landingContext(cwd);
  if (!context || (context.current.name === "default" && !options.allowDefaultWorkspace)) throw new Error("Landing requires an isolated jj workspace");
  options.onStage?.("preparing");
  if (options.localOnly !== undefined && typeof options.localOnly !== "boolean") throw new Error("localOnly must be an explicit boolean");
  const remote = publicationRemote(context, options.localOnly);
  const onProgress = options.onProgress ?? ((line) => console.log(line));
  // A failed background run on this repository is the next landing's to see.
  const postLandFailure = describePostLandFailure(await latestPostLandResult(context.integration.root));
  if (postLandFailure) onProgress(`[post-land] ${postLandFailure}`);
  // One landing at a time holds this repository's slot from fetch through push, so
  // the integration branch cannot move between this landing's rebase and bookmark.
  // The workspace's writer key serializes this landing with cleanup of the same checkout.
  // "queued" marks time spent waiting for another landing; "fetching" marks the slot acquired.
  const slot = waitForLandingSlot(context, onProgress);
  let queued = false;
  const result = await withVerificationSlot(() => {
    if (queued) options.onStage?.("fetching");
    return withWorkspaceTransaction(`writer:${context.current.name}`, () => landInSlot(cwd, context, remote, options));
  }, { ...slot, onWait: (status) => {
    if (!queued) { queued = true; options.onStage?.("queued"); }
    slot.onWait(status);
  } });
  // Started outside the landing slot, so an in-process run queues on its own.
  const started = { ...result, ...await startPostLand(cwd, context, result, options.postLandRunner, options.postLandEnvironment ?? options.environment) };
  // Release other disposable checkouts after every CLI/extension landing. A host
  // that owns its checkout records (Peach desktop) opts out and releases them
  // itself. The sweep never fails the landing.
  const sweep = result.ok && options.sweepOtherWorkspaces !== false
    ? await sweepDisposableWorkspaces(context.integration.root, { protectedRoots: [cwd, context.current.root] }).catch(() => undefined) : undefined;
  // Last: the caller's own checkout. This process and the session that ran it do not hold it
  // (they are leaving); anything else with its working directory inside does.
  const released = result.ok && options.releaseLandedWorkspace !== false && context.current.name !== "default"
    ? await releaseLandedWorkspace(context).catch((error) => ({ cleaned: false, reason: error instanceof Error ? error.message : String(error) })) : undefined;
  return { ...started, ...(sweep ? { sweep } : {}), ...(released ? { released } : {}), ...(postLandFailure ? { postLandWarning: postLandFailure } : {}) };
}

/**
 * Remove the workspace this landing delivered, as `slipjay cleanup` would. Anything
 * else working inside it keeps it, and is named so its owner can stop it.
 */
export async function releaseLandedWorkspace(context: WorkspaceContext) {
  const holders = await workspaceHolders(context.current.root, { ignore: await callerPids() });
  if (!holders) return { cleaned: false, reason: "process working directories unavailable" };
  if (holders.length) return { cleaned: false, reason: `in use by a live process: ${describeHolders(holders)}`, holders };
  const result = await cleanupLandedWorkspace(context.current.root);
  return result.cleaned ? { cleaned: true } : { cleaned: false, reason: describeRetention(result) };
}

async function landInSlot(cwd: string, context: WorkspaceContext, remote: string | null, options: LandWorkspaceOptions): Promise<LandWorkspaceResult> {
  // Rebase onto the latest published integration; an offline fetch surfaces again at push.
  // The candidate's own context then reads the fetched bookmark's committed policy (D3).
  if (remote) await fetchIntegration(cwd, remote, context.integrationBranch);
  // A concurrent publisher can leave JJ's local bookmark conflicted after a
  // failed push. Preserve the owned candidate and use the published tip as the
  // next base; normal landing then rebases and verifies it again.
  try { await revisionFacts(cwd, context.integrationBranch); }
  catch {
    await withWorkspaceTransaction(`integrate:${resolve(context.integration.root)}:${context.integrationBranch}`, async () => {
      const recovery = await publicationRecovery(cwd, context);
      if (remote !== recovery.policy.remote) throw new Error("Publication recovery remote changed");
      // Record intent before changing the base so an interruption can resume
      // through the normal candidate path, retaining the earlier exact receipt.
      if (recovery.prior.phase !== "recovering") await writeWorkspaceJson(statePath(context.current.name), {
        ...recovery.prior, phase: "recovering", publicationRecovery: {
          previousLanding: recovery.prior, publishedBase: recovery.published.commitId, startedAt: new Date().toISOString(),
        },
      });
      await jj(cwd, ["bookmark", "set", context.integrationBranch, "--revision", recovery.published.commitId]);
    });
  }
  const integrate = async () => {
    const prior = await readLandingState(context.current.name);
    if (prior?.phase === "landed" && prior.workspacePath === context.current.root && prior.integrationRoot === context.integration.root && !await workspaceHasUnintegratedWork(cwd, context.integrationBranch)
      && await revisionExists(cwd, `${prior.artifactCommitId} & ::${context.integrationBranch}`)) {
      const cleanup = await finishLanding(context, prior, options, landingIO);
      return { context, artifact: await revisionFacts(cwd, prior.artifactCommitId), ...cleanup,
        verification: prior.verificationEvidence ?? { status: "passed", passed: prior.verificationCommands ?? [], gaps: [], policyDigest: "legacy" } };
    }
    if (context.current.name !== "default") await assertWorkspaceMutationAllowed(context);
    return landOwnedWorkspace(cwd, options);
  };
  const result = await integrate();
  const completed = await completeLanding(cwd, context, result.artifact.commitId, options);
  return { ...result, ...completed };
}

/** What a post-land failure Issue needs, read while the workspace and its metadata exist. */
async function postLandLandingContext(cwd: string, context: WorkspaceContext, result: LandWorkspaceResult) {
  const description = (await jj(cwd, ["--ignore-working-copy", "log", "-r", result.artifact.commitId, "--no-graph", "-T", "description"])
    .catch(() => result.artifact.description ?? "")).trim();
  const metadata = context.current.name === "default" ? null : await workspaceMetadata(context.current.name);
  const remotes = await jj(cwd, ["--ignore-working-copy", "git", "remote", "list"]).catch(() => "");
  const diffStat = await jj(cwd, ["--ignore-working-copy", "diff", "--from", result.base!, "--to", result.artifact.commitId, "--stat"]).catch(() => null);
  return {
    description, diffStat,
    originatingIssue: originatingIssue(metadata?.issueNumber, description),
    repository: githubRepository(remotes, context.configuration.remote),
  };
}

/** A fresh integration starts the repository's declared background verification. */
async function startPostLand(cwd: string, context: WorkspaceContext, result: LandWorkspaceResult, runner: string[] | undefined, environment: (() => NodeJS.ProcessEnv) | undefined): Promise<Pick<LandWorkspaceResult, "postLand">> {
  const checks = context.configuration.postLandVerification ?? [];
  if (!result.base || !checks.length) return {};
  try {
    const gitDirectory = await jj(cwd, ["--ignore-working-copy", "git", "root"]);
    const record = await startPostLandVerification({ integrationRoot: context.integration.root, gitDirectory, base: result.base, commit: result.artifact.commitId, checks, runner,
      landing: await postLandLandingContext(cwd, context, result),
      // The host's command environment, as for the landing's own verification.
      ...(environment ? { env: environment() } : {}) });
    return { postLand: { status: record.status, commit: record.commit, log: record.log } };
  } catch (error) {
    // The integration stands; only its background evidence is missing.
    return { postLand: { status: "not_started", reason: error instanceof Error ? error.message : String(error) } };
  }
}

// Called inside landWorkspace's slot: only the slot holder advances the integration
// branch, so the base this landing verifies is still current when it integrates.
function landOwnedWorkspace(cwd: string, options: LandWorkspaceOptions) {
  return integrateLandingCandidate(cwd, options, {
    ...landingIO,
    landingPreview: (root) => landingPreview(root, { allowDefaultWorkspace: options.allowDefaultWorkspace }),
  });
}

/** Exact source proof (landed, pushed, nothing new) before a session leaves this workspace. */
export async function assertWorkspaceDelivered(cwd: string): Promise<Record<string, unknown>> {
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default") throw new Error("No current Issue workspace");
  const state = await readLandingState(context.current.name);
  const metadata = await workspaceMetadata(context.current.name);
  if (!state || state.phase !== "landed" || state.workspaceName !== context.current.name
    || state.workspacePath !== context.current.root || state.integrationRoot !== context.integration.root
    || state.integrationBranch !== context.integrationBranch
    || (state.issueNumber ?? null) !== (metadata?.issueNumber ?? null)
    || !await revisionExists(cwd, `${state.artifactCommitId} & ::${context.integrationBranch}`)
    || await workspaceHasUnintegratedWork(cwd, context.integrationBranch)) {
    throw new Error("Land the current workspace before continuing to another one");
  }
  if (!await artifactPublished(cwd, context, state)) throw new Error("Source integrated locally but not yet pushed; rerun land before continuing");
  return state;
}

/** A fresh workspace for this conversation's next task, once the current one is delivered. */
export async function prepareWorkspaceContinuation(task: string, cwd: string): ReturnType<typeof createWorkspace> {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Continuation requires a JJ project");
  if (context.current.name !== "default") await assertWorkspaceDelivered(cwd);
  return createWorkspace(task, context.integration.root);
}
