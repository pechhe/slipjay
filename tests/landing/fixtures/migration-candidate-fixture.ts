import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createWorkspace } from "../../../src/lib/workspace/workspace-create.ts";
import { jj, project } from "../../support/workspace-project.ts";
import { landThroughTestRunner } from "../../support/test-runner.ts";

export const advance = (cwd: string, title: string) => { jj(cwd, ["commit", "-m", title]); jj(cwd, ["bookmark", "set", "main", "-r", "@-"]); jj(cwd, ["git", "push", "--bookmark", "main"]); };
export async function write(root: string, path: string, value: string) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); }

export async function fixture(generate: string) {
  const f = await project({ ignore: "node_modules\n", policy: { migrationFinalization: {
    mode: "late_bound_serialized", triggerPaths: ["schema"], artifactPaths: ["migrations"],
    generate: { executable: "node", args: ["generate.mjs"] }, verify: { executable: "node", args: ["verify.mjs"] },
  } } });
  await write(f.repo, "schema/source", "old");
  await write(f.repo, "generate.mjs", generate);
  // Logs are external; verifier must not edit the candidate.
  await write(f.repo, "verify.mjs", `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(join(f.root, "migration-verified"))}, "yes");`);
  advance(f.repo, "Configure migration");
  const workspace = (await createWorkspace("migration fixture", f.repo)).workspacePath;
  await write(workspace, "schema/source", "new");
  jj(workspace, ["describe", "-m", "Change schema"]); jj(workspace, ["new"]);
  const remoteMain = () => execFileSync("git", ["--git-dir", f.remote, "rev-parse", "main"], { encoding: "utf8" }).trim();
  const land = async () => { const result = await landThroughTestRunner(f, workspace); return { ...result, output: result.lines.join("\n") }; };
  return { ...f, workspace, remoteMain, land };
}

export const append = 'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("migrations",{recursive:true}); writeFileSync("migrations/0001.sql","generated");';
