import { workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { configureLocalGithubTransport, jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { text as streamText } from "node:stream/consumers";
import type { Readable } from "node:stream";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { recordClientFactsInBackground } from "../../src/lib/runner/runner-client.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { poolRefillLogPath } from "../../src/lib/workspace/workspace-paths.ts";
import { cli, slipjay, noisyProject } from "./fixtures/cli-fixture.ts";

test("start --json prints only the result while install output goes to stderr, and resumes an Issue's workspace", async () => {
  const f = await noisyProject();
  try {
    const first = await slipjay(f.repo, ["start", "--integration", "--issue", "7", "--json"]);
    assert.equal(first.code, 0, first.stderr);
    const created = JSON.parse(first.stdout);
    assert.equal(first.stdout, `${JSON.stringify(created)}\n`, "stdout is exactly one JSON line");
    assert.match(first.stderr, /\[deps\] bun install/);
    assert.match(first.stderr, /noisy install output/, "installer stdout is forwarded to stderr");
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

test("start --result-fd writes the receipt to the requested descriptor", async () => {
  const f = await project();
  try {
    const child = spawn("bun", [cli, "start", "--json", "--result-fd", "3", "explicit receipt"], {
      cwd: f.repo,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    const [code, stdout, stderr, receipt] = await Promise.all([
      new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }),
      streamText(child.stdout!),
      streamText(child.stderr!),
      streamText(child.stdio[3] as Readable),
    ]);
    assert.equal(code, 0, stderr);
    assert.equal(stdout, "");
    const result = JSON.parse(receipt);
    assert.equal(receipt, `${JSON.stringify(result)}\n`);
    assert.equal(result.created, true);
    assert.equal(result.integrationRoot, f.repo);
  } finally { await f.dispose(); }
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

test("start rejects an unknown flag, help, a missing task and an invalid Issue number", async () => {
  const f = await project();
  try {
    for (const args of [["start", "--bogus", "task"], ["start"], ["start", "--json"], ["start", "--issue", "x"], ["start", "--help"], ["start", "-h"]]) {
      const run = await slipjay(f.repo, args);
      assert.equal(run.code, 2, args.join(" "));
      assert.match(run.stderr, /Usage: slipjay start/);
    }
    assert.deepEqual(jj(f.repo, ["workspace", "list", "-T", 'name ++ "\\n"']).split("\n").filter(Boolean), ["default"], "no workspace was created");
    assert.equal(await readFile(join(f.repo, "README.md"), "utf8"), "fixture\n");
  } finally {
    await f.dispose();
  }
});

test("attach-project names a workspace's Forge project, and a later start of that workspace clears it", async () => {
  const f = await project();
  try {
    const session = await createWorkspace("session", f.repo);
    const recorded = async () => (await workspaceMetadata(session.current.name))?.forgeProject;
    assert.equal((await slipjay(session.workspacePath, ["attach-project", "owner/project"])).code, 0);
    assert.equal(await recorded(), "owner/project");
    assert.equal((await slipjay(session.workspacePath, ["attach-project", "owner/other"])).code, 0);
    assert.equal(await recorded(), "owner/other", "the latest acquisition replaces what was there");
    assert.notEqual((await slipjay(session.workspacePath, ["attach-project", "bare"])).code, 0);
    assert.equal((await slipjay(session.workspacePath, ["attach-project", "--clear"])).code, 0);
    assert.equal(await recorded(), undefined);
    assert.notEqual((await slipjay(f.repo, ["attach-project", "owner/project"])).code, 0, "never on the integration checkout");
    await slipjay(session.workspacePath, ["attach-project", "owner/project"]);
    assert.equal((await slipjay(session.workspacePath, ["start", "resume this workspace"])).code, 0);
    assert.equal(await recorded(), undefined, "a start hands over no earlier project");
  } finally {
    await f.dispose();
  }
});

test("a start from a session's own unused workspace is refused, naming attach-issue, and allocates nothing", async () => {
  const f = await project();
  try {
    const session = await createWorkspace("session", f.repo);
    const names = () => jj(f.repo, ["workspace", "list", "-T", 'name ++ "\\n"']).split("\n").filter(Boolean);
    const before = names();
    const started = await slipjay(session.workspacePath, ["start", "--integration", "--issue", "97", "Issue work"]);
    assert.notEqual(started.code, 0);
    assert.match(started.stderr, /slipjay attach-issue 97/);
    assert.deepEqual(names(), before, "no second workspace");
  } finally {
    await f.dispose();
  }
});
