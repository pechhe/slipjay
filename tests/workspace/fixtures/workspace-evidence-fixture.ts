import { jj, project } from "../../support/workspace-project.ts";
import { landThroughTestRunner } from "../../support/test-runner.ts";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspace } from "../../../src/lib/workspace/workspace-create.ts";
import { EMPTY_IDLE_MS } from "../../../src/lib/workspace/workspace-sweep.ts";

type Fixture = Awaited<ReturnType<typeof project>>;

export const later = () => Date.now() + EMPTY_IDLE_MS + 60_000;

export const names = (repo: string) => jj(repo, ["workspace", "list", "-T", 'name ++ "\\n"']).split("\n");

/** Local runtime and review output of a preview, as T3's worktree-local `.t3` home holds. */
export const declared = { ignore: ".t3/\nnotes/\n", generatedPaths: [".t3/userdata"], policy: { evidencePaths: [".t3/review"] } };

export async function landedWorkspace(f: Fixture, task: string) {
  const workspace = await createWorkspace(task, f.repo);
  await writeFile(join(workspace.workspacePath, `${task}.txt`), `${task}\n`);
  jj(workspace.workspacePath, ["describe", "-m", `Add ${task}`]);
  const landed = await landThroughTestRunner(f, workspace.workspacePath, { keep: true });
  assert.equal(landed.ok, true, landed.lines.join("\n"));
  return workspace;
}

export async function previewOutput(root: string) {
  await mkdir(join(root, ".t3", "userdata", "secrets"), { recursive: true });
  await writeFile(join(root, ".t3", "userdata", "secrets", "signing-key.bin"), "secret");
  await mkdir(join(root, ".t3", "review"), { recursive: true });
  await writeFile(join(root, ".t3", "review", "issue-7-review.md"), "Approved.\n");
}
