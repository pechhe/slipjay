import { jj, project } from "../../support/workspace-project.ts";
import { landThroughTestRunner } from "../../support/test-runner.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspace } from "../../../src/lib/workspace/workspace-create.ts";
import { readLandingState } from "../../../src/lib/workspace/workspace-state.ts";
import type { PrimaryCheckoutOutcome } from "../../../src/lib/landing/landing-candidate.ts";

// An Isolated landing integrates and pushes whatever the primary checkout holds, and
// moves that checkout onto integrated ancestry, carrying uncommitted edits that apply cleanly.

type Fixture = Awaited<ReturnType<typeof project>>;
const cli = fileURLToPath(new URL("../../../src/launcher/workspace.ts", import.meta.url));
export const status = (cwd: string) => new Promise<Record<string, unknown>>((resolveStatus, reject) =>
  execFile("bun", [cli, "status"], { cwd }, (error, stdout) => error ? reject(error) : resolveStatus(JSON.parse(stdout))));

export const primary = (f: Fixture) => ({
  change: jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "change_id"]),
  parent: jj(f.repo, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]),
  conflict: jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "conflict"]) === "true",
});

export async function land(f: Fixture, file: string) {
  const workspace = await createWorkspace(file, f.repo);
  await writeFile(join(workspace.workspacePath, file), `${file}\n`);
  // Kept, so its landing record (where the primary checkout outcome lives) stays readable.
  const landed = await landThroughTestRunner(f, workspace.workspacePath, { keep: true });
  assert.equal(landed.ok, true, landed.lines.join("\n"));
  assert.equal(f.remoteFile(file), `${file}\n`);
  const result = (await readLandingState(workspace.current.name, { readOnly: true }))! as { artifactCommitId: string; cleanupPending?: boolean; primaryCheckout?: PrimaryCheckoutOutcome };
  return { workspace, result };
}
