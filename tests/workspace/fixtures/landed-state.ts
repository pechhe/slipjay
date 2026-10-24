import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { seedWorkspace } from "./workspace-generation.ts";
import { archiveIntegratedWorkspaceEvidence } from "../../../src/lib/workspace/workspace-finalization.ts";
import { statePath, workspaceMetadata } from "../../../src/lib/workspace/workspace-state.ts";
import { writeWorkspaceJson } from "../../../src/lib/infra/workspace-transaction.ts";
import { jj, project } from "../../support/workspace-project.ts";

/**
 * Seed a delivered checkout for tests of cleanup, coverage and evidence. The
 * source and a distinct flattened artifact are retained in the archive; the
 * checkout moves onto that artifact as the client does. This seeds an immediately
 * cleanup-eligible delivery, without running verification, writing runner receipts
 * or holding the directory with a process. Tests of those transitions use the
 * retained end-to-end coverage:
 * - workspace-runner-landing-archive.test.ts: publication and local archive.
 * - workspace-housekeeping-cleanup.test.ts: runner/CLI cleanup and held directory.
 * - workspace-sweep-landing.test.ts: detached cleanup after an actual landing.
 * - workspace-lifecycle-convergence-issue.test.ts: delivery and Issue refusal.
 * Call-site conversions refer to this list rather than duplicating it.
 */
export async function landedState(f: Awaited<ReturnType<typeof project>>, task: string, file = `${task}.txt`) {
  const workspace = await seedWorkspace(task, f.repo);
  await writeFile(join(workspace.workspacePath, file), `${task}\n`);
  jj(workspace.workspacePath, ["describe", "-m", `Add ${task}`]);
  const source = jj(workspace.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
  jj(f.repo, ["new", "main"]);
  jj(f.repo, ["restore", "--from", source]);
  jj(f.repo, ["describe", "-m", `Publish ${task}`]);
  const [artifactCommitId, artifactChangeId] = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", 'commit_id ++ "\\n" ++ change_id']).split("\n");
  jj(f.repo, ["bookmark", "set", "main", "-r", artifactCommitId!]);
  jj(f.repo, ["new", "main"]);
  jj(f.repo, ["git", "push", "--bookmark", "main"]);
  const metadata = await workspaceMetadata(workspace.current.name);
  const landedAt = new Date().toISOString();
  const state = {
    version: 1, phase: "landed" as const, cleanupPending: false,
    workspaceName: workspace.current.name, workspacePath: workspace.workspacePath,
    integrationRoot: f.repo, integrationBranch: "main", artifactCommitId: artifactCommitId!,
    artifactChangeId: artifactChangeId!, publishedSource: source, operationId: `fixture-${workspace.current.name}`,
    landedAt, cleanupEligibleAt: landedAt,
    workspaceImplementationChangeId: metadata?.implementationChangeId,
    ...(typeof metadata?.issueNumber === "number" ? { issueNumber: metadata.issueNumber } : {}),
  };
  await writeWorkspaceJson(statePath(workspace.current.name), state);
  await archiveIntegratedWorkspaceEvidence(jj(f.repo, ["git", "root"]), state);
  // Successful publication drops the submitted source and starts an empty
  // continuation on the artifact. `keep` holds the directory, not its old base.
  jj(workspace.workspacePath, ["abandon", source]);
  jj(workspace.workspacePath, ["new", artifactCommitId!]);
  return workspace;
}
