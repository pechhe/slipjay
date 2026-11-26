import { jj, project } from "../../support/workspace-project.ts";
import { execFile, execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const cli = fileURLToPath(new URL("../../../src/launcher/workspace.ts", import.meta.url));
export const BUN_VERSION = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();

export type Run = { code: number; stdout: string; stderr: string };

export function slipjay(cwd: string, args: string[]): Promise<Run> {
  return new Promise((resolveRun) => {
    execFile("bun", [cli, ...args], { cwd, env: process.env, timeout: 120_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolveRun({ code, stdout, stderr });
    });
  });
}

/** A Bun project whose dependency install prints to stdout, as real installs do. */
export async function noisyProject() {
  const f = await project({ ignore: "node_modules\n" });
  await writeFile(join(f.repo, "package.json"), JSON.stringify({
    name: "fixture", private: true, packageManager: `bun@${BUN_VERSION}`,
    scripts: { postinstall: "node -e \"console.log('noisy install output')\"" },
  }, null, 2));
  execFileSync("bun", ["install"], { cwd: f.repo, stdio: "pipe" });
  jj(f.repo, ["commit", "-m", "Add a package"]);
  jj(f.repo, ["bookmark", "set", "main", "-r", "@-"]);
  return f;
}
