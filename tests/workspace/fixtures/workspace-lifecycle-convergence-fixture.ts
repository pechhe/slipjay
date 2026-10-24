import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { metadataHome } from "../../../src/lib/workspace/workspace-paths.ts";
import { landedState } from "./landed-state.ts";
import type { project } from "../../support/workspace-project.ts";

const cli = fileURLToPath(new URL("../../../src/launcher/workspace.ts", import.meta.url));

export function runCli(cwd: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    execFile("bun", [cli, ...args], { cwd }, (error, stdout, stderr) =>
      resolveRun({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

export const metadataFile = (name: string) => join(metadataHome(), `${name}.json`);

/** Seed a delivered checkout for lifecycle checks after delivery. */
export async function landed(f: Awaited<ReturnType<typeof project>>, file: string) {
  // See landedState's coverage contract for the retained delivery transitions.
  return landedState(f, file, file);
}

export const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
