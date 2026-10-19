import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { landedHome, stateHome } from "./workspace-paths.ts";
export const hasPendingRunnerFacts = (metadata: Record<string, unknown> | null): boolean => Array.isArray(metadata?.pendingRunnerFacts) && metadata.pendingRunnerFacts.length > 0;
/** Retirement policy shared by Peach and vanilla Pi. There is no archive period:
 * a delivered checkout is eligible at landing, once callers prove identity,
 * ancestry, publication and exclusive access. */
export function cleanupRetentionReason(
  state: { phase?: string; workspaceName: string; workspacePath: string; integrationRoot?: string;
    integrationBranch: string; workspaceImplementationChangeId?: string; artifactChangeId?: string; artifactCommitId: string;
    issueNumber?: number; recoveryNeeded?: boolean; cleanupPending?: boolean; landedAt?: string; cleanupEligibleAt?: string } | null,
  context: { current: { name: string; root: string }; integration: { root: string }; integrationBranch: string },
  metadata: Record<string, unknown> | null,
): string | null {
  if (!state || state.phase !== "landed") return "not-landed";
  if (hasPendingRunnerFacts(metadata)) return "pending-runner-facts";
  if (state.workspaceName !== context.current.name
    || state.workspacePath !== context.current.root
    || state.integrationRoot !== context.integration.root
    || state.integrationBranch !== context.integrationBranch
    || !state.artifactChangeId
    || !/^[a-f0-9]{40,64}$/i.test(state.artifactCommitId ?? "")
    || (state.issueNumber ?? null) !== (metadata?.issueNumber ?? null)
    || (state.issueNumber && metadata?.implementationChangeId && metadata.implementationChangeId !== (state.workspaceImplementationChangeId ?? state.artifactChangeId))) return "identity-mismatch";
  if (state.recoveryNeeded || state.cleanupPending) return "recovery-needed";
  return null;
}

/** One refusal for writes into a workspace whose work has landed. The workspace
 * is finished: follow-up work, including same-task follow-up, starts in a fresh
 * workspace on the current integration branch, which already contains it. */
export const LANDED_WORKSPACE_REFUSAL: string = "This workspace's work has landed, so it is read-only. "
  + "Make follow-up changes in a fresh workspace on the current integration branch: "
  + "in Peach the Thread's next message moves it to one; in vanilla Pi the turn ends by moving there.";

/** Whether a workspace is active, can resume, has landed, or needs recovery. */
export type WorkspaceContinuationDisposition =
  | { kind: "active" }
  | { kind: "resume_unfinished"; artifactCommitId: string }
  | { kind: "landed_source"; artifactCommitId: string }
  | { kind: "recovery_required"; reason: string };

/**
 * Decide whether a historical landing still retires this workspace. A prior
 * receipt remains immutable history. New source may continue only when the
 * same workspace and Issue still own it, the exact landed artifact remains
 * integrated, and later unintegrated source is now present.
 * Writer ownership remains a separate authority check.
 */
export function workspaceContinuationDisposition(
  state: { phase?: string; workspaceName: string; workspacePath: string; integrationRoot?: string;
    integrationBranch: string; artifactCommitId: string; issueNumber?: number } | null,
  evidence: { workspaceName: string; workspacePath: string; integrationRoot: string; integrationBranch: string;
    issueNumber: number | null; hasUnintegratedWork: boolean; landedArtifactIntegrated: boolean },
): WorkspaceContinuationDisposition {
  if (!state || state.phase !== "landed") return { kind: "active" };
  const identityMatches = state.workspaceName === evidence.workspaceName
    && resolve(state.workspacePath) === resolve(evidence.workspacePath)
    && Boolean(state.integrationRoot)
    && resolve(state.integrationRoot!) === resolve(evidence.integrationRoot)
    && state.integrationBranch === evidence.integrationBranch
    && (state.issueNumber ?? null) === (evidence.issueNumber ?? null)
    && /^[a-f0-9]{40,64}$/i.test(state.artifactCommitId ?? "");
  if (!identityMatches) {
    return { kind: "recovery_required", reason: "historical-landing-identity-mismatch" };
  }
  if (!evidence.landedArtifactIntegrated) {
    return { kind: "recovery_required", reason: "historical-landed-artifact-not-integrated" };
  }
  if (evidence.hasUnintegratedWork) {
    return { kind: "resume_unfinished", artifactCommitId: state.artifactCommitId };
  }
  return { kind: "landed_source", artifactCommitId: state.artifactCommitId };
}

/** Refuse writes when a workspace sidecar records a landed delivery. */
export async function assertWorkspaceNotRetired(workspaceName: string): Promise<void> {
  if (workspaceName === "default") return;
  for (const file of [join(stateHome(), workspaceName + ".json"), join(landedHome(), workspaceName + ".json")]) {
    let state: { workspaceName?: string; phase?: string } | null;
    try { state = JSON.parse(await readFile(file, "utf8")) as typeof state; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (state?.workspaceName === workspaceName && state.phase === "landed") {
      throw new Error(LANDED_WORKSPACE_REFUSAL);
    }
  }
}
