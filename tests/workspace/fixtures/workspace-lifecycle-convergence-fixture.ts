import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspace } from "../../../src/lib/workspace/workspace-create.ts";
import { metadataHome } from "../../../src/lib/workspace/workspace-paths.ts";
import { landThroughTestRunner } from "../../support/test-runner.ts";
import type { project } from "../../support/workspace-project.ts";

const cli = fileURLToPath(new URL("../../../src/launcher/workspace.ts", import.meta.url));

export function runCli(cwd: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    execFile("bun", [cli, ...args], { cwd }, (error, stdout, stderr) =>
      resolveRun({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

export const metadataFile = (name: string) => join(metadataHome(), `${name}.json`);

/** A workspace that has landed `file`, kept for the test. */
export async function landed(f: Awaited<ReturnType<typeof project>>, file: string) {
  const workspace = await createWorkspace(file, f.repo);
  await writeFile(join(workspace.workspacePath, file), `${file}\n`);
  // Held while it lands, so the landing keeps it for the test.
  const result = await landThroughTestRunner(f, workspace.workspacePath, { keep: true });
  assert.equal(result.ok, true, result.lines.join("\n"));
  return workspace;
}

export const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
