import type { LandingAdapter, LandingRevision } from "./landing-steps.mjs";
import type { WorkspaceContext } from "./workspace-jj.mjs";
import type { VerificationEvidence } from "./verification-policy.mjs";

export type CandidateContext = {
  current: { name: string; root: string };
  integration: { name: string; root: string };
  integrationBranch: string;
};
/** What an Isolated landing did with the primary checkout; it never blocks integration or push. */
export type PrimaryCheckoutOutcome = {
  /** `moved` onto the new integration, already `current`, `left` in place, or `deferred` by a live Direct writer. */
  action: "moved" | "current" | "left" | "deferred";
  reason?: string;
  /** Something the primary checkout's owner should resolve, such as a conflict. */
  warning?: string;
};
export type CandidateOptions = {
  adapter?: LandingAdapter;
  localOnly?: boolean;
  operationId?: string;
  environment?: () => NodeJS.ProcessEnv;
  onProgress?: (line: string) => void;
  onStage?: (stage: "rebasing" | "verifying" | "integrating" | "cleaning") => void;
};
export type LandingIO = {
  landingPreview(cwd: string): Promise<{ context: CandidateContext; target: LandingRevision }>;
  ensureLandingDescription(cwd: string, context: CandidateContext, target: LandingRevision): Promise<LandingRevision>;
  assertNoForeignPrimaryWriter(integrationRoot: string): Promise<void>;
  assertStackConflictFree(cwd: string, branch: string, changeId: string): Promise<unknown>;
  jj(cwd: string, args: string[]): Promise<string>;
  revisionFacts(cwd: string, revision: string): Promise<LandingRevision>;
  /** Frozen install of the rebased candidate; fails, restoring source, if the install edits it. */
  prepareCandidateDependencies(cwd: string, context: CandidateContext, candidate: LandingRevision, progress?: (line: string) => void): Promise<void>;
  runVerification(context: CandidateContext, progress?: (line: string) => void): Promise<VerificationEvidence>;
  writeLandingState(context: CandidateContext, artifact: LandingRevision, verification: VerificationEvidence, phase: string, localOnly?: boolean, operationId?: string): Promise<unknown>;
  readJsonOptional(path: string): Promise<Record<string, unknown>>;
  statePath(name: string): string;
};
export function integrateLandingCandidate(cwd: string, options: CandidateOptions, io: LandingIO): Promise<{ context: CandidateContext; artifact: LandingRevision; verification: VerificationEvidence; cleanupPending: boolean; cleanupError?: string; primaryCheckout?: PrimaryCheckoutOutcome }>;
export function finishLanding(context: WorkspaceContext, state: Record<string, unknown>, options: CandidateOptions, io: LandingIO): Promise<{ cleanupPending: boolean; cleanupError?: string; primaryCheckout?: PrimaryCheckoutOutcome }>;
