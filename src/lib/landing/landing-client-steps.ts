import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { BuildReader } from "../build/tracker.ts";
import { trackerOf, workItemTitle } from "../build/tracker.ts";
import { githubRepository, isUndescribed, withIssueTrailer } from "../build/issue-references.ts";
import type { WorkspaceContext } from "../infra/workspace-jj.ts";
import { jj, revisionFacts } from "../infra/workspace-jj.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "../infra/workspace-transaction.ts";
import type { VerificationEvidence } from "../policy/verification-policy.ts";
import { primaryDependencyHost, refreshPrimaryDependencies } from "../workspace/primary-dependencies.ts";
import { stateHome } from "../workspace/workspace-paths.ts";
import { readLandingState, statePath, workspaceMetadata } from "../workspace/workspace-state.ts";
import type { CandidateContext } from "./landing-candidate.ts";
import type { LandingRevision } from "./landing-steps.ts";
import { finishLanding } from "./primary-checkout.ts";

/**
 * Client-side landing helpers (description, state record, primary-checkout finish)
 * decoupled from candidate preparation, migration generation and post-integration.
 */

export async function writeLandingState(context: CandidateContext, artifact: LandingRevision, verification: VerificationEvidence, phase: string = "landed", operationId?: string): Promise<void> {
  await mkdir(stateHome(), { recursive: true, mode: 0o700 });
  const metadata = await workspaceMetadata(context.current.name);
  const prior = await readLandingState(context.current.name, { readOnly: true });
  const landedAt = new Date().toISOString();
  await writeWorkspaceJson(statePath(context.current.name), {
    version: 1, phase, operationId, cleanupPending: true, workspaceName: context.current.name, workspacePath: context.current.root,
    integrationRoot: context.integration.root, integrationBranch: context.integrationBranch,
    artifactCommitId: artifact.commitId, artifactChangeId: artifact.changeId,
    artifactDescription: artifact.description, verification: verification.status,
    verificationCommands: verification.passed, verificationEvidence: verification, landedAt,
    workspaceImplementationChangeId: metadata?.implementationChangeId,
    ...(prior?.publicationRecovery ? { publicationRecovery: prior.publicationRecovery } : {}),
    // No archive period: a delivered checkout is eligible for cleanup at landing.
    cleanupEligibleAt: landedAt,
    ...(typeof metadata?.issueNumber === "number" ? { issueNumber: metadata.issueNumber } : {}),
  });
}

/** `readBuild` reads a Build-tracked workspace's item title for a missing description. */
export async function ensureLandingDescription(cwd: string, context: CandidateContext, target: LandingRevision, readBuild?: BuildReader, onProgress: (line: string) => void = console.log): Promise<LandingRevision> {
  const metadata = await workspaceMetadata(context.current.name);
  const issueNumber = typeof metadata?.issueNumber === "number" ? metadata.issueNumber : null;
  // The exact text `start` generated is no description: it is replaced, never published.
  const generated = typeof metadata?.generatedDescription === "string" ? metadata.generatedDescription.trim() : "";
  if (generated) {
    const stack = await jj(cwd, ["--ignore-working-copy", "log", "-r", `(${context.integrationBranch}..${target.changeId}) ~ ${target.changeId}`, "--no-graph", "-T",
      'change_id.short() ++ "\\t" ++ description.first_line() ++ "\\n"']);
    const stale = stack.split("\n").map((line) => line.split("\t")).find(([, line]) => line?.trim() === generated);
    if (stale) throw new Error(`Landing needs a real description for commit ${stale[0]}: it still has the generated placeholder "${generated}". Run \`jj describe -r ${stale[0]} -m "<what this change does>"\` and land again`);
  }
  // `revisionFacts` carries only the first line; the trailer and body are part of what is compared and rewritten.
  const fullDescription = (await jj(cwd, ["--ignore-working-copy", "log", "-r", target.commitId, "--no-graph", "-T", "description"])).trim();
  // A body written under the generated subject is kept; only that subject is replaced.
  const [subject = "", ...bodyLines] = fullDescription.split("\n");
  const placeholder = Boolean(generated) && subject.trim() === generated;
  const body = placeholder ? bodyLines.join("\n").trim() : "";
  let description = placeholder ? "" : fullDescription;
  if (isUndescribed(description)) {
    const issueDescription = issueNumber
      ? await workItemTitle(context.integration.root, trackerOf(context.configuration), issueNumber, readBuild)
      : null;
    const taskDescription = typeof metadata?.task === "string" ? metadata.task.trim() : "";
    description = (issueDescription?.trim() || taskDescription).slice(0, 500);
    if (!description)
      throw new Error(`Landing needs a description of the change: run \`jj describe -r ${target.changeId} -m "<what this change does>"\` and land again`);
  }
  if (body) description = `${description}\n\n${body}`;
  // The landed commit names its Issue itself, so attribution survives machine-local state.
  const remotes = issueNumber ? await jj(cwd, ["--ignore-working-copy", "git", "remote", "list"]).catch(() => "") : "";
  const described = withIssueTrailer(description, issueNumber, githubRepository(remotes, context.configuration.remote), trackerOf(context.configuration));
  if (described === fullDescription && fullDescription) return target;
  await jj(cwd, ["describe", "-r", target.changeId, "-m", described]);
  const submitted = await revisionFacts(cwd, target.changeId);
  onProgress(`[description] given ${target.commitId}; submitting ${submitted.commitId} after updating the description`);
  return submitted;
}

export const refreshPrimaryCheckoutDependencies = (root: string): Promise<string | undefined> =>
  refreshPrimaryDependencies(root, primaryDependencyHost(async (path) => (await revisionFacts(path, "@")).commitId));

/**
 * The client's housekeeping after a landing, or a retry of it. Several sessions'
 * clients move the same primary checkout once their landings return, so this one
 * step is serialized on this machine; the runner's queue needs no lock.
 */
export async function finishLandedWorkspace(context: WorkspaceContext, state: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return await withWorkspaceTransaction(`integrate:${resolve(context.integration.root)}:${context.integrationBranch}`,
      () => finishLanding(context, state, { jj, revisionFacts, statePath, refreshPrimaryDependencies: refreshPrimaryCheckoutDependencies }));
  } catch (error) {
    // Only the transaction itself throws here: finishLanding records its own failures.
    const cleanupError = error instanceof Error ? error.message : String(error);
    delete state.primaryCheckout;
    if (context.current.name !== "default") await writeWorkspaceJson(statePath(context.current.name), { ...state, cleanupPending: true, cleanupError });
    return { cleanupPending: true, cleanupError };
  }
}
