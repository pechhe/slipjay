/**
 * `slipjay policy show` and `slipjay policy set`: read the canonical policy committed on the
 * integration branch, and change its settings fields through the normal landing queue.
 * A patch is made in a workspace of its own on the integration tip, never the primary checkout.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SPARES, EXECUTION_POLICY_PATH, processLevel, readIntegrationPolicy, readPolicyTextAtCommit, RETIRED_POLICY_FIELDS } from "./execution-policy.ts";
import { applyPolicyPatch, parsePolicyPatch, POLICY_BASE_TRAILER, policyDigest } from "./policy-settings.ts";
import type { PolicyPatch } from "./policy-settings.ts";
import type { TimeBudgets } from "./execution-policy.ts";
import { LandingNotSubmitted, landThroughRunner } from "../runner/runner-client.ts";
import { publicationRemote } from "../landing/landing-steps.ts";
import { createWorkspace } from "../workspace/workspace-create.ts";
import { run, workspaceContext } from "../infra/workspace-jj.ts";
import { removeWorkspace } from "../workspace/workspace-lifecycle.ts";
import { listWorkspaces } from "../workspace/workspace-state.ts";

export type PolicyView = {
  integrationBranch: string;
  /** The integration commit the policy was read from: what `policy set --base` names. */
  revision: string;
  digest: string | null;
  /** The file as committed, or null when the repository declares none. */
  declared: Record<string, unknown> | null;
  /** The settings in force, defaults filled in. */
  settings: { spares: number; process: "standard" | "light"; budgets: TimeBudgets | null; requiredLandingVerification: unknown[] };
  /** Declared fields that drive nothing; `policy set` drops them. */
  retired: string[];
};

export type PolicySetResult =
  /** Refused before anything was submitted. */
  | { ok: false; phase: "refused"; reason: string }
  /** The policy already reads as the patch would make it. */
  | { ok: true; phase: "already-applied"; revision: string }
  | { ok: true; phase: "landed"; operationId: string; revision: string; log: string }
  /** The runner refused or failed it before integration: nothing changed. */
  | { ok: false; phase: "rejected"; operationId: string; stage: string; reason: string; log: string }
  /** It was integrated, but finalization or publication has not finished: the runner retries it. */
  | { ok: false; phase: "failed-after-integration"; operationId: string; stage: string; reason: string; log: string }
  /** The submission or its outcome is unknown: rerun the same command to reattach, never to submit twice. */
  | { ok: false; phase: "uncertain"; reason: string; workspacePath: string };

