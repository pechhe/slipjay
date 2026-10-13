/**
 * The landing tool's one public entry (`@pechhe/slipjay`). Every consumer
 * outside this directory imports only from here: the desktop through its pinned
 * tag, and the Pi launcher and jj-workspace extension. The closure behind it
 * is self-contained and acyclic; `bun run check` enforces both, and that nothing
 * else imports a module here directly.
 */

// Workspaces: context, assignment, state and housekeeping (launcher, extension, CLI, hooks, desktop).
export { explicitIssueNumber, projectPrefix, revisionFacts, taskWorkspaceName, workspaceContext, workspaceHasUnintegratedWork } from "./workspace-jj.mjs";
export {
  assertWorkspaceMutationAllowed, attachWorkspaceIssue, findWorkspace, inspectWorkspace, inspectWorkspaces, landingStatePaths,
  listWorkspaces, readLandingState, readWorkspaceMode, renameWorkspace, workspaceContinuationState, writeWorkspaceMode,
} from "./workspace-state.mjs";
export { createWorkspace, findIssueWorkspace, recoverIssueWorkspace } from "./workspace-create.mjs";
export {
  cleanupLandedWorkspace, describeRetention, removeWorkspace, retainedWorkspaceMaterial, retireWorkspace,
} from "./workspace-lifecycle.mjs";
export { provisionSpare, readySpares, startSpareRefill } from "./workspace-pool.mjs";
export { pruneEmptyWorkspaces, sweepDisposableWorkspaces } from "./workspace-sweep.mjs";
export { withWorkspaceTransaction } from "./workspace-transaction.mjs";
export { acquirePrimaryWriter, activePrimaryWriter, releasePrimaryWriter } from "./primary-checkout-writer.mjs";
export { LANDED_WORKSPACE_REFUSAL, assertWorkspaceNotRetired, cleanupRetentionReason, workspaceContinuationDisposition } from "./workspace-delivery-lifecycle.mjs";
export { assertCompletedIssueDelivered, selectImplementationIssue } from "./issue-eligibility.mjs";

// The one-time move of Slipway's state from ~/.slipway to ~/.slipjay (CLI, hosts that report it).
export { cutover } from "./cutover.mjs";
export { cutoverPending } from "./workspace-paths.mjs";

// Landing and its verification (CLI, extension, desktop delivery).
export { assertWorkspaceDelivered, landWorkspace, prepareWorkspaceContinuation } from "./workspace-landing.mjs";
export { landingPreview } from "./landing-steps.mjs";
export { planRelease, releaseIntegration } from "./release.mjs";
export { RequiredVerificationError, runRequiredVerification } from "./required-verification.mjs";
export { classifyCapabilityProbe, normalizeDeclaredVerification, normalizeVerificationDeclaration } from "./verification-policy.mjs";
export { redactVerificationOutput } from "./verification-failure.mjs";
export { latestPostLandResult, runPostLandVerification } from "./post-land-verification.mjs";

// Repository policy and post-integration finalization (desktop, peach-pi scripts).
export { parseExecutionPolicy, readExecutionPolicy, readIntegrationPolicy, resolveIntegrationBranch } from "./execution-policy.mjs";
export { declaredPublicationRemote } from "./source-publication-policy.mjs";
export { postIntegrationPolicy } from "./post-integration-policy.mjs";
export { SourcePreparationFailure, finalizationGit, withFinalizationSource } from "./post-integration-source.mjs";
export { finalizePostIntegration } from "./post-integration-finalization.mjs";

// Process and text utilities the desktop shares with the closure.
export { landingCommandEnvironment } from "./workspace-command.mjs";
export { redactAndBoundProcessOutput, runBoundedProcess, sanitizedProcessEnv, setProcessBroker } from "./bounded-process.mjs";
export { truncateUtf8 } from "./utf8.mjs";
