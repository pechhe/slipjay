/**
 * The landing tool's one public entry (`@pechhe/slipjay`). Every consumer
 * outside this directory imports only from here: the desktop through its pinned
 * tag, and the Pi launcher and jj-workspace extension. The closure behind it
 * is self-contained and acyclic; `bun run check` enforces both, and that nothing
 * else imports a module here directly.
 */

// Workspaces: context, assignment, state and housekeeping (launcher, extension, CLI, hooks, desktop).
export { explicitIssueNumber, projectPrefix, revisionFacts, taskWorkspaceName, workspaceContext, workspaceHasUnintegratedWork } from "./workspace-jj.ts";
export {
  assertWorkspaceMutationAllowed, attachWorkspaceIssue, findWorkspace, inspectWorkspace, inspectWorkspaces, landingStatePaths,
  listWorkspaces, readLandedRecord, readLandingState, readWorkspaceMode, renameWorkspace, workspaceContinuationState, writeWorkspaceMode,
} from "./workspace-state.ts";
export { createWorkspace, findIssueWorkspace, recoverIssueWorkspace, resolveStartBase } from "./workspace-create.ts";
export {
  cleanupLandedWorkspace, describeRetention, removeWorkspace, retainedWorkspaceMaterial, retireWorkspace,
} from "./workspace-lifecycle.ts";
export { provisionSpare, readySpares, refillPool, refreshSpares, spareAllowance, startSpareRefill } from "./workspace-pool.ts";
export { pruneEmptyWorkspaces, sweepDisposableWorkspaces } from "./workspace-sweep.ts";
export { withWorkspaceTransaction } from "./workspace-transaction.ts";
export { LANDED_WORKSPACE_REFUSAL, assertWorkspaceNotRetired, cleanupRetentionReason, workspaceContinuationDisposition } from "./workspace-delivery-lifecycle.ts";
export { assertCompletedIssueDelivered, selectImplementationIssue } from "./issue-eligibility.ts";

// The one-time move of Slipway's state from ~/.slipway to ~/.slipjay (CLI, hosts that report it).
export { cutover } from "./cutover.ts";
export { cutoverPending } from "./workspace-paths.ts";

// Landing and its verification (CLI, extension, desktop delivery).
export { landingPreview } from "./landing-steps.ts";
export { planRelease, releaseIntegration } from "./release.ts";
export type { ReleasePlan, ReleaseResult, ReleaseSummary } from "./release.ts";
export { RequiredVerificationError, runRequiredVerification } from "./required-verification.ts";
export { classifyCapabilityProbe, normalizeDeclaredVerification, normalizeVerificationDeclaration } from "./verification-policy.ts";
export { redactVerificationOutput } from "./verification-failure.ts";

// Repository policy and post-integration finalization (desktop, peach-pi scripts).
export { parseExecutionPolicy, readExecutionPolicy, readIntegrationPolicy, resolveIntegrationBranch } from "./execution-policy.ts";
export { declaredPublicationRemote } from "./source-publication-policy.ts";
export { postIntegrationPolicy } from "./post-integration-policy.ts";
export { SourcePreparationFailure, finalizationGit, withFinalizationSource } from "./post-integration-source.ts";
export { finalizePostIntegration } from "./post-integration-finalization.ts";

// Process and text utilities the desktop shares with the closure.
export { landingCommandEnvironment } from "./workspace-command.ts";
export { redactAndBoundProcessOutput, runBoundedProcess, sanitizedProcessEnv, setProcessBroker } from "./bounded-process.ts";
export { truncateUtf8 } from "./utf8.ts";

// Types of the entries above.
export type { RevisionFacts, WorkspaceContext, WorkspaceEntry, WorkspaceMetadata } from "./workspace-jj.ts";
export type { CreatedWorkspace, WorkspaceCreationHooks } from "./workspace-create.ts";
export type { RetirementHooks } from "./workspace-lifecycle.ts";
export type { WorkspaceContinuationDisposition } from "./workspace-delivery-lifecycle.ts";
export type { LandedRecord } from "./workspace-state.ts";
export type { LandingAdapter, LandingPublication, LandingRevision, LandingTail, LandingTailOptions } from "./landing-steps.ts";
export type { RequiredVerificationFailureEvidence } from "./required-verification.ts";
export type { VerificationEvidence } from "./verification-policy.ts";
export type { ExecutionPolicy } from "./execution-policy.ts";
export type { PostIntegrationInput, PostIntegrationResult } from "./post-integration-finalization.ts";
export type { BoundedProcessRequest, BoundedProcessResult, ProcessBroker } from "./bounded-process.ts";

export { landThroughRunner, readLandingOutcome, readLandingHandoff, downloadSubmissionSource, manageRepairClaim, readRunArtifact, runnerLocation, recordClientFacts, readMetricsEvents } from "./runner-client.ts";
export type { ArtifactChunk, CommandArtifact, CommandEvidence, LandingOutcome, CauseClass, ClassifiedFact, ClientFact, OperationEvent, StoredEvent } from "./runner-contract.ts";

export type { SubmissionHandoff } from "./submission-handoff.ts";

export { importSourceBundle } from "./submission-source-export.ts";
