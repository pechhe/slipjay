import { configureLocalGithubTransport, jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { recordClientFactsInBackground } from "../../src/lib/runner/runner-client.ts";
import { poolRefillLogPath } from "../../src/lib/workspace/workspace-paths.ts";

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
const BUN_VERSION = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();

type Run = { code: number; stdout: string; stderr: string };

function slipjay(cwd: string, args: string[]): Promise<Run> {
  return new Promise((resolveRun) => {
    execFile("bun", [cli, ...args], { cwd, env: process.env, timeout: 120_000 }, (error, stdout, stderr) => {
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

test("a start that misses an empty pool refills it, so the next start claims a spare", async () => {
  const f = await project();
  try {
    const miss = await slipjay(f.repo, ["start", "--integration", "--json", "first"]);
    assert.equal(miss.code, 0, miss.stderr);
    const first = JSON.parse(miss.stdout);
    assert.equal(first.pooled, false);
    assert.equal(first.refill?.started, true, "a fresh start refills the pool");
    const deadline = Date.now() + 60_000;
    while (!(await slipjay(f.repo, ["pool"])).stdout.startsWith("ready")) {
      assert.ok(Date.now() < deadline, "the refill prepared a spare");
      await new Promise((settle) => setTimeout(settle, 200));
    }
    const hit = JSON.parse((await slipjay(f.repo, ["start", "--integration", "--json", "second"])).stdout);
    assert.equal(hit.pooled, true);
  } finally {
    await f.dispose();
  }
});

test("a fixture's teardown stops a process still running against it", async () => {
  const f = await project();
  const child = spawn("node", ["-e", "setTimeout(() => {}, 120000)", f.repo], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid!;
  await f.dispose();
  assert.throws(() => process.kill(pid, 0), "the process is gone before the checkout is removed");
  assert.ok(!existsSync(f.root));
});

test("a start returns without waiting on a runner that never answers", async () => {
  const f = await project();
  const github = await configureLocalGithubTransport(f);
  const sockets = new Set<Socket>();
  // A runner that passes its health check and then never answers a client operation, as a hung one would.
  let operations = 0;
  const runner = createServer((request, response) => {
    if (request.url === "/v1/health") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ runner: "fixture" })); return; }
    operations += 1;
  });
  runner.on("connection", (socket) => { sockets.add(socket); socket.on("error", () => {}); });
  await new Promise<void>((listening) => runner.listen(0, "127.0.0.1", listening));
  const environment = { runner: process.env.SLIPJAY_RUNNER, token: process.env.SLIPJAY_RUNNER_TOKEN };
  process.env.SLIPJAY_RUNNER = `http://127.0.0.1:${(runner.address() as AddressInfo).port}`;
  process.env.SLIPJAY_RUNNER_TOKEN = "fixture-token";
  try {
    const started = await slipjay(f.repo, ["start", "--integration", "--json", "unanswered runner"]);
    assert.equal(started.code, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).created, true);
    const deadline = Date.now() + 10_000;
    while (!operations && Date.now() < deadline) await new Promise((settle) => setTimeout(settle, 50));
    assert.ok(operations > 0, "the facts are still sent, in the background");
  } finally {
    for (const [name, value] of [["SLIPJAY_RUNNER", environment.runner], ["SLIPJAY_RUNNER_TOKEN", environment.token]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const socket of sockets) socket.destroy();
    runner.close();
    github.restore();
    await f.dispose();
  }
});

test("a start still prints its workspace when the background-work log cannot be opened", async () => {
  const f = await project();
  const runner = process.env.SLIPJAY_RUNNER;
  process.env.SLIPJAY_RUNNER = "http://127.0.0.1:1";
  process.env.SLIPJAY_RUNNER_TOKEN ??= "fixture-token";
  try {
    // A directory where the log belongs: opening it for appending fails.
    await rm(poolRefillLogPath(), { force: true });
    await mkdir(poolRefillLogPath(), { recursive: true });
    const started = await slipjay(f.repo, ["start", "--integration", "--json", "unwritable log"]);
    assert.equal(started.code, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).created, true);
    assert.match(started.stderr, /Runner client facts not recorded/);
  } finally {
    if (runner === undefined) delete process.env.SLIPJAY_RUNNER;
    else process.env.SLIPJAY_RUNNER = runner;
    await rm(poolRefillLogPath(), { recursive: true, force: true });
    await f.dispose();
  }
});

test("a recorder that cannot be launched leaves a line in the background-work log", async () => {
  await rm(poolRefillLogPath(), { recursive: true, force: true });
  await recordClientFactsInBackground(join(tmpdir(), "no-such-checkout"), [], { ...process.env, SLIPJAY_RUNNER: "http://127.0.0.1:1" });
  assert.match(await readFile(poolRefillLogPath(), "utf8"), /runner client facts not recorded: .*ENOENT/);
  await rm(poolRefillLogPath(), { force: true });
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
