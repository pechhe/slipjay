import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { candidateBookmark } from "../src/lib/runner-contract.ts";
import type { StoredEvent, SubmitRequest } from "../src/lib/runner-contract.ts";
import { newOperationId, openOperationLog } from "../src/lib/runner-log.ts";
import { createRunnerQueue, localExecutor } from "../src/lib/runner-queue.ts";

// Shells are forbidden by the landing policy; preserve the requested gate's behaviour.
const gate = 'if (require("node:fs").existsSync("fail")) { process.stderr.write("boom\\n"); process.exit(3); }';
const command = `node -e ${gate}`;
const jj = (cwd: string, args: string[]) => execFileSync("jj", ["--color=never", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();

async function fixture(migrations = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runner-queue-")));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const author = join(root, "author");
  const home = join(root, "runner");
  await mkdir(seed);
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git(["init", "--bare", "-b", "main", origin]);
  // Both clone and later bounded jj commands use this file's disposable HOME.
  jj(root, ["config", "set", "--user", "user.name", "Fixture"]);
  jj(root, ["config", "set", "--user", "user.email", "fixture@example.com"]);
  jj(seed, ["git", "init"]);
  await writeFile(join(seed, "slipjay.json"), JSON.stringify({
    version: 1, integrationBranch: "main",
    sourcePublication: { version: 1, mode: "required", remote: "origin" },
    requiredLocalVerification: [{ executable: "node", args: ["-e", gate] }],
    unattendedMergeToIntegration: true,
    ...(migrations ? { migrationFinalization: {
      mode: "late_bound_serialized", triggerPaths: ["schema"], artifactPaths: ["migrations"],
      generate: { executable: "sh", args: ["-c", "exit 99"] },
      verify: { executable: "sh", args: ["-c", "exit 99"] },
    } } : {}),
  }));
  jj(seed, ["describe", "-m", "Seed policy"]);
  jj(seed, ["git", "remote", "add", "origin", origin]);
  jj(seed, ["git", "push", "--remote", "origin", "--named", "main=@"]);
  jj(root, ["git", "clone", origin, author]);
  const log = openOperationLog(":memory:");
  const published: StoredEvent[] = [];
  const executor = localExecutor();
  const queue = createRunnerQueue({ log, executor, home, config: { repos: { "fixture/repo": { url: origin } } }, publish: (event) => { published.push(event); } });
  const main = () => git(["--git-dir", origin, "rev-parse", "main"]);
  const remoteFile = (file: string) => git(["--git-dir", origin, "show", `main:${file}`]);
  async function push(): Promise<SubmitRequest> {
    // The runner deletes candidate bookmarks when it closes an operation.
    jj(author, ["git", "fetch", "--remote", "origin"]);
    const changeId = jj(author, ["log", "-r", "@", "--no-graph", "-T", "change_id"]);
    const commitId = jj(author, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    const bookmark = candidateBookmark(changeId);
    const existing = jj(author, ["log", "-r", `bookmarks("${bookmark}")`, "--no-graph", "-T", "commit_id"]);
    if (existing) {
      jj(author, ["bookmark", "set", bookmark, "-r", "@", "--allow-backwards"]);
      jj(author, ["git", "push", "--remote", "origin", "--bookmark", bookmark]);
    } else jj(author, ["git", "push", "--remote", "origin", "--named", `${bookmark}=@`]);
    return { repo: "fixture/repo", changeId, commitId, bookmark, submittedBy: "test" };
  }
  async function candidate(file: string): Promise<SubmitRequest> {
    jj(author, ["new", "main"]);
    await mkdir(join(author, file, ".."), { recursive: true });
    await writeFile(join(author, file), `${file}\n`);
    jj(author, ["describe", "-m", `Add ${file}`]);
    return push();
  }
  function submit(request: SubmitRequest) {
    const id = newOperationId();
    log.append(id, { type: "submitted", ...request });
    return id;
  }
  const result = (id: string) => log.operation(id)!.result;
  return { root, origin, author, home, log, queue, executor, published, main, remoteFile, push, candidate, submit, result,
    async dispose() { await queue.idle(); log.close(); await rm(root, { recursive: true, force: true }); } };
}

test("queued candidates land in arrival order on the previous candidate, with runner gate records and streamed logs", async () => {
  const f = await fixture();
  try {
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    assert.equal(f.log.operation(a)!.position, 1);
    assert.equal(f.log.operation(b)!.position, 2);
    assert.equal(await f.queue.readLog("unknown"), null);
    f.queue.wake(); f.queue.wake();
    await f.queue.idle();
    const first = f.result(a);
    const second = f.result(b);
    assert.equal(first?.type, "landed", JSON.stringify(first));
    assert.equal(second?.type, "landed", JSON.stringify(second));
    if (first?.type !== "landed" || second?.type !== "landed") throw new Error("Expected landed candidates");
    assert.equal(second.base, first.commitId);
    assert.equal(f.main(), second.commitId);
    assert.equal(f.remoteFile("a.txt"), "a.txt");
    assert.equal(f.remoteFile("b.txt"), "b.txt");
    assert.deepEqual(f.published.filter((stored) => stored.event.type === "landed").map((stored) => stored.operationId), [a, b]);
    for (const id of [a, b]) {
      const operation = f.log.operation(id)!;
      assert.equal(operation.runs.length, 1);
      assert.equal(operation.runs[0]!.host, f.executor.host);
      assert.equal(operation.runs[0]!.command, command);
      assert.equal(operation.runs[0]!.exitCode, 0);
      assert.deepEqual(f.log.events({ operationId: id }).filter((stored) => stored.event.type === "stage").map((stored) => stored.event.type === "stage" && stored.event.stage), ["fetching", "rebasing", "installing", "verifying", "integrating", "publishing"]);
      assert.equal(f.queue.logPath(id), join(f.home, "logs", `${id}.log`));
      const lines = (await f.queue.readLog(id))!.trim().split("\n").map((line) => JSON.parse(line) as StoredEvent);
      assert.deepEqual(lines, f.published.filter((stored) => stored.operationId === id));
    }
    assert.equal(execFileSync("git", ["--git-dir", f.origin, "for-each-ref", "refs/heads/slipjay/changes"], { encoding: "utf8" }), "");
  } finally { await f.dispose(); }
}, 120_000);

test("gate failure preserves main and verbatim evidence; an amended change can land again", async () => {
  const f = await fixture();
  try {
    const before = f.main();
    const request = await f.candidate("fail");
    const failed = f.submit(request);
    f.queue.wake(); await f.queue.idle();
    const failure = f.result(failed);
    assert.equal(failure?.type, "failed", JSON.stringify(failure));
    if (failure?.type !== "failed") throw new Error("Expected failed gate");
    assert.equal(failure.stage, "verifying");
    assert.equal(failure.command, command);
    assert.equal(failure.output, "boom\n");
    assert.equal(f.log.operation(failed)!.runs[0]!.exitCode, 3);
    assert.equal(f.main(), before);
    await rm(join(f.author, "fail"));
    await writeFile(join(f.author, "fixed.txt"), "fixed\n");
    const amended = await f.push();
    assert.equal(amended.changeId, request.changeId);
    assert.notEqual(amended.commitId, request.commitId);
    const retry = f.submit(amended);
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.result(retry)?.type, "landed", JSON.stringify(f.result(retry)));
    assert.equal(f.remoteFile("fixed.txt"), "fixed");
  } finally { await f.dispose(); }
}, 120_000);

test("migration trigger and artifact changes are declined before gates or publication", async () => {
  const f = await fixture(true);
  try {
    const before = f.main();
    for (const path of ["schema/table.ts", "migrations/001.sql"]) {
      const id = f.submit(await f.candidate(path));
      f.queue.wake(); await f.queue.idle();
      assert.deepEqual(f.result(id), { type: "declined", reason: "Changes migration trigger paths; land it through the local path until the runner generates migrations (pechhe/slipjay#11)", paths: [path] });
      assert.equal(f.log.operation(id)!.runs.length, 0);
      assert.equal(f.main(), before);
    }
  } finally { await f.dispose(); }
}, 120_000);

test("recovery fails interrupted verification and leaves queued operations for wake", async () => {
  const f = await fixture();
  try {
    const interrupted = f.submit(await f.candidate("interrupted.txt"));
    f.log.append(interrupted, { type: "stage", stage: "verifying" });
    const queued = f.submit(await f.candidate("queued.txt"));
    await f.queue.recover();
    assert.deepEqual(f.result(interrupted), { type: "failed", stage: "verifying", reason: "runner restarted during verifying; land again" });
    assert.equal(f.log.operation(queued)!.status, "queued");
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.result(queued)?.type, "landed", JSON.stringify(f.result(queued)));
  } finally { await f.dispose(); }
}, 120_000);

test("recovery recognizes an integrated commit published before the runner stopped", async () => {
  const f = await fixture();
  try {
    const request = await f.candidate("published.txt");
    const original = f.submit(request);
    f.queue.wake(); await f.queue.idle();
    const landed = f.result(original);
    assert.equal(landed?.type, "landed", JSON.stringify(landed));
    if (landed?.type !== "landed") throw new Error("Expected publication");
    const recovering = f.submit(request);
    f.log.append(recovering, { type: "stage", stage: "publishing" });
    f.log.append(recovering, { type: "integrated", base: landed.base, commitId: landed.commitId });
    await f.queue.recover();
    assert.deepEqual(f.result(recovering), landed);
    const unpublished = f.submit(request);
    f.log.append(unpublished, { type: "stage", stage: "publishing" });
    f.log.append(unpublished, { type: "integrated", base: landed.base, commitId: "f".repeat(40) });
    await f.queue.recover();
    assert.deepEqual(f.result(unpublished), { type: "failed", stage: "publishing", reason: "runner restarted during publishing; land again" });
  } finally { await f.dispose(); }
}, 120_000);

test("unknown repositories and stale submitted commits fail without publishing", async () => {
  const f = await fixture();
  try {
    const before = f.main();
    const request = await f.candidate("stale.txt");
    const unknown = f.submit({ ...request, repo: "unknown/repo" });
    const stale = f.submit({ ...request, commitId: "f".repeat(40) });
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.result(unknown)?.type, "failed");
    assert.equal(f.result(stale)?.type, "failed");
    for (const id of [unknown, stale]) {
      const result = f.result(id);
      assert.ok(result?.type === "failed");
      assert.match(result.reason, id === unknown ? /not configured/ : /does not resolve to submitted commit/);
    }
    assert.equal(f.main(), before);
  } finally { await f.dispose(); }
}, 120_000);
