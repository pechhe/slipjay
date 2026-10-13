import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "vite-plus/test";
import { jj, project } from "./support/workspace-project.ts";

const cli = resolve("src/launcher/workspace.ts");
const native = (cwd: string, args: string[]) => execFileSync("bun", [cli, ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const advance = (cwd: string, title: string) => { jj(cwd, ["commit", "-m", title]); jj(cwd, ["bookmark", "set", "main", "-r", "@-"]); };
async function write(root: string, path: string, value: string) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value); }

test("landing installs a workspace package the rebase brought in before verification reads it", async () => {
  // The gate imports a package that does not exist when the workspace is allocated.
  const f = await project({ ignore: "node_modules\n", verify: () => 'import("fixture-dependency").then((m) => { if (m.marker !== 42) process.exit(3); })' });
  try {
    await write(f.repo, "package.json", JSON.stringify({ name: "fixture", private: true, packageManager: "bun@1.4.2" }));
    execFileSync("bun", ["install"], { cwd: f.repo, stdio: "pipe" });
    advance(f.repo, "Declare package manager");
    const workspace = JSON.parse(native(f.repo, ["start", "--integration", "--json", "dependency fixture"])).workspacePath as string;
    await write(workspace, "notes.md", "change\n");
    jj(workspace, ["describe", "-m", "Unrelated change"]);

    await write(f.repo, "package.json", JSON.stringify({ name: "fixture", private: true, packageManager: "bun@1.4.2", workspaces: ["packages/*"], dependencies: { "fixture-dependency": "workspace:*" } }));
    await write(f.repo, "packages/dependency/package.json", JSON.stringify({ name: "fixture-dependency", version: "1.0.0", type: "module", exports: "./index.js" }));
    await write(f.repo, "packages/dependency/index.js", "export const marker = 42;");
    execFileSync("bun", ["install"], { cwd: f.repo, stdio: "pipe" });
    advance(f.repo, "Dependency introduced after allocation");
    assert.equal(existsSync(join(workspace, "node_modules/fixture-dependency")), false);

    const result = spawnSync("bun", [cli, "land", "--local-only"], { cwd: workspace, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout + result.stderr, /preparing frozen candidate dependencies/);
    assert.equal(jj(f.repo, ["file", "show", "-r", "main", "notes.md"]), "change");
  } finally { await f.dispose(); }
}, 60000);
