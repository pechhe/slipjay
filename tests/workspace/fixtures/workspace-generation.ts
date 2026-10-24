import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { workspaceContext } from "../../../src/lib/infra/workspace-jj.ts";
import type { WorkspaceContext } from "../../../src/lib/infra/workspace-jj.ts";
import { writeWorkspaceJson } from "../../../src/lib/infra/workspace-transaction.ts";
import { workspaceHome } from "../../../src/lib/workspace/workspace-paths.ts";
import { metadataPath } from "../../../src/lib/workspace/workspace-state.ts";
import { jj } from "../../support/workspace-project.ts";

export type SeededWorkspace = { current: WorkspaceContext["current"]; workspacePath: string };

/**
 * A genuine native JJ generation with creation-time facts for archive, publication
 * and cleanup proofs. This claims neither allocation nor dependency readiness.
 * Full start, adoption, publication and retirement remain covered by
 * workspace-adopt-runner-retirement.test.ts,
 * "published adoption survives lead retirement: remove".
 * landedState names the retained runner/CLI cleanup and Issue end-to-end coverage.
 * Legacy creation-operation recovery and other contribution callers keep createWorkspace.
 */
export async function seedWorkspace(task: string, repo: string, { base = "main" }: { base?: string } = {}): Promise<SeededWorkspace> {
  const name = `fixture-${randomUUID().slice(0, 8)}`;
  const workspacePath = join(workspaceHome(), name);
  await mkdir(workspaceHome(), { recursive: true });
  jj(repo, ["workspace", "add", "--name", name, "--revision", base, workspacePath]);
  const context = await workspaceContext(workspacePath);
  assert.ok(context && context.current.name === name, "the fixture must be the native workspace just created");
  // Capture these before any contribution commit or continuation changes @.
  const adoptionBase = jj(workspacePath, ["--ignore-working-copy", "log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
  const creationOperation = jj(workspacePath, ["op", "log", "-n", "1", "--no-graph", "-T", "self.id()"]);
  await mkdir(dirname(metadataPath(name)), { recursive: true, mode: 0o700 });
  await writeWorkspaceJson(metadataPath(name), {
    version: 1, workspaceName: name, workspacePath: context.current.root, integrationRoot: context.integration.root,
    task, implementationChangeId: context.current.changeId, adoptionBase,
    workspaceCreationOperationId: creationOperation, workspaceCreationName: name, workspaceCreationPath: context.current.root,
    updatedAt: new Date().toISOString(),
  });
  return { current: context.current, workspacePath: context.current.root };
}

