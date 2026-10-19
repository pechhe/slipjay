import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { metadataHome } from "../../../src/lib/workspace/workspace-paths.ts";

const cli = fileURLToPath(new URL("../../../src/launcher/workspace.ts", import.meta.url));

export function runCli(cwd: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    execFile("bun", [cli, ...args], { cwd }, (error, stdout, stderr) =>
      resolveRun({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

export const metadataFile = (name: string) => join(metadataHome(), `${name}.json`);
