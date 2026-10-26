import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { jj, project } from "../support/workspace-project.ts";
import { landThroughTestRunner } from "../support/test-runner.ts";

const advance = (cwd: string, title: string) => { jj(cwd, ["commit", "-m", title]); jj(cwd, ["bookmark", "set", "main", "-r", "@-"]); jj(cwd, ["git", "push", "--bookmark", "main"]); };
async function write(root: string, path: string, value: string) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); }

const bunVersion = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();

test("landing installs a workspace package the rebase brought in before verification reads it", async () => {
  // The gate imports a package that does not exist when the workspace is allocated.
  const f = await project({ ignore: "node_modules\n", verify: () => 'import("fixture-dependency").then((m) => { if (m.marker !== 42) process.exit(3); })' });
  try {
    await write(f.repo, "package.json", JSON.stringify({ name: "fixture", private: true, packageManager: `bun@${bunVersion}` }));
    execFileSync("bun", ["install"], { cwd: f.repo, stdio: "pipe" });
    advance(f.repo, "Declare package manager");
    const workspace = (await createWorkspace("dependency fixture", f.repo)).workspacePath;
    await write(workspace, "notes.md", "change\n");
    jj(workspace, ["describe", "-m", "Unrelated change"]);

    await write(f.repo, "package.json", JSON.stringify({ name: "fixture", private: true, packageManager: `bun@${bunVersion}`, workspaces: ["packages/*"], dependencies: { "fixture-dependency": "workspace:*" } }));
    await write(f.repo, "packages/dependency/package.json", JSON.stringify({ name: "fixture-dependency", version: "1.0.0", type: "module", exports: "./index.js" }));
    await write(f.repo, "packages/dependency/index.js", "export const marker = 42;");
    execFileSync("bun", ["install"], { cwd: f.repo, stdio: "pipe" });
    advance(f.repo, "Dependency introduced after allocation");
    assert.equal(existsSync(join(workspace, "node_modules/fixture-dependency")), false);

    const result = await landThroughTestRunner(f, workspace);
    assert.equal(result.ok, true, result.lines.join("\n"));
    assert.equal(f.remoteFile("notes.md"), "change\n");
  } finally { await f.dispose(); }
}, 60000);
