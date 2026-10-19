import type { MigrationFinalizationPolicy } from "../policy/execution-policy.ts";
import type { BuildReader } from "../build/tracker.ts";
import type { LandingAdapter, LandingRevision } from "./landing-steps.ts";
import type { WorkspaceContext } from "../infra/workspace-jj.ts";
import type { VerificationEvidence } from "../policy/verification-policy.ts";

/** Workspace identities and committed policy used to prepare a candidate. */
export type CandidateContext = {
  current: { name: string; root: string };
  integration: { name: string; root: string };
  integrationBranch: string;
  /** Verification, publication and migration policy read by landing steps. */
  configuration: { requiredLandingVerification: unknown[]; remote?: string | null; migrationFinalization?: MigrationFinalizationPolicy | null; tracker?: "github" | "build" };
};
/** What an Isolated landing did with the primary checkout; it never blocks integration or push. */
export type PrimaryCheckoutOutcome = {
  /** `moved` onto the new integration, already `current`, or `left` in place. */
  action: "moved" | "current" | "left";
  /** Why: `carried-edits` when uncommitted edits moved along; otherwise why it was left. */
  reason?: string;
  /** Something the primary checkout's owner should resolve, such as a conflict. */
  warning?: string;
};
/** Internal adapters and progress callbacks for candidate integration. */
export type CandidateOptions = {
  adapter: LandingAdapter;
  operationId?: string;
  /** Runner slot already edits the exact submitted commit; retained earlier rewrites may share its change id. */
  pinnedSource?: boolean;
  environment?: () => NodeJS.ProcessEnv;
  /** Runs migration generation and verification commands (default: a bounded local process). */
  runCommand?: (request: import("../infra/bounded-process.ts").BoundedProcessRequest, purpose?: import("./migration-candidate.ts").MigrationRunPurpose) => Promise<import("../infra/bounded-process.ts").BoundedProcessResult>;
  onProgress?: (line: string) => void;
  onStage?: (stage: "rebasing" | "verifying" | "integrating" | "cleaning") => void;
};
/** Host operations used by the shared candidate transition. */
export type LandingIO = {
  landingPreview(cwd: string): Promise<{ context: CandidateContext; target: LandingRevision }>;
  ensureLandingDescription(cwd: string, context: CandidateContext, target: LandingRevision, readBuild?: BuildReader): Promise<LandingRevision>;
  assertStackConflictFree(cwd: string, branch: string, changeId: string): Promise<unknown>;
  jj(cwd: string, args: string[]): Promise<string>;
  revisionFacts(cwd: string, revision: string): Promise<LandingRevision>;
  /** Frozen install of the rebased candidate; fails, restoring source, if the install edits it. */
  prepareCandidateDependencies(cwd: string, context: CandidateContext, candidate: LandingRevision, progress?: (line: string) => void, runCommand?: CandidateOptions["runCommand"]): Promise<void>;
  writeLandingState(context: CandidateContext, artifact: LandingRevision, verification: VerificationEvidence, phase: string, operationId?: string): Promise<unknown>;
  readJsonOptional(path: string): Promise<Record<string, unknown> | null>;
  statePath(name: string): string;
};

/** The runner's landing candidate transition: rebase, finalize, verify, integrate. */
import { migrationCandidate } from "./migration-candidate.ts";
import { writeWorkspaceJson } from "../infra/workspace-transaction.ts";

/** A prepared immutable candidate. Verification and publication retain its exact parent. */
export type PreparedLandingCandidate = {
  context: CandidateContext;
  artifact: LandingRevision;
  base: string;
  /** Process-local cleanup of generated source in the original verification checkout. */
  rollback(): Promise<void>;
};

export type VerifiedLandingCandidate = PreparedLandingCandidate & { verification: VerificationEvidence };

type IntegratedLandingCandidate = Omit<VerifiedLandingCandidate, "rollback"> & {
  cleanupPending: boolean; cleanupError?: string; primaryCheckout?: PrimaryCheckoutOutcome;
};

