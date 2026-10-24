/**
 * The landing tool's one public entry (`@pechhe/slipjay` and `@pechhe/slipjay/delivery`).
 * Consumers outside this package (the desktop through its pinned tag, the Pi launcher and
 * jj-workspace extension) import only from here; the package export map exposes nothing
 * else. `bun run check` keeps the modules behind it inside `src/`, free of runtime cycles and
 * free of imports of `src/launcher`. It does not read other repositories, so what an
 * external consumer imports is bounded by the export map, not by the checker.
 * See docs/architecture.md.
 */

// Workspaces: context, assignment, state and housekeeping (launcher, extension, CLI, hooks, desktop).
export { explicitIssueNumber, projectPrefix, revisionFacts, taskWorkspaceName, workspaceContext, workspaceHasUnintegratedWork } from "./infra/workspace-jj.ts";
export {
  assertWorkspaceMutationAllowed, attachWorkspaceIssue, findWorkspace, inspectWorkspace, inspectWorkspaces, landingStatePaths,
  listWorkspaces, readLandedRecord, readLandingState, readWorkspaceMode, renameWorkspace, workspaceContinuationState, writeWorkspaceMode,
} from "./workspace/workspace-state.ts";
export { createWorkspace, findIssueWorkspace, recoverIssueWorkspace, resolveStartBase, unusedWorkspaceStartRefusal } from "./workspace/workspace-create.ts";
export { adoptWorkspace } from "./workspace/workspace-adopt.ts";
export { readAttempt, releaseAttempt } from "./workspace/workspace-attempts.ts";
export type { AllocationAttempt, AttemptRelease } from "./workspace/workspace-attempts.ts";
export {
  cleanupLandedWorkspace, describeRetention, removeWorkspace, retainedWorkspaceMaterial, retireWorkspace,
} from "./workspace/workspace-lifecycle.ts";
export { provisionSpare, readySpares, refillPool, refreshSpares } from "./workspace/workspace-pool.ts";
export { spareAllowance, startSpareRefill } from "./workspace/workspace-spares.ts";
export { runHousekeeping, startHousekeeping } from "./workspace/workspace-housekeeping.ts";
export { planDisposableWorkspaces, pruneEmptyWorkspaces, sweepDisposableWorkspaces } from "./workspace/workspace-sweep.ts";
export { evictIdleWorkspaces, EVICTION_IDLE_MS } from "./workspace/workspace-eviction.ts";
export { archiveWorkspace, archiveRefusal, listArchives, processArchiveRequests, readArchive, restoreArchive } from "./workspace/workspace-archive.ts";
export type { PlannedWorkspace } from "./workspace/workspace-sweep.ts";
export { withWorkspaceTransaction } from "./infra/workspace-transaction.ts";
export { LANDED_WORKSPACE_REFUSAL, assertWorkspaceNotRetired, cleanupRetentionReason, workspaceContinuationDisposition } from "./workspace/workspace-delivery-lifecycle.ts";

// The one-time move of Slipway's state from ~/.slipway to ~/.slipjay (CLI, hosts that report it).
export { cutover } from "./workspace/cutover.ts";
export { cutoverPending } from "./workspace/workspace-paths.ts";

// Landing and its verification (CLI, extension, desktop delivery).
export { landingPreview } from "./landing/landing-steps.ts";
export { planRelease, releaseIntegration } from "./release/release.ts";
export type { ReleasePlan, ReleaseResult, ReleaseSummary } from "./release/release.ts";
export { RequiredVerificationError, runRequiredVerification } from "./landing/required-verification.ts";
export { classifyCapabilityProbe, normalizeDeclaredVerification, normalizeVerificationDeclaration } from "./policy/verification-policy.ts";
export { redactVerificationOutput } from "./infra/verification-failure.ts";

// Repository policy and post-integration finalization (desktop, peach-pi scripts).
export { parseExecutionPolicy, readExecutionPolicy, readIntegrationPolicy, resolveIntegrationBranch } from "./policy/execution-policy.ts";
export { setPolicy, showPolicy } from "./policy/policy-command.ts";
export type { PolicySetResult, PolicyView } from "./policy/policy-command.ts";
export { readMachineConfig, runnerSetting, setConfiguredRunner, setMachineSpareLimit } from "./policy/machine-config.ts";
export { declaredPublicationRemote } from "./policy/source-publication-policy.ts";
export { postIntegrationPolicy } from "./policy/post-integration-policy.ts";
export { SourcePreparationFailure, finalizationGit, withFinalizationSource } from "./release/post-integration-source.ts";
export { finalizePostIntegration } from "./release/post-integration-finalization.ts";

// Process and text utilities the desktop shares with the closure.
export { landingCommandEnvironment } from "./infra/workspace-command.ts";
export { redactAndBoundProcessOutput, runBoundedProcess, sanitizedProcessEnv, setProcessBroker } from "./infra/bounded-process.ts";
export { truncateUtf8 } from "./infra/utf8.ts";

// Types of the entries above.
export type { RevisionFacts, WorkspaceContext, WorkspaceEntry, WorkspaceMetadata } from "./infra/workspace-jj.ts";
export type { CreatedWorkspace, WorkspaceCreationHooks } from "./workspace/workspace-create.ts";
export type { RetirementHooks } from "./workspace/workspace-lifecycle.ts";
export type { WorkspaceContinuationDisposition } from "./workspace/workspace-delivery-lifecycle.ts";
export type { LandedRecord } from "./workspace/workspace-state.ts";
export type { LandingAdapter, LandingPublication, LandingRevision, LandingTail, LandingTailOptions } from "./landing/landing-steps.ts";
export type { RequiredVerificationFailureEvidence } from "./landing/required-verification.ts";
export type { VerificationEvidence } from "./policy/verification-policy.ts";
export type { ExecutionPolicy } from "./policy/execution-policy.ts";
export type { PostIntegrationInput, PostIntegrationResult } from "./release/post-integration-finalization.ts";
export type { BoundedProcessRequest, BoundedProcessResult, ProcessBroker } from "./infra/bounded-process.ts";

export { landThroughRunner, readLandingOutcome, readLandingHandoff, downloadSubmissionSource, manageRepairClaim, readRunArtifact, runnerLocation, recordClientFacts, readMetricsEvents } from "./runner/runner-client.ts";
export type { ArtifactChunk, CommandArtifact, CommandEvidence, LandingOutcome, CauseClass, ClassifiedFact, ClientFact, OperationEvent, StoredEvent } from "./runner/runner-types.ts";

export type { SubmissionHandoff } from "./landing/submission-handoff.ts";

export { importSourceBundle } from "./landing/submission-source-export.ts";
