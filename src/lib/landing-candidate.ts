import type { MigrationFinalizationPolicy } from "./execution-policy.ts";
import type { LandingAdapter, LandingRevision } from "./landing-steps.ts";
import type { WorkspaceContext } from "./workspace-jj.ts";
import type { VerificationEvidence } from "./verification-policy.ts";

/** Workspace identities and committed policy used to prepare a candidate. */
export type CandidateContext = {
  current: { name: string; root: string };
  integration: { name: string; root: string };
  integrationBranch: string;
  /** Verification, publication and migration policy read by landing steps. */
  configuration: { requiredLandingVerification: unknown[]; remote?: string | null; migrationFinalization?: MigrationFinalizationPolicy | null };
};
/** What an Isolated landing did with the primary checkout; it never blocks integration or push. */
export type PrimaryCheckoutOutcome = {
  /** `moved` onto the new integration, already `current`, or `left` in place. */
  action: "moved" | "current" | "left";
  reason?: string;
  /** Something the primary checkout's owner should resolve, such as a conflict. */
  warning?: string;
};
/** Internal adapters and progress callbacks for candidate integration. */
export type CandidateOptions = {
  adapter: LandingAdapter;
  operationId?: string;
  environment?: () => NodeJS.ProcessEnv;
  /** Runs migration generation and verification commands (default: a bounded local process). */
  runCommand?: (request: import("./bounded-process.ts").BoundedProcessRequest, purpose?: import("./migration-candidate.ts").MigrationRunPurpose) => Promise<import("./bounded-process.ts").BoundedProcessResult>;
  onProgress?: (line: string) => void;
  onStage?: (stage: "rebasing" | "verifying" | "integrating" | "cleaning") => void;
};
/** Host operations used by the shared candidate transition. */
export type LandingIO = {
  landingPreview(cwd: string): Promise<{ context: CandidateContext; target: LandingRevision }>;
  ensureLandingDescription(cwd: string, context: CandidateContext, target: LandingRevision): Promise<LandingRevision>;
  assertStackConflictFree(cwd: string, branch: string, changeId: string): Promise<unknown>;
  jj(cwd: string, args: string[]): Promise<string>;
  revisionFacts(cwd: string, revision: string): Promise<LandingRevision>;
  /** Frozen install of the rebased candidate; fails, restoring source, if the install edits it. */
  prepareCandidateDependencies(cwd: string, context: CandidateContext, candidate: LandingRevision, progress?: (line: string) => void): Promise<void>;
  writeLandingState(context: CandidateContext, artifact: LandingRevision, verification: VerificationEvidence, phase: string, operationId?: string): Promise<unknown>;
  readJsonOptional(path: string): Promise<Record<string, unknown> | null>;
  statePath(name: string): string;
};

/** The runner's landing candidate transition: rebase, finalize, verify, integrate. */
import { migrationCandidate } from "./migration-candidate.ts";
import { writeWorkspaceJson } from "./workspace-transaction.ts";

