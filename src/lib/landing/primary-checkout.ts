import type { RevisionFacts, WorkspaceContext } from "../infra/workspace-jj.ts";
import { writeWorkspaceJson } from "../infra/workspace-transaction.ts";
import type { CandidateContext } from "./landing-candidate.ts";

/** What an Isolated landing did with the primary checkout; it never blocks integration or push. */
export type PrimaryCheckoutOutcome = {
  /** `moved` onto the new integration, already `current`, or `left` in place. */
  action: "moved" | "current" | "left";
  /** Why: `carried-edits` when uncommitted edits moved along; otherwise why it was left. */
  reason?: string;
  /** Something the primary checkout's owner should resolve, such as a conflict. */
  warning?: string;
};

/** Dependencies of the primary checkout after a move; resolves to a warning, never rejects. */
export type PrimaryDependencies = (root: string) => Promise<string | undefined>;

/** Minimal host IO needed to move the primary checkout or finish a landed workspace. */
export type PrimaryCheckoutIO = {
  jj(cwd: string, args: string[]): Promise<string>;
  revisionFacts(cwd: string, revision: string): Promise<Pick<RevisionFacts, "commitId" | "empty" | "conflict">>;
  refreshPrimaryDependencies?: PrimaryDependencies;
};

/**
 * What a landing does with the primary checkout, or, with `carryEdits: false`, what
 * the hourly maintenance pass does with it. It moves `@` onto the new integration
 * when its parents are already integrated: an empty `@` becomes a new empty change
 * there, and (when `carryEdits`) uncommitted edits are rebased along with it. Edits
 * that would conflict there, a conflicted `@` and unintegrated ancestry stay exactly
 * where they are (the next Direct landing rebases them). Maintenance never carries
 * edits: a timer must not rebase a checkout someone is editing. None of these block
 * integration or push.
 */
export async function primaryCheckoutDisposition(
  context: Pick<CandidateContext, "integration" | "integrationBranch">,
  io: PrimaryCheckoutIO,
  options: { carryEdits?: boolean } = {},
): Promise<PrimaryCheckoutOutcome> {
  return withPrimaryDependencies(await movedPrimaryCheckout(context, io, options), context.integration.root, io);
}

/** After a move or when already current, install what the new source needs; a failure is only a warning. */
export async function withPrimaryDependencies(outcome: PrimaryCheckoutOutcome, root: string, io: Pick<PrimaryCheckoutIO, "refreshPrimaryDependencies">): Promise<PrimaryCheckoutOutcome> {
  if (outcome.action === "left" || !io.refreshPrimaryDependencies) return outcome;
  const warning = await io.refreshPrimaryDependencies(root);
  return warning ? { ...outcome, warning } : outcome;
}

async function movedPrimaryCheckout(
  context: Pick<CandidateContext, "integration" | "integrationBranch">,
  io: Pick<PrimaryCheckoutIO, "revisionFacts" | "jj">,
  { carryEdits = true }: { carryEdits?: boolean } = {},
): Promise<PrimaryCheckoutOutcome> {
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
  if (!facts.empty && !carryEdits) return { action: "left", reason: "edits" };
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
export async function finishLanding(
  context: WorkspaceContext | CandidateContext,
  state: Record<string, unknown> & { primaryCheckout?: PrimaryCheckoutOutcome; cleanupPending?: boolean; cleanupError?: string },
  io: PrimaryCheckoutIO & { statePath(workspaceName: string): string },
): Promise<{ cleanupPending: boolean; cleanupError?: string; primaryCheckout?: PrimaryCheckoutOutcome }> {
  const { revisionFacts, jj, statePath } = io;
  delete state.primaryCheckout;
  try {
    const currentDefault = context.current.name === "default" ? await revisionFacts(context.integration.root, "@") : null;
    if (currentDefault && currentDefault.commitId === state.artifactCommitId) {
      await jj(context.integration.root, ["new", context.integrationBranch]);
      state.primaryCheckout = await withPrimaryDependencies({ action: "moved" }, context.integration.root, io);
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
