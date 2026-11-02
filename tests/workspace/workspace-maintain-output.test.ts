import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { project } from "../support/workspace-project.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { recordWorkspaceActivity } from "../../src/lib/workspace/workspace-eviction.ts";

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
const HOUR = 60 * 60_000;
/** The listing `workspaceContext` makes, which is what a repository it cannot read fails. */
const LISTING_FAILURE = /^jj --color=never --ignore-working-copy workspace failed/m;

/** A PATH whose `jj` fails, so the pass finds the repository but cannot read it. */
async function brokenJjPath(): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "slipjay-broken-jj-"));
  await writeFile(join(bin, "jj"), "#!/bin/sh\nexit 1\n");
  await chmod(join(bin, "jj"), 0o755);
  return `${bin}:${process.env.PATH ?? ""}`;
}

/**
 * The pass records a request file it cannot parse as a failure. That failure is part of
 * what it did, so the pass says so instead of reporting nothing to do.
 */
test("maintain reports an unreadable request instead of nothing to archive or evict", async () => {
  const home = await mkdtemp(join(tmpdir(), "slipjay-maintain-"));
  const requests = join(home, ".slipjay", "state", "archive-requests");
  await mkdir(requests, { recursive: true });
  await writeFile(join(requests, "broken.json"), "{ not a request");
  // A disposable HOME keeps the pass out of real state, and a home rather than a checkout
  // leaves it nothing to evict.
  const run = (args: string[]) => spawnSync("bun", [cli, "maintain", ...args], {
    cwd: home, env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 30_000,
  });

  const plain = run([]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^failed\tbroken\t.*could not be read/m);
  assert.doesNotMatch(plain.stdout, /Nothing to archive or evict/);

  const json = run(["--json"]);
  assert.equal(json.status, 0, json.stderr);
  const reported = JSON.parse(json.stdout) as { requests: Array<{ requestId: string; outcome: string; reason: string }>; evictions: unknown };
  assert.deepEqual(reported.requests.map(({ requestId, outcome }) => ({ requestId, outcome })), [{ requestId: "broken", outcome: "failed" }]);
  assert.match(reported.requests[0]!.reason, /the request file could not be read/);
  assert.deepEqual(reported.evictions, { results: [], skipped: [] });
});

/**
 * The hourly pass runs eviction with eviction's own default threshold, so a checkout
 * nobody has used for a day or more sheds its dependency trees without anyone passing
 * `--idle-hours` by hand. This documents the 24-hour default; it is not the regression
 * test for the pass that never evicted, which is the failing-jj case below.
 */
test("the hourly pass evicts a checkout idle past its documented 24-hour default", async () => {
  const f = await project();
  try {
    const workspace = await createWorkspace("maintain-idle", f.repo);
    const name = workspace.current.name;
    await writeFile(join(workspace.workspacePath, "package.json"), JSON.stringify({ name: "fixture" }, null, 2));
    await mkdir(join(workspace.workspacePath, "node_modules", "small"), { recursive: true });
    await recordWorkspaceActivity(name, Date.now() - 25 * HOUR);

    const result = spawnSync("bun", [cli, "maintain", "--json"], { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 120_000 });
    assert.equal(result.status, 0, result.stderr);
    const reported = JSON.parse(result.stdout) as { evictions: { results: Array<{ name: string; removedPaths: string[] }> } };
    assert.deepEqual(reported.evictions.results.map((entry) => entry.name), [name]);
    assert.deepEqual(reported.evictions.results[0]!.removedPaths, ["node_modules"]);
    assert.equal(existsSync(join(workspace.workspacePath, "node_modules")), false);
  } finally {
    await f.dispose();
  }
});

/**
 * The pass reported "Nothing to archive or evict" for days on a machine whose cron
 * environment could not find `jj`: a repository it could not read was read as an empty
 * one. It must fail instead, so the next hourly log entry says what is wrong.
 */
test("the hourly pass fails when it cannot read the repository", async () => {
  const f = await project();
  try {
    const result = spawnSync("bun", [cli, "maintain", "--json"], {
      cwd: f.repo, env: { ...process.env, PATH: await brokenJjPath() }, encoding: "utf8", timeout: 120_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /^maintain could not evict: jj --color=never --ignore-working-copy workspace failed/m);
    assert.doesNotMatch(result.stdout, /Nothing to archive or evict/);
    const reported = JSON.parse(result.stdout) as { requests: unknown[]; evictions: unknown; evictionError: string };
    assert.deepEqual(reported.requests, []);
    assert.equal(reported.evictions, null);
    assert.match(reported.evictionError, LISTING_FAILURE);
  } finally {
    await f.dispose();
  }
});

/**
 * Honouring a request consumes its file before eviction runs. A failing eviction must
 * still report what the pass did with the request, in both output modes, and exit 1.
 */
test("maintain reports honoured requests before a failing eviction", async () => {
  const f = await project();
  const requests = join(homedir(), ".slipjay", "state", "archive-requests");
  // A request for a checkout that is already gone is honoured by recording the skip.
  const pending = async (id: string): Promise<string> => {
    const gone = join(f.root, `gone-${id}`);
    await mkdir(requests, { recursive: true });
    await writeFile(join(requests, `${id}.json`), JSON.stringify({ id, workspacePath: gone, requestedAt: new Date().toISOString() }));
    return gone;
  };
  const brokenJj = await brokenJjPath();
  const run = (args: string[]) => spawnSync("bun", [cli, "maintain", ...args], {
    cwd: f.repo, env: { ...process.env, PATH: brokenJj }, encoding: "utf8", timeout: 120_000,
  });
  try {
    await pending("json-gone");
    const json = run(["--json"]);
    assert.equal(json.status, 1, json.stderr);
    const reported = JSON.parse(json.stdout) as { requests: Array<{ requestId: string; outcome: string }>; evictions: unknown; evictionError: string };
    assert.deepEqual(reported.requests.map((entry) => [entry.requestId, entry.outcome]), [["json-gone", "skipped"]]);
    assert.equal(reported.evictions, null);
    assert.match(reported.evictionError, LISTING_FAILURE);

    const gone = await pending("plain-gone");
    const plain = run([]);
    assert.equal(plain.status, 1, plain.stderr);
    assert.match(plain.stdout, new RegExp(`^skipped\\t${gone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\t`, "m"));
    assert.match(plain.stderr, /^maintain could not evict: jj --color=never --ignore-working-copy workspace failed/m);
    assert.doesNotMatch(plain.stdout, /Nothing to archive or evict/);
  } finally {
    await f.dispose();
  }
});
