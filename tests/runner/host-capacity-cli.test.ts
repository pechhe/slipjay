import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
const fixture = () => {
  const root = join(tmpdir(), `host-capacity-cli-${randomUUID()}-scratch`);
  mkdirSync(join(root, ".slipjay"), { recursive: true });
  return root;
};
const run = (home: string, args: string[]) => spawnSync("bun", [cli, "host-budget", ...args], { encoding: "utf8", timeout: 15_000,
  env: { ...process.env, HOME: home, SLIPJAY_HOME: home, SLIPJAY_LEGACY_HOME: join(home, "missing-legacy") } });

test("unconfigured command wrappers preserve the command's exit status", () => {
  const home = fixture();
  try {
    const result = run(home, ["run", "--job", "fixture", "--", "sh", "-c", "exit 7"]);
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(JSON.parse(run(home, ["policy"]).stdout), { configured: false });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("host policy and shadow polls are shared across CLI processes without starting a workload", () => {
  const home = fixture();
  try {
    writeFileSync(join(home, ".slipjay/config.json"), JSON.stringify({ hostBudget: { mode: "shadow" } }));
    const holder = join(home, "holder");
    writeFileSync(holder, "fixture");
    const request = { id: "a".repeat(32), job: "fixture", lane: "agent", cgroup: "/missing-fixture", owner: { kind: "holder", path: holder, identity: "fixture" } };
    const first = run(home, ["poll", JSON.stringify(request)]);
    assert.equal(first.status, 0, first.stderr);
    const receipt = JSON.parse(first.stdout);
    assert.equal(receipt.outcome, "admitted");
    const replay = run(home, ["poll", JSON.stringify(request)]);
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(JSON.parse(replay.stdout).request.queuedAt, receipt.request.queuedAt);
    const status = JSON.parse(run(home, ["status"]).stdout);
    assert.equal(status.requests.length, 1);
    assert.equal(status.observation.reading?.currentBytes[request.id] ?? null, null, "a missing group is not measured usage zero");
    rmSync(holder);
    const recovered = run(home, ["recover"]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).recovered, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("invalid policy and identities fail explicitly instead of running unbudgeted", () => {
  const home = fixture();
  try {
    writeFileSync(join(home, ".slipjay/config.json"), JSON.stringify({ hostBudget: { mode: "typo" } }));
    const policy = run(home, ["run", "--", "sh", "-c", "echo must-not-run"]);
    assert.notEqual(policy.status, 0);
    assert.equal(policy.stdout, "");
    assert.match(policy.stderr, /mode/);
    const invalid = run(home, ["poll", JSON.stringify({ id: "a".repeat(32), job: "fixture", lane: "agent", cgroup: "/../outside", owner: {} })]);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /invalid host capacity request/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test("explicit smaller bounds fail before execution when unconfigured, malformed or outside the agent profile", () => {
  const home = fixture();
  try {
    const command = ["--", "sh", "-c", "echo must-not-run"];
    const unconfigured = run(home, ["run", "--memory-max", "2G", ...command]);
    assert.notEqual(unconfigured.status, 0);
    assert.match(unconfigured.stderr, /requires configured/);
    assert.equal(unconfigured.stdout, "");
    writeFileSync(join(home, ".slipjay/config.json"), JSON.stringify({ hostBudget: { mode: "enforce" } }));
    for (const args of [["--memory-max", "17G"], ["--memory-max", "off"], ["--memory-max", "4097"], ["--class", "release", "--memory-max", "2G"], ["--memory-max", "2G", "--memory-max", "1G"]]) {
      const result = run(home, ["run", ...args, ...command]);
      assert.notEqual(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /memory-max|usage/);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});


const systemdUsable = process.platform === "linux" && spawnSync("systemctl", ["--user", "show-environment"], { timeout: 5000, stdio: "ignore" }).status === 0;

test.skipIf(!systemdUsable)("an explicit shadow bound caps the whole command slice and records that exact commitment", () => {
  const home = fixture();
  try {
    writeFileSync(join(home, ".slipjay/config.json"), JSON.stringify({ hostBudget: { mode: "shadow" } }));
    const probe = `const fs=require('fs'),p=require('path'); const group=fs.readFileSync('/proc/self/cgroup','utf8').trim().split('\\n').find(l=>l.startsWith('0::')).slice(3); console.log(fs.readFileSync('/sys/fs/cgroup'+p.dirname(group)+'/memory.max','utf8').trim());`;
    const result = run(home, ["run", "--memory-max", "64M", "--job", "bounded fixture", "--", "bun", "-e", probe]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), String(64 * 1024 ** 2));
    const status = JSON.parse(run(home, ["status"]).stdout);
    assert.deepEqual(status.requests, []);
    const completion = status.history.map((entry: { body: string }) => JSON.parse(entry.body)).find((entry: { kind: string }) => entry.kind === "finished");
    assert.equal(completion.request.bytes, 64 * 1024 ** 2);
    assert.equal(completion.request.lane, "agent");
    assert.equal(completion.evidence.memoryEvents.oom_kill, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("an unverifiable cap refuses to start the command and cleans up its unadmitted request", () => {
  const home = fixture();
  try {
    writeFileSync(join(home, ".slipjay/config.json"), JSON.stringify({ hostBudget: { mode: "shadow" } }));
    const bin = join(home, "bin"); mkdirSync(bin);
    const fake = join(bin, "systemctl");
    writeFileSync(fake, `#!/bin/sh\ncase "$*" in\n *--property=ControlGroup*) echo /missing-sj242-fixture;;\n *--property=MemoryMax*) echo infinity;;\n *) exit 0;;\nesac\n`); chmodSync(fake, 0o755);
    const result = spawnSync("bun", [cli, "host-budget", "run", "--memory-max", "64M", "--", "sh", "-c", "echo must-not-run"], {
      encoding: "utf8", timeout: 15_000, env: { ...process.env, HOME: home, SLIPJAY_HOME: home, SLIPJAY_LEGACY_HOME: join(home, "missing-legacy"), PATH: `${bin}:${process.env.PATH}` },
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /could not be verified/);
    assert.deepEqual(JSON.parse(run(home, ["status"]).stdout).requests, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