async function assertPreparedIdentity(cwd: string, prepared: Pick<PreparedLandingCandidate, "context" | "artifact" | "base">, io: LandingIO, allowEmptyChild = false): Promise<void> {
  const { context, artifact, base } = prepared;
  const drift = await io.jj(cwd, ["diff", "--from", artifact.commitId, "--to", "@", "--summary"]);
  const current = await io.revisionFacts(cwd, "@");
  const exact = current.commitId === artifact.commitId || (allowEmptyChild && current.empty &&
    (await io.jj(cwd, ["log", "-r", "parents(@)", "--no-graph", "-T", 'commit_id ++ "\\n"'])).trim() === artifact.commitId);
  if (!exact || drift)
    throw new Error("Verification checkout differs from the landing candidate; repair and rerun landing");
  if ((await io.revisionFacts(cwd, context.integrationBranch)).commitId !== base)
    throw new Error("Integration bookmark moved during verification; rerun landing against the new base");
}

export async function rollbackFailure(error: unknown, rollback: () => Promise<void>): Promise<never> {
  try { await rollback(); } catch (rollbackError) {
    throw new AggregateError([error, rollbackError], `Landing failed and migration rollback requires reconciliation\n${error instanceof Error ? error.message : String(error)}\nRollback could not restore the checkout; retained errors require reconciliation`);
  }
  throw error;
}

/** Prepare without running the gate, moving integration, or writing landing state. */
export async function prepareLandingCandidate(cwd: string, options: CandidateOptions, io: LandingIO): Promise<PreparedLandingCandidate> {
  const { landingPreview, ensureLandingDescription, jj, assertStackConflictFree, revisionFacts, prepareCandidateDependencies } = io;
  const { adapter } = options;
  const preview = await landingPreview(cwd);
  const { context } = preview;
  const target = await ensureLandingDescription(cwd, context, preview.target);
  const migration = await migrationCandidate(cwd, context, io, options);
  try {
    options.onStage?.("rebasing");
    await rebaseOntoIntegration(cwd, options.pinnedSource ? target.commitId : target.changeId, context.integrationBranch, jj);
    const rebased = options.pinnedSource ? await revisionFacts(cwd, "@") : await revisionFacts(cwd, target.changeId);
    await assertStackConflictFree(cwd, context.integrationBranch, rebased.commitId);
    const base = await revisionFacts(cwd, context.integrationBranch);
    let candidate = rebased;
    await prepareCandidateDependencies(cwd, context, candidate, options.onProgress, options.runCommand);
    candidate = await (adapter.finalizeCandidate?.(candidate, base) ?? migration.finalize(candidate, base));
    const identity = { context, artifact: candidate, base: base.commitId };
    // A retry can still be on an empty child: gates inspecting @ require the exact candidate.
    if ((await revisionFacts(cwd, "@")).commitId !== candidate.commitId) {
      await jj(cwd, ["edit", candidate.commitId]);
    }
    await assertPreparedIdentity(cwd, identity, io);
    return { ...identity, rollback: () => migration.rollback() };
  } catch (error) {
    return rollbackFailure(error, () => migration.rollback());
  }
}

/**
 * Move a candidate onto the integration tip. A plain stack rebases as a branch. A stack holding a
 * merge, such as an upstream update merged into the integration line, moves only its first-parent
 * line: its lowest commit trades the parents it had on the integration for the current tip and keeps
 * its other parents. Rebasing it as a branch would copy every merged-in commit onto the integration.
 * The integration line must be the merge's first parent, as `git merge` and `jj new <branch> <other>` make it.
 */
export async function rebaseOntoIntegration(cwd: string, revision: string, branch: string, jj: LandingIO["jj"]): Promise<void> {
  const ids = async (revset: string, template = 'commit_id ++ "\\n"') =>
    (await jj(cwd, ["log", "-r", revset, "--no-graph", "-T", template])).split(/\s+/).filter(Boolean);
  if ((await ids(`merges() & (${branch}..${revision})`)).length === 0) {
    await jj(cwd, ["rebase", "--branch", revision, "--onto", branch]);
    return;
  }
  const [root] = await ids(`roots((${branch}..${revision}) & first_ancestors(${revision}))`);
  if (!root) return;
  const parents = await ids(root, 'parents.map(|parent| parent.commit_id()).join(" ")');
  const integrated = new Set(await ids(`(${parents.join(" | ")}) & ::${branch}`));
  const destinations = [...new Set(parents.map((parent) => integrated.has(parent) ? branch : parent))];
  await jj(cwd, ["rebase", "--source", root, ...destinations.flatMap((destination) => ["--onto", destination])]);
}

