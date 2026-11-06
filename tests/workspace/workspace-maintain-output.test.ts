import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { jj, project } from "../support/workspace-project.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { recordWorkspaceActivity } from "../../src/lib/workspace/workspace-eviction.ts";

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
const HOUR = 60 * 60_000;
/** The listing `workspaceContext` makes, which is what a repository it cannot read fails. */
const LISTING_FAILURE = /^jj --color=never --ignore-working-copy workspace failed/m;

/**
 * A commit on the integration branch, made in another workspace as a landing on
 * another machine leaves it: the checkout people run scripts from stays where it was.
 */
async function advanceIntegration(f: Awaited<ReturnType<typeof project>>, file: string): Promise<{ commit: string; parent: string }> {
  const parent = jj(f.repo, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
  const workspace = await createWorkspace("ahead", f.repo);
  await writeFile(join(workspace.workspacePath, file), `${file}\n`);
  jj(workspace.workspacePath, ["commit", "-m", "Landed elsewhere"]);
  const commit = jj(workspace.workspacePath, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
  jj(workspace.workspacePath, ["bookmark", "set", "main", "-r", commit]);
  return { commit, parent };
}

const maintain = (cwd: string, args: string[] = ["--json"]) => spawnSync("bun", [cli, "maintain", ...args], {
  cwd, env: process.env, encoding: "utf8", timeout: 120_000,
});

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
  assert.deepEqual(reported.evictions, { results: [], skipped: [], unretirable: [] });
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
    const reported = JSON.parse(result.stdout) as { evictions: { results: Array<{ name: string; removedPaths: string[] }>; unretirable: unknown[] } };
    assert.deepEqual(reported.evictions.results.map((entry) => entry.name), [name]);
    assert.deepEqual(reported.evictions.unretirable, [], "a checkout retire can take is not named as unretirable");
    assert.deepEqual(reported.evictions.results[0]!.removedPaths, ["node_modules"]);
    assert.equal(existsSync(join(workspace.workspacePath, "node_modules")), false);
  } finally {
    await f.dispose();
  }
});

/**
 * A settled thread's cleanup calls `retire`, and a refusal leaves the checkout behind by
 * design. Nothing surfaced those: they piled up on a host until someone counted the disk.
 * The pass must name each idle checkout retire would refuse, and why, in both output modes.
 */
test("maintain names idle checkouts that retire would refuse", async () => {
  const f = await project();
  try {
    const workspace = await createWorkspace("maintain-unretirable", f.repo);
    const root = workspace.workspacePath;
    const name = workspace.current.name;
    // A conflict inherited from the base, plus an edit of this checkout's own: the archive
    // may not record the conflicted file as source, so retirement refuses.
    await writeFile(join(root, "f.txt"), "one\n");
    await jj(root, ["commit", "-m", "one"]);
    const one = (await jj(root, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])).trim();
    await jj(root, ["new", "main", "-m", "two"]);
    await writeFile(join(root, "f.txt"), "two\n");
    await jj(root, ["commit", "-m", "two"]);
    const two = (await jj(root, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"])).trim();
    await jj(root, ["new", one, two, "-m", "inherited conflict"]);
    await writeFile(join(root, "notes.md"), "mine\n");
    await recordWorkspaceActivity(name, Date.now() - 25 * HOUR);

    const json = spawnSync("bun", [cli, "maintain", "--json"], { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 120_000 });
    assert.equal(json.status, 0, json.stderr);
    const reported = JSON.parse(json.stdout) as { evictions: { unretirable: Array<{ name: string; root: string; reason: string }> } };
    const entry = reported.evictions.unretirable.find((candidate) => candidate.name === name);
    assert.ok(entry, json.stdout);
    assert.equal(entry.root, root);
    assert.match(entry.reason, /unresolved conflicts, which an archive would record as source/);

    const plain = spawnSync("bun", [cli, "maintain"], { cwd: f.repo, env: process.env, encoding: "utf8", timeout: 120_000 });
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stderr, new RegExp(`^cannot retire\\t${name}\\t.*unresolved conflicts`, "m"));
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

/**
 * On a machine nobody lands from, the primary checkout stayed on an old integrated
 * parent for days: `start` fetched the integration branch but nothing moved the
 * checkout people run the repository's scripts from. The pass must move it onto the
 * head the way `land` does, so landed changes take effect there without a hand-moved
 * `jj new`.
 */
test("maintain moves a clean primary checkout onto the integration head", async () => {
  const f = await project();
  try {
    const { commit, parent } = await advanceIntegration(f, "ahead.txt");
    assert.notEqual(parent, commit, "the integration branch advanced while the primary stayed behind");

    const result = maintain(f.repo);
    assert.equal(result.status, 0, result.stderr);
    const reported = JSON.parse(result.stdout) as { primaryCheckout?: { action: string; reason?: string } };
    assert.deepEqual(reported.primaryCheckout, { action: "moved" });
    assert.equal(jj(f.repo, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]), commit);
    assert.equal(await readFile(join(f.repo, "ahead.txt"), "utf8"), "ahead.txt\n");

    const plain = maintain(f.repo, []);
    assert.equal(plain.status, 0, plain.stderr);
    assert.doesNotMatch(plain.stdout, /primary checkout/, "a checkout already on the head is not reported as moved again");
  } finally {
    await f.dispose();
  }
});

/**
 * The pass is a timer, not a person: it must never carry or rebase a checkout that
 * holds work of its own. Uncommitted edits and unlanded commits both stay where they
 * are, exactly as `land` leaves a conflicted one.
 */
test("maintain leaves a primary checkout that holds its own work where it is", async () => {
  const f = await project();
  try {
    await writeFile(join(f.repo, "local.txt"), "unlanded\n");
    const change = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "change_id"]);
    const { parent, commit } = await advanceIntegration(f, "ahead.txt");

    const result = maintain(f.repo);
    assert.equal(result.status, 0, result.stderr);
    const reported = JSON.parse(result.stdout) as { primaryCheckout?: { action: string; reason?: string } };
    assert.deepEqual(reported.primaryCheckout, { action: "left", reason: "edits" });
    assert.equal(jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "change_id"]), change);
    assert.equal(jj(f.repo, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]), parent, "the primary stays on its old parent");
    assert.equal(await readFile(join(f.repo, "local.txt"), "utf8"), "unlanded\n");
    assert.equal(jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]), commit);
  } finally {
    await f.dispose();
  }
});

test("maintain leaves an empty primary checkout with unlanded commits under it where it is", async () => {
  const f = await project();
  try {
    await writeFile(join(f.repo, "mine.txt"), "mine\n");
    jj(f.repo, ["commit", "-m", "unlanded"]);
    jj(f.repo, ["new"]);
    const own = jj(f.repo, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
    const { commit } = await advanceIntegration(f, "ahead.txt");

    const result = maintain(f.repo);
    assert.equal(result.status, 0, result.stderr);
    const reported = JSON.parse(result.stdout) as { primaryCheckout?: { action: string; reason?: string } };
    assert.deepEqual(reported.primaryCheckout, { action: "left", reason: "unintegrated-ancestry" });
    assert.equal(jj(f.repo, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]), own);
    assert.equal(jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]), commit);
  } finally {
    await f.dispose();
  }
});