const jj = async (cwd: string, args: string[]) => {
  const result = await run("jj", ["--color=never", ...args], { cwd });
  if (result.code !== 0) throw new Error(`jj ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
};

async function repository(cwd: string) {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error(`Not inside a Jujutsu repository: ${cwd}`);
  return context;
}

/** The policy committed on the integration branch, through the one canonical reader. */
export async function showPolicy(cwd: string): Promise<PolicyView> {
  const context = await repository(cwd);
  const root = context.integration.root;
  const { integrationBranch, commitId, policy } = await readIntegrationPolicy(root, { hintRoot: root });
  const text = await readPolicyTextAtCommit(root, commitId);
  const declared = text === null ? null : JSON.parse(text) as Record<string, unknown>;
  return {
    integrationBranch, revision: commitId, digest: text === null ? null : policyDigest(text), declared,
    settings: { spares: policy?.spares ?? DEFAULT_SPARES, process: processLevel(policy?.process), budgets: policy?.budgets ?? null, requiredLandingVerification: policy?.requiredLandingVerification ?? [] },
    retired: RETIRED_POLICY_FIELDS.filter((field) => declared?.[field] !== undefined),
  };
}

/** The workspace task naming one patch of one base, so a rerun finds the attempt it made. */
export const patchTask = (baseDigest: string, patch: PolicyPatch) =>
  `policy set ${createHash("sha256").update(JSON.stringify([baseDigest, Object.entries(patch).sort(([a], [b]) => a.localeCompare(b))])).digest("hex").slice(0, 16)}`;

/** Whether an earlier attempt's change is exactly this patch, as its preparation leaves it. */
async function attemptHolds(workspacePath: string, patched: string, message: string): Promise<boolean> {
  const text = await readFile(join(workspacePath, EXECUTION_POLICY_PATH), "utf8").catch(() => null);
  if (text !== patched) return false;
  const description = await jj(workspacePath, ["log", "-r", "@", "--no-graph", "-T", "description"]).catch(() => "");
  return description === message.trim();
}

/**
 * Apply `patch` to the policy at `base` (a revision `showPolicy` reported) and land it.
 * Refused as stale when the integration branch's policy differs from `base`'s, so two saves
 * from one read never overwrite each other; the runner checks the same again at its base.
 */
export async function setPolicy(cwd: string, options: { base: string; patch: unknown; location: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; onLine?: (line: string) => void; onOperation?: (operationId: string) => void }): Promise<PolicySetResult> {
  const onLine = options.onLine ?? (() => {});
  let patch: PolicyPatch;
  try { patch = parsePolicyPatch(options.patch); }
  catch (error) { return { ok: false, phase: "refused", reason: (error as Error).message }; }
  const context = await repository(cwd);
  const root = context.integration.root;
  const remote = publicationRemote(context);
  if (!remote) return { ok: false, phase: "refused", reason: "policy set lands through the runner, which needs a publication remote" };
  await jj(root, ["--ignore-working-copy", "git", "fetch", "--remote", remote, "--branch", context.integrationBranch]);
  const baseCommit = await jj(root, ["--ignore-working-copy", "log", "--no-graph", "-r", JSON.stringify(options.base), "-T", "commit_id"]).catch(() => "");
  if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) return { ok: false, phase: "refused", reason: `Base revision ${options.base} does not exist here; run slipjay policy show and use its revision` };
  const baseText = await readPolicyTextAtCommit(root, baseCommit);
  if (baseText === null) return { ok: false, phase: "refused", reason: `${options.base} declares no ${EXECUTION_POLICY_PATH}` };
  let patched: string;
  try { patched = applyPolicyPatch(baseText, patch).text; }
  catch (error) { return { ok: false, phase: "refused", reason: `The patched policy is invalid: ${(error as Error).message}` }; }
  const baseDigest = policyDigest(baseText);
  const task = patchTask(baseDigest, patch);
  const message = `Set ${Object.keys(patch).join(", ")} in ${EXECUTION_POLICY_PATH}\n\nA settings change made by slipjay policy set.\n\n${POLICY_BASE_TRAILER}: ${baseDigest}\n`;
  // A rerun after an uncertain outcome reattaches to the attempt it made, never submitting a second.
  // Only an attempt that holds exactly this patch can have been submitted; any other is prepared again.
  const earlier = (await listWorkspaces(root)).find((workspace) => workspace.metadata?.task === task && workspace.root);
  const prepared = earlier ? await attemptHolds(earlier.root, patched, message) : false;
  const current = await readIntegrationPolicy(root, { hintRoot: root });
  const currentText = await readPolicyTextAtCommit(root, current.commitId);
  if (currentText !== null && policyDigest(currentText) === policyDigest(patched)) {
    // Published, perhaps by the runner retrying an integration it held: an earlier attempt is spent.
    if (earlier?.root) await removeWorkspace(root, (await repository(earlier.root)).current.name, { allowWork: true }).catch(() => undefined);
    return { ok: true, phase: "already-applied", revision: current.commitId };
  }
  if (!prepared) {
    if (currentText === null || policyDigest(currentText) !== baseDigest)
      return { ok: false, phase: "refused", reason: `Stale base: ${EXECUTION_POLICY_PATH} on ${current.integrationBranch} has changed since ${options.base.slice(0, 12)}; read it again with slipjay policy show and reapply` };
  }
  let workspacePath = earlier?.root;
  let landing = false;
  try {
    if (prepared) onLine(`Reattaching to the earlier attempt in ${workspacePath}`);
    workspacePath ??= (await createWorkspace(task, root)).workspacePath;
    if (!prepared) {
      // A claimed spare, or an earlier attempt, may trail the tip the policy was read from.
      await jj(workspacePath, ["rebase", "-r", "@", "--onto", current.commitId]);
      await writeFile(join(workspacePath, EXECUTION_POLICY_PATH), patched);
      await jj(workspacePath, ["describe", "-m", message]);
    }
    landing = true;
    const landed = await landThroughRunner(workspacePath, { location: options.location, onLine, resubmitAfterOutcome: false, ...options.onOperation ? { onOperation: options.onOperation } : {}, ...options.env ? { env: options.env } : {}, ...options.signal ? { signal: options.signal } : {} });
    const { operation, logUrl: log } = landed;
    const result = operation.result;
    if (result?.type === "landed") return { ok: true, phase: "landed", operationId: operation.id, revision: result.commitId, log };
    if (result?.type === "failed" && (result.stage === "finalizing" || result.stage === "publishing"))
      return { ok: false, phase: "failed-after-integration", operationId: operation.id, stage: result.stage, reason: result.reason, log };
    if (result?.type === "failed" || result?.type === "cancelled" || result?.type === "declined") {
      // Nothing was integrated: the attempt is spent, and a rerun starts afresh.
      await removeWorkspace(root, (await repository(workspacePath)).current.name, { allowWork: true }).catch(() => undefined);
      return { ok: false, phase: "rejected", operationId: operation.id, stage: result.type === "failed" ? result.stage : result.type, reason: result.reason, log };
    }
    return { ok: false, phase: "uncertain", reason: `Operation ${operation.id} is ${operation.status}; rerun the same command to follow it`, workspacePath };
  } catch (error) {
    if (!workspacePath) throw error;
    // An earlier attempt may have been submitted by the run that prepared it, so only a fresh one is refused.
    if (prepared || landing && !(error instanceof LandingNotSubmitted)) return { ok: false, phase: "uncertain", reason: (error as Error).message, workspacePath };
    // Nothing reached the runner: the attempt is released, so a rerun prepares afresh and checks staleness again.
    await removeWorkspace(root, (await repository(workspacePath)).current.name, { allowWork: true }).catch(() => undefined);
    return { ok: false, phase: "refused", reason: (error as Error).message };
  }
}
