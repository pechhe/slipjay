import { project } from "../../support/workspace-project.ts";
import { landThroughTestRunner } from "../../support/test-runner.ts";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createWorkspace } from "../../../src/lib/workspace/workspace-create.ts";
import type { PlannedWorkspace } from "../../../src/lib/workspace/workspace-sweep.ts";
import { EMPTY_IDLE_MS } from "../../../src/lib/workspace/workspace-sweep.ts";
import { fileURLToPath } from "node:url";

export const cli = fileURLToPath(new URL("../../../src/launcher/workspace.ts", import.meta.url));

export const later = () => Date.now() + EMPTY_IDLE_MS + 60_000;

export const byName = (plan: PlannedWorkspace[]) => Object.fromEntries(plan.map((entry) => [entry.name, entry]));

export async function landed(f: Awaited<ReturnType<typeof project>>, file: string) {
  const workspace = await createWorkspace(file, f.repo);
  await writeFile(join(workspace.workspacePath, file), `${file}\n`);
  // Held while it lands, so the landing keeps it for the test.
  const result = await landThroughTestRunner(f, workspace.workspacePath, { keep: true });
  assert.equal(result.ok, true, result.lines.join("\n"));
  return workspace;
}