export async function integrateLandingCandidate(cwd: string, options: CandidateOptions, io: LandingIO): Promise<{ context: CandidateContext; artifact: LandingRevision; base: string; verification: VerificationEvidence; cleanupPending: boolean; cleanupError?: string; primaryCheckout?: PrimaryCheckoutOutcome }> {
  const { landingPreview, ensureLandingDescription, jj, assertStackConflictFree, revisionFacts, prepareCandidateDependencies, writeLandingState, readJsonOptional, statePath } = io;
  const { adapter } = options;
  const preview = await landingPreview(cwd);
  const { context } = preview;
  const direct = context.current.name === "default";
  const target = await ensureLandingDescription(cwd, context, preview.target);
  // The primary checkout's working copy never gates an Isolated landing: housekeeping
  // moves it afterwards only when that is safe (see primaryCheckoutDisposition).
  // The runner's serial queue protects generation and verification. The repository
  // transaction covers only the final identity check and bookmark transition.
  const migration = await migrationCandidate(cwd, context, io, options);
  try {
    options.onStage?.("rebasing");
    await jj(cwd, ["rebase", "--branch", target.changeId, "--onto", context.integrationBranch]);
    await assertStackConflictFree(cwd, context.integrationBranch, target.changeId);
    const base = await revisionFacts(cwd, context.integrationBranch);
    let candidate = await revisionFacts(cwd, target.changeId);
    await prepareCandidateDependencies(cwd, context, candidate, options.onProgress);
    candidate = await (adapter.finalizeCandidate?.(candidate, base) ?? migration.finalize(candidate, base));
    const assertIdentity = async () => {
      const drift = await jj(cwd, ["diff", "--from", candidate.commitId, "--to", "@", "--summary"]);
      if ((await revisionFacts(cwd, target.changeId)).commitId !== candidate.commitId || drift)
        throw new Error("Verification checkout differs from the landing candidate; repair and rerun landing");
      if ((await revisionFacts(cwd, context.integrationBranch)).commitId !== base.commitId)
        throw new Error("Integration bookmark moved during verification; rerun landing against the new base");
    };
    await assertIdentity();
    // A publication retry may still be on the empty child created by the first
    // landing. Gates inspecting @ must see the exact candidate, not just its tree.
    if ((await revisionFacts(cwd, "@")).commitId !== candidate.commitId) {
      await jj(cwd, ["edit", candidate.commitId]);
      await assertIdentity();
    }
    options.onStage?.("verifying");
    const verification = await adapter.verify({ base: base.commitId, candidate: candidate.commitId });
    await assertIdentity();
    // The runner's queue runs one landing or release at a time: nothing else moves the bookmark here.
    await assertIdentity();
    if (!direct) await writeLandingState(context, candidate, verification, "prepared", options.operationId);
    options.onStage?.("integrating");
    await jj(cwd, ["bookmark", "set", context.integrationBranch, "--revision", candidate.commitId]);
    if (!direct) await writeLandingState(context, candidate, verification, "landed", options.operationId);
    options.onStage?.("cleaning");
    const state = direct ? { artifactCommitId: candidate.commitId } : await readJsonOptional(statePath(context.current.name));
    const cleanup = await finishLanding(context, state!, io);
    return { context, artifact: candidate, base: base.commitId, verification, ...cleanup };
  } catch (error) {
    try { await migration.rollback(); } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Landing failed and migration rollback requires reconciliation\n${error instanceof Error ? error.message : String(error)}\nRollback could not restore the checkout; retained errors require reconciliation`);
    }
    throw error;
  }
}

/**
 * What an Isolated landing does with the primary checkout. It moves only an empty
 * `@` whose parents are already integrated; edits, conflicts and unintegrated
 * ancestry stay exactly where they are (the next Direct landing rebases them). None
 * of these block integration or push.
 */
async function primaryCheckoutDisposition(context: CandidateContext, io: LandingIO): Promise<PrimaryCheckoutOutcome> {
  const { revisionFacts, jj } = io;
  const root = context.integration.root;
  const facts = await revisionFacts(root, "@");
  if (facts.conflict) return { action: "left", reason: "conflicted",
    warning: "The primary checkout has conflicts; it was left in place for its owner to resolve" };
  if (!facts.empty) return { action: "left", reason: "unlanded-changes" };
  if (await jj(root, ["log", "-r", `parents(@) ~ ::${context.integrationBranch}`, "--no-graph", "-T", "commit_id"]))
    return { action: "left", reason: "unintegrated-ancestry" };
  const parent = await revisionFacts(root, "@-");
  const integration = await revisionFacts(root, context.integrationBranch);
  if (parent.commitId === integration.commitId) return { action: "current" };
  await jj(root, ["new", context.integrationBranch]);
  return { action: "moved" };
}

/** Move the primary checkout (when safe) and the landed workspace onto the new integration. */
export async function finishLanding(context: WorkspaceContext | CandidateContext, state: Record<string, unknown> & { primaryCheckout?: PrimaryCheckoutOutcome; cleanupPending?: boolean; cleanupError?: string }, io: LandingIO): Promise<{ cleanupPending: boolean; cleanupError?: string; primaryCheckout?: PrimaryCheckoutOutcome }> {
  const { revisionFacts, jj, statePath } = io;
  delete state.primaryCheckout;
  try {
    const currentDefault = context.current.name === "default" ? await revisionFacts(context.integration.root, "@") : null;
    if (currentDefault && currentDefault.commitId === state.artifactCommitId) {
      await jj(context.integration.root, ["new", context.integrationBranch]);
      state.primaryCheckout = { action: "moved" };
    } else {
      state.primaryCheckout = await primaryCheckoutDisposition(context, io);
    }
    const current = await revisionFacts(context.current.root, "@");
    if (!current.empty && current.commitId === state.artifactCommitId) await jj(context.current.root, ["new", state.artifactCommitId]);
    state.cleanupPending = false;
    delete state.cleanupError;
  } catch (error) {
    state.cleanupPending = true;
    state.cleanupError = error instanceof Error ? error.message : String(error);
  }
  if (context.current.name !== "default") await writeWorkspaceJson(statePath(context.current.name), state);
  return { cleanupPending: state.cleanupPending, ...(state.cleanupError ? { cleanupError: state.cleanupError } : {}),
    ...(state.primaryCheckout ? { primaryCheckout: state.primaryCheckout } : {}) };
}
