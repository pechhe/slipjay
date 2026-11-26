import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { slipjay } from "./fixtures/cli-fixture.ts";

test("prune --plan --json prints the plan, and prune refuses unknown flags", async () => {
  const f = await project();
  try {
    const idle = JSON.parse((await slipjay(f.repo, ["start", "--integration", "--json", "idle"])).stdout);
    const planOf = (stdout: string) => Object.fromEntries((JSON.parse(stdout) as { name: string; action: string; reason: string }[]).map((entry) => [entry.name, entry]));
    const automatic = await slipjay(f.repo, ["prune", "--plan", "--json"]);
    assert.equal(automatic.code, 0, automatic.stderr);
    assert.equal(planOf(automatic.stdout)[idle.workspaceName]?.reason, "assigned within the idle period");
    const explicit = await slipjay(f.repo, ["prune", "--empty", "--plan", "--json"]);
    assert.equal(planOf(explicit.stdout)[idle.workspaceName]?.action, "remove", "with --empty the plan is the explicit prune's");
    assert.ok(existsSync(idle.workspacePath), "planning removes nothing");
    assert.notEqual((await slipjay(f.repo, ["prune", "--json"])).code, 0);
    assert.ok(jj(f.repo, ["workspace", "list", "-T", 'name ++ "\\n"']).includes(idle.workspaceName));
  } finally {
    await f.dispose();
  }
});

test("--version from a checkout says it runs a source tree", async () => {
  const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
  assert.equal((await slipjay(homedir(), ["--version"])).stdout.trim(), `source tree ${root}`);
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

test("land refuses without a runner location, and --local-only is a usage error", async () => {
  const f = await project();
  const runner = process.env.SLIPJAY_RUNNER;
  delete process.env.SLIPJAY_RUNNER;
  try {
    // This file's disposable HOME has no ~/.slipjay/config.json.
    const refused = await slipjay(f.repo, ["land"]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /No runner location: set SLIPJAY_RUNNER or "runner" in ~\/\.slipjay\/config\.json/);
    const localOnly = await slipjay(f.repo, ["land", "--local-only"]);
    assert.equal(localOnly.code, 1);
    assert.match(localOnly.stderr, /Usage: slipjay land \[--direct\]/);
    assert.equal(jj(f.repo, ["log", "--no-graph", "-r", "main", "-T", "description"]), "Initial", "nothing landed");
  } finally {
    if (runner !== undefined) process.env.SLIPJAY_RUNNER = runner;
    await f.dispose();
  }
}, 60_000);

test("release is retired without planning or confirming, while promote keeps its argument validation", async () => {
  for (const args of [["release"], ["release", "--confirm", "deadbeef"]]) {
    const run = await slipjay(homedir(), args);
    assert.equal(run.code, 2);
    assert.equal(run.stdout, "", "the retired command emits no promotion result");
    assert.match(run.stderr, /slipjay release is retired; use slipjay promote/);
  }
  const promote = await slipjay(homedir(), ["promote", "--bogus"]);
  assert.equal(promote.code, 1);
  assert.match(promote.stderr, /Usage: slipjay promote/);
  assert.doesNotMatch(promote.stderr, /retired/);
});

test("watch and cancel reject unsupported arguments before connecting", async () => {
  for (const args of [["watch"], ["watch", "--json", "extra"], ["cancel"], ["cancel", "--bogus"]]) {
    const result = await slipjay(homedir(), args);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage: slipjay (watch --json|cancel <id>)/);
  }
});

test("config and policy show report each setting with its source, and config set changes the effective spare count", async () => {
  const f = await project({ policy: { spares: 4 } });
  const configPath = join(homedir(), ".slipjay", "config.json");
  const previous = await readFile(configPath, "utf8").catch(() => null);
  try {
    await mkdir(join(homedir(), ".slipjay"), { recursive: true });
    assert.equal((await slipjay(f.repo, ["config", "set", "runner", "ssh://peach-box"])).code, 0);
    const set = await slipjay(f.repo, ["config", "set", "spares", "2"]);
    assert.equal(set.code, 0, set.stderr);
    const source = { integrationBranch: "main", commitId: jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]).trim() };
    assert.deepEqual(JSON.parse(set.stdout), { repository: await realpath(f.repo), declared: 4, machineLimit: 2, effective: 2, source });
    const shown = await slipjay(f.repo, ["config", "--json"]);
    assert.equal(shown.code, 0, shown.stderr);
    const config = JSON.parse(shown.stdout);
    assert.deepEqual(config.runner, { value: "ssh://peach-box", source: "file", file: "ssh://peach-box", overriddenByEnvironment: false });
    assert.deepEqual(config.spares, [{ repository: await realpath(f.repo), declared: 4, machineLimit: 2, effective: 2, source }]);
    assert.equal((await slipjay(f.repo, ["config", "unset", "spares"])).code, 0);
    assert.equal(JSON.parse((await slipjay(f.repo, ["config", "--json"])).stdout).spares[0].effective, 4);
    const policy = await slipjay(f.repo, ["policy", "show", "--json"]);
    assert.equal(policy.code, 0, policy.stderr);
    const view = JSON.parse(policy.stdout);
    assert.equal(view.integrationBranch, "main");
    assert.equal(view.revision, jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]));
    assert.deepEqual([view.settings.spares, view.settings.process], [4, "standard"]);
    // Every failure before submission is a refusal in JSON, apart from any landing outcome.
    for (const args of [["--spares", "2"], ["--base", view.revision, "--patch", "{bad"], ["--base", view.revision, "--patch", "[]"]]) {
      const refused = await slipjay(f.repo, ["policy", "set", ...args]);
      assert.equal(refused.code, 2, refused.stderr);
      assert.equal(JSON.parse(refused.stdout).phase, "refused");
    }
    // With --json-lines the outcome is one compact line, after any operation it followed.
    const lines = await slipjay(f.repo, ["policy", "set", "--json-lines", "--spares", "2"]);
    assert.equal(lines.code, 2, lines.stderr);
    assert.deepEqual(lines.stdout.trim().split("\n").map((line) => JSON.parse(line).phase), ["refused"]);
  } finally {
    if (previous === null) await rm(configPath, { force: true });
    else await writeFile(configPath, previous);
    await f.dispose();
  }
});