/** Verify the prepared identity; a dependent can prepare while this exact gate runs. */
export async function verifyPreparedCandidate(cwd: string, prepared: PreparedLandingCandidate, options: CandidateOptions, io: LandingIO): Promise<VerifiedLandingCandidate> {
  await assertPreparedIdentity(cwd, prepared, io);
  options.onStage?.("verifying");
  const verification = await options.adapter.verify({ base: prepared.base, candidate: prepared.artifact.commitId });
  await assertPreparedIdentity(cwd, prepared, io);
  return { ...prepared, verification };
}

/** Integrate the exact prepared artifact; this transition never rebases or reruns a gate. */
export async function integratePreparedCandidate(cwd: string, prepared: VerifiedLandingCandidate, options: CandidateOptions, io: LandingIO): Promise<IntegratedLandingCandidate> {
  const { context, artifact, base, verification } = prepared;
  const direct = context.current.name === "default";
  await assertPreparedIdentity(cwd, prepared, io, true);
  if (!direct) await io.writeLandingState(context, artifact, verification, "prepared", options.operationId);
  options.onStage?.("integrating");
  await io.jj(cwd, ["bookmark", "set", context.integrationBranch, "--revision", artifact.commitId]);
  if (!direct) await io.writeLandingState(context, artifact, verification, "landed", options.operationId);
  options.onStage?.("cleaning");
  const state = direct ? { artifactCommitId: artifact.commitId } : await io.readJsonOptional(io.statePath(context.current.name));
  const cleanup = await finishLanding(context, state!, io);
  return { context, artifact, base, verification, ...cleanup };
}

/** Existing callers retain the same prepare/verify/integrate and rollback behavior. */
export async function integrateLandingCandidate(cwd: string, options: CandidateOptions, io: LandingIO): Promise<IntegratedLandingCandidate> {
  const prepared = await prepareLandingCandidate(cwd, options, io);
  try {
    const verified = await verifyPreparedCandidate(cwd, prepared, options, io);
    return await integratePreparedCandidate(cwd, verified, options, io);
  } catch (error) {
    return rollbackFailure(error, prepared.rollback);
  }
}

/**
 * What an Isolated landing does with the primary checkout. It moves `@` onto the new
 * integration when its parents are already integrated: an empty `@` becomes a new
 * empty change there, and uncommitted edits are rebased along with it. Edits that
 * would conflict there, a conflicted `@` and unintegrated ancestry stay exactly where
 * they are (the next Direct landing rebases them). None of these block integration or push.
 */
async function primaryCheckoutDisposition(context: CandidateContext, io: LandingIO): Promise<PrimaryCheckoutOutcome> {
  const { revisionFacts, jj } = io;
  const root = context.integration.root;
  const facts = await revisionFacts(root, "@");
  if (facts.conflict) return { action: "left", reason: "conflicted",
    warning: "The primary checkout has conflicts; it was left in place for its owner to resolve" };
  if (await jj(root, ["log", "-r", `parents(@) ~ ::${context.integrationBranch}`, "--no-graph", "-T", "commit_id"]))
    return { action: "left", reason: "unintegrated-ancestry" };
  const parent = await revisionFacts(root, "@-");
  const integration = await revisionFacts(root, context.integrationBranch);
  if (parent.commitId === integration.commitId) return { action: "current" };
  if (facts.empty) {
    await jj(root, ["new", context.integrationBranch]);
    return { action: "moved" };
  }
  const before = await jj(root, ["op", "log", "--limit", "1", "--no-graph", "-T", "id"]);
  await jj(root, ["rebase", "-r", "@", "--onto", context.integrationBranch]);
  if ((await revisionFacts(root, "@")).conflict) {
    // Restoring the operation puts `@` and the files on disk back exactly as they were.
    await jj(root, ["op", "restore", before]);
    return { action: "left", reason: "edits-conflict",
      warning: "The primary checkout's uncommitted edits conflict with the new integration; they were left in place for its owner to rebase" };
  }
  return { action: "moved", reason: "carried-edits" };
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
