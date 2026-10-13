/** One shared landing candidate transition, used by both native Pi and the host. */
import { migrationCandidate } from "./migration-candidate.mjs";
import { resolve } from "node:path";
import { withWorkspaceTransaction, writeWorkspaceJson } from "./workspace-transaction.mjs";

export async function integrateLandingCandidate(cwd, options, io) {
  const { landingPreview, ensureLandingDescription, jj, assertStackConflictFree, revisionFacts, prepareCandidateDependencies, runVerification, writeLandingState, readJsonOptional, statePath } = io;
  const adapter = options.adapter ?? {};
  const preview = await (adapter.preview?.() ?? landingPreview(cwd));
  const { context } = preview;
  const direct = context.current.name === "default";
  let target = await ensureLandingDescription(cwd, context, preview.target);
  if (adapter.repairTarget) target = await adapter.repairTarget(target);
  // The primary checkout's working copy never gates an Isolated landing: housekeeping
  // moves it afterwards only when that is safe (see primaryCheckoutDisposition).
  // The machine-wide slot protects generation and verification. The repository
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
    const verification = await (adapter.verify?.({ base: base.commitId, candidate: candidate.commitId }) ?? runVerification(context, options.onProgress));
    await assertIdentity();
    await withWorkspaceTransaction(`integrate:${resolve(context.integration.root)}:${context.integrationBranch}`, async () => {
      await assertIdentity();
      if (!direct) await writeLandingState(context, candidate, verification, "prepared", options.localOnly, options.operationId);
      options.onStage?.("integrating");
      await jj(cwd, ["bookmark", "set", context.integrationBranch, "--revision", candidate.commitId]);
      if (!direct) await writeLandingState(context, candidate, verification, "landed", options.localOnly, options.operationId);
    });
    options.onStage?.("cleaning");
    const state = direct ? { artifactCommitId: candidate.commitId } : await readJsonOptional(statePath(context.current.name));
    const cleanup = await finishLanding(context, state, options, io);
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
 * ancestry stay exactly where they are (the next Direct landing rebases them), and a
 * live Direct writer defers the move. None of these block integration or push.
 */
async function primaryCheckoutDisposition(context, io) {
  const { revisionFacts, jj, assertNoForeignPrimaryWriter } = io;
  const root = context.integration.root;
  // Fence before any jj command in the primary: even a snapshot touches a live writer's checkout.
  if (context.current.name !== "default") {
    try { await assertNoForeignPrimaryWriter(root); }
    catch (error) { return { action: "deferred", reason: error instanceof Error ? error.message : String(error) }; }
  }
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
export async function finishLanding(context, state, options, io) {
  const { revisionFacts, jj, statePath } = io;
  delete state.primaryCheckout;
  try {
    await withWorkspaceTransaction(`integrate:${resolve(context.integration.root)}:${context.integrationBranch}`, async () => {
      const currentDefault = context.current.name === "default" ? await revisionFacts(context.integration.root, "@") : null;
      if (currentDefault && currentDefault.commitId === state.artifactCommitId) {
        await jj(context.integration.root, ["new", context.integrationBranch]);
        state.primaryCheckout = { action: "moved" };
        return;
      }
      state.primaryCheckout = await primaryCheckoutDisposition(context, io);
      // A live Direct writer keeps housekeeping pending so a later cleanup moves the checkout.
      if (state.primaryCheckout.action === "deferred") throw new Error(state.primaryCheckout.reason);
    });
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
