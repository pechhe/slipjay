import { jj, project } from "./support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

const cli = fileURLToPath(new URL("../src/launcher/workspace.mjs", import.meta.url));
const BUN_VERSION = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();

type Run = { code: number; stdout: string; stderr: string };

function slipjay(cwd: string, args: string[]): Promise<Run> {
  return new Promise((resolveRun) => {
    execFile(process.execPath, [cli, ...args], { cwd, env: process.env, timeout: 120_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolveRun({ code, stdout, stderr });
    });
  });
}

/** A Bun project whose dependency install prints to stdout, as real installs do. */
async function noisyProject() {
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

test("start --json prints only the result while install output goes to stderr, and resumes an Issue's workspace", async () => {
  const f = await noisyProject();
  try {
    const first = await slipjay(f.repo, ["start", "--integration", "--issue", "7", "--json"]);
    assert.equal(first.code, 0, first.stderr);
    const created = JSON.parse(first.stdout);
    assert.equal(first.stdout, `${JSON.stringify(created)}\n`, "stdout is exactly one JSON line");
    assert.match(first.stderr, /\[deps\] bun install/);
    const workspaces = await realpath(join(homedir(), ".slipjay", "workspaces"));
    assert.ok(created.workspacePath.startsWith(`${workspaces}/`), created.workspacePath);
    assert.equal(created.integrationRoot, f.repo);
    assert.deepEqual({ issueNumber: created.issueNumber, created: created.created, reused: created.reused }, { issueNumber: 7, created: true, reused: false });
    assert.ok(existsSync(join(created.workspacePath, "node_modules")), "dependencies installed in the new workspace");

    // From inside that workspace, --integration still allocates repository-wide and resumes the Issue.
    const again = await slipjay(created.workspacePath, ["start", "--integration", "--issue", "7", "--json"]);
    assert.equal(again.code, 0, again.stderr);
    const resumed = JSON.parse(again.stdout);
    assert.deepEqual({ path: resumed.workspacePath, name: resumed.workspaceName, reused: resumed.reused },
      { path: created.workspacePath, name: created.workspaceName, reused: true });
  } finally {
    await f.dispose();
  }
});

test("start rejects an unknown flag, a missing task and an invalid Issue number", async () => {
  const f = await project();
  try {
    for (const args of [["start", "--bogus", "task"], ["start"], ["start", "--json"], ["start", "--issue", "x"]]) {
      const run = await slipjay(f.repo, args);
      assert.equal(run.code, 2, args.join(" "));
      assert.match(run.stderr, /Usage: slipjay start/);
    }
  } finally {
    await f.dispose();
  }
});

test("remove deletes an untouched workspace by path and keeps one with unlanded work", async () => {
  const f = await project();
  try {
    const untouched = (await slipjay(f.repo, ["start", "--integration", "--json", "untouched task"]));
    assert.equal(untouched.code, 0, untouched.stderr);
    const empty = JSON.parse(untouched.stdout);
    const removed = await slipjay(f.repo, ["remove", empty.workspacePath]);
    assert.equal(removed.code, 0, removed.stderr);
    assert.match(removed.stdout, new RegExp(`Removed untouched workspace jj:${empty.workspaceName}`));
    assert.equal(existsSync(empty.workspacePath), false);

    const worked = JSON.parse((await slipjay(f.repo, ["start", "--integration", "--json", "unfinished task"])).stdout);
    await writeFile(join(worked.workspacePath, "work.txt"), "unfinished\n");
    const kept = await slipjay(f.repo, ["remove", worked.workspacePath]);
    assert.equal(kept.code, 1);
    assert.match(kept.stderr, new RegExp(`Kept jj:${worked.workspaceName}: .*unlanded work`));
    assert.ok(existsSync(join(worked.workspacePath, "work.txt")), "unfinished work stays in place");

    const primary = await slipjay(f.repo, ["remove", f.repo]);
    assert.equal(primary.code, 0, primary.stderr);
    assert.match(primary.stdout, /nothing to remove/);
  } finally {
    await f.dispose();
  }
});

test("cleanup takes a workspace path and retains a workspace that has not landed", async () => {
  const f = await project();
  try {
    const started = JSON.parse((await slipjay(f.repo, ["start", "--integration", "--json", "not landed"])).stdout);
    const run = await slipjay(f.repo, ["cleanup", started.workspacePath]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /Workspace retained: /);
    assert.ok(existsSync(started.workspacePath));
  } finally {
    await f.dispose();
  }
});
