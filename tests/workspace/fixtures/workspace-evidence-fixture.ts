import { jj, project } from "../../support/workspace-project.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { landedState } from "./landed-state.ts";
import { EMPTY_IDLE_MS } from "../../../src/lib/workspace/workspace-sweep.ts";

type Fixture = Awaited<ReturnType<typeof project>>;

export const later = () => Date.now() + EMPTY_IDLE_MS + 60_000;

export const names = (repo: string) => jj(repo, ["workspace", "list", "-T", 'name ++ "\\n"']).split("\n");

/** Local runtime and review output of a preview, as T3's worktree-local `.t3` home holds. */
export const declared = { ignore: ".t3/\nnotes/\n", generatedPaths: [".t3/userdata"], policy: { evidencePaths: [".t3/review"] } };

export async function landedWorkspace(f: Fixture, task: string) {
  // Evidence retirement starts after delivery; see landedState's coverage contract.
  return landedState(f, task);
}

export async function previewOutput(root: string) {
  await mkdir(join(root, ".t3", "userdata", "secrets"), { recursive: true });
  await writeFile(join(root, ".t3", "userdata", "secrets", "signing-key.bin"), "secret");
  await mkdir(join(root, ".t3", "review"), { recursive: true });
  await writeFile(join(root, ".t3", "review", "issue-7-review.md"), "Approved.\n");
}
