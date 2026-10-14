import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { candidateBookmark, OWNER_KILL_REASON, RUNNER_CONTROL_ID, TERMINAL_EVENT_TYPES } from "../src/lib/runner-contract.ts";
import type { StoredEvent, SubmitRequest } from "../src/lib/runner-contract.ts";
import { newOperationId, openOperationLog } from "../src/lib/runner-log.ts";
import { createRunnerQueue, localExecutor } from "../src/lib/runner-queue.ts";

// Shells are forbidden by the landing policy; preserve the requested gate's behaviour.
// A committed `hang` file names where to record the pids of the gate, of a child in its
// process group, and of a tool it starts in its own group (as YardSmith's task runners
// do); then it never ends.
const gate = 'const fs=require("node:fs");if (fs.existsSync("fail")) { process.stderr.write("boom\\n"); process.exit(3); }'
  + 'if (fs.existsSync("hang")) { const spawn=(detached)=>require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached,stdio:"ignore"});'
  + 'const child=spawn(false), tool=spawn(true);'
  + 'fs.writeFileSync(fs.readFileSync("hang","utf8").trim(),JSON.stringify([process.pid,child.pid,tool.pid])); setInterval(()=>{},1000); }';
const command = `node -e ${gate}`;
// Late-bound migrations: each generation writes the next numbered file; finalization
// records which migrations the integrated commit carries, unless `fail-finalize` exists;
// it waits while `hold-finalize` exists.
const generate = 'const fs=require("node:fs");fs.mkdirSync("migrations",{recursive:true});const n=fs.readdirSync("migrations").length+1;fs.writeFileSync("migrations/"+String(n).padStart(4,"0")+".sql","-- "+n+"\\n");';
const finalize = (root: string) => `const fs=require("node:fs");
while (fs.existsSync(${JSON.stringify(join(root, "hold-finalize"))})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
if (fs.existsSync(${JSON.stringify(join(root, "fail-finalize"))})) { console.error("development migrate failed"); process.exit(9); }
fs.appendFileSync(${JSON.stringify(join(root, "development.jsonl"))}, JSON.stringify({ commit: process.env.SLIPJAY_FINALIZATION_COMMIT, migrations: fs.existsSync("migrations") ? fs.readdirSync("migrations").sort() : [] }) + "\\n");`;
// The release check records where it ran and fails while `fail-release` exists; the
// post-release step records the release it ran for and the key the runner gave it.
const releaseCheck = (root: string) => `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(join(root, "release-verified.log"))}, process.cwd() + "\\n");
if (fs.existsSync(${JSON.stringify(join(root, "fail-release"))})) { process.stderr.write("release boom\\n"); process.exit(4); }
if (fs.existsSync(${JSON.stringify(join(root, "hang-release"))})) { fs.writeFileSync(${JSON.stringify(join(root, "release-started"))}, ""); setInterval(()=>{},1000); }`;
const postReleaseStep = (root: string) => `require("node:fs").appendFileSync(${JSON.stringify(join(root, "post-release.jsonl"))}, JSON.stringify({ merge: process.env.SLIPJAY_RELEASE_MERGE, key: process.env.FIXTURE_KEY ?? null }) + "\\n");`;
// Each deploy project records what it deployed and prints its deployment URL; it fails while `fail-deploy-<name>` exists.
const deployStep = (root: string, name: string) => `const fs=require("node:fs");
if (fs.existsSync(${JSON.stringify(join(root, `fail-deploy-${name}`))})) { console.error("${name} build failed"); process.exit(5); }
fs.appendFileSync(${JSON.stringify(join(root, "deploys.jsonl"))}, JSON.stringify({ project: "${name}", environment: process.env.SLIPJAY_DEPLOY_ENVIRONMENT, commit: process.env.SLIPJAY_DEPLOY_COMMIT, key: process.env.FIXTURE_KEY ?? null, head: require("node:child_process").execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() }) + "\\n");
console.log("building"); console.log("https://${name}-" + process.env.SLIPJAY_DEPLOY_COMMIT.slice(0, 7) + ".example");`;
// Production checks each deployment and then activates it, recording both; each fails while `fail-health-<name>` / `fail-activate-<name>` exists.
const productionStep = (root: string, name: string, step: "health" | "activate") => `const fs=require("node:fs");
if (fs.existsSync(${JSON.stringify(join(root, `fail-${step}-${name}`))})) { console.error("${name} ${step} failed"); process.exit(6); }
fs.appendFileSync(${JSON.stringify(join(root, `${step}.jsonl`))}, JSON.stringify({ project: "${name}", url: process.env.SLIPJAY_DEPLOY_URL }) + "\\n");`;
const jj = (cwd: string, args: string[]) => execFileSync("jj", ["--color=never", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();

async function fixture(migrations = false, release = false, deployments?: { minIntervalMs: number; production?: boolean }) {
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
    requiredLandingVerification: [{ executable: "node", args: ["-e", gate] }],
    unattendedMergeToIntegration: true,
    ...(migrations ? {
      migrationFinalization: {
        mode: "late_bound_serialized", triggerPaths: ["schema"], artifactPaths: ["migrations"],
        generate: { executable: "node", args: ["-e", generate] },
        verify: { executable: "node", args: ["-e", ""] },
      },
      postIntegration: {
        version: 1, target: "fixture-development-db", idempotency: "artifact-key", approvalMode: "automatic-development", timeoutMs: 30_000,
        command: { executable: "node", args: ["-e", finalize(root)] },
        targetProbe: { executable: "node", args: ["-e", "console.log(JSON.stringify({ target: \"fixture-development-db\" }))"] },
      },
    } : {}),
    ...(deployments ? {
      deployments: { version: 1, environments: {
        staging: { minIntervalMs: deployments.minIntervalMs, timeoutMs: 30_000, environmentKeys: ["FIXTURE_KEY"],
          projects: ["app", "hq"].map((name) => ({ name, command: { executable: "node", args: ["-e", deployStep(root, name)] } })) },
        ...(deployments.production ? { production: { timeoutMs: 30_000, environmentKeys: ["FIXTURE_KEY"],
          projects: ["app", "hq", "www"].map((name) => ({ name, command: { executable: "node", args: ["-e", deployStep(root, name)] },
            healthCheck: { executable: "node", args: ["-e", productionStep(root, name, "health")] },
            activate: { executable: "node", args: ["-e", productionStep(root, name, "activate")] } })) } } : {}),
      } },
    } : {}),
    ...(release ? {
      releaseBranch: "release",
      requiredReleaseVerification: [{ executable: "node", args: ["-e", releaseCheck(root)] }],
      postRelease: {
        version: 1, target: "fixture-development-db", timeoutMs: 30_000, environmentKeys: ["FIXTURE_KEY"],
        command: { executable: "node", args: ["-e", postReleaseStep(root)] },
        targetProbe: { executable: "node", args: ["-e", "console.log(JSON.stringify({ target: \"fixture-development-db\" }))"] },
      },
    } : {}),
  }));
  jj(seed, ["describe", "-m", "Seed policy"]);
  jj(seed, ["git", "remote", "add", "origin", origin]);
  jj(seed, ["git", "push", "--remote", "origin", "--named", "main=@"]);
  if (release) jj(seed, ["git", "push", "--remote", "origin", "--named", "release=main"]);
  jj(root, ["git", "clone", origin, author]);
  // While `reject-push` exists the remote refuses every push, as an outage would.
  await writeFile(join(origin, "hooks", "pre-receive"), `#!/bin/sh\nif [ -e ${JSON.stringify(join(root, "reject-push"))} ]; then echo "remote unavailable" >&2; exit 1; fi\n`);
  await chmod(join(origin, "hooks", "pre-receive"), 0o755);
  const log = openOperationLog(":memory:");
  const published: StoredEvent[] = [];
  // Whether each landing's candidate bookmark was still on origin when its verdict was published.
  const candidateAtVerdict = new Map<string, boolean>();
  const executor = localExecutor();
  const queue = createRunnerQueue({ log, executor, home, config: { repos: { "Fixture/Repo": { url: origin } },
    jj: { "user.name": "Runner Identity", "user.email": "runner@example.com" } }, publish: (event) => {
    published.push(event);
    const operation = log.operation(event.operationId);
    if (operation?.kind === "landing" && TERMINAL_EVENT_TYPES.includes(event.event.type as never))
      candidateAtVerdict.set(event.operationId, Boolean(git(["--git-dir", origin, "for-each-ref", `refs/heads/${operation.bookmark}`])));
  },
    environment: () => ({ ...process.env, FIXTURE_KEY: "from-runner" }) });
  const main = () => git(["--git-dir", origin, "rev-parse", "main"]);
  const releaseRef = () => git(["--git-dir", origin, "rev-parse", "release"]);
  const parents = (commit: string) => git(["--git-dir", origin, "log", "-1", "--format=%P", commit]).split(" ");
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
  function submitRelease(commitId: string) {
    const id = newOperationId();
    log.append(id, { type: "submitted", kind: "release", repo: "fixture/repo", commitId, migrationsReady: false, submittedBy: "test" });
    return id;
  }
  const lines = async (file: string) => (await readFile(join(root, file), "utf8").catch(() => "")).split("\n").filter(Boolean);
  const result = (id: string) => log.operation(id)!.result;
  const development = async () => (await readFile(join(root, "development.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { commit: string; migrations: string[] });
  const land = async (id: string) => { queue.wake(); await queue.idle(); return log.operation(id)!.result; };
  return { root, candidateAtVerdict, development, land, origin, author, home, log, queue, executor, published, main, releaseRef, parents, remoteFile, push, candidate, submit, submitRelease, lines, result,
    async dispose() { queue.close(); await queue.idle(); log.close(); await rm(root, { recursive: true, force: true }); } };
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
      assert.deepEqual(f.log.events({ operationId: id }).filter((stored) => stored.event.type === "stage").map((stored) => stored.event.type === "stage" && stored.event.stage), ["fetching", "rebasing", "installing", "verifying", "integrating", "finalizing", "publishing"]);
      assert.equal(f.queue.logPath(id), join(f.home, "logs", `${id}.log`));
      const lines = (await f.queue.readLog(id))!.trim().split("\n").map((line) => JSON.parse(line) as StoredEvent);
      assert.deepEqual(lines, f.published.filter((stored) => stored.operationId === id));
    }
    assert.equal(execFileSync("git", ["--git-dir", f.origin, "for-each-ref", "refs/heads/slipjay/changes"], { encoding: "utf8" }), "");
    // The runner's jj settings come from its config and defaults, set in the warm checkout, not from the host.
    const repoConfig = jj(join(f.home, "repos", "fixture/repo"), ["config", "list", "--repo"]);
    for (const setting of ['user.name = "Runner Identity"', 'user.email = "runner@example.com"', 'snapshot.max-new-file-size = "64MiB"'])
      assert.ok(repoConfig.includes(setting), repoConfig);
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

/** Resolves once `check` holds, polling; fails after `timeoutMs`. */
async function until<T>(check: () => Promise<T | undefined> | T | undefined, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("the owner's kill stops a running gate: cancelled, never passed, main unchanged, and the queue moves on", async () => {
  const f = await fixture();
  try {
    const before = f.main();
    const pids = join(f.root, "gate-pids.json");
    await f.candidate("hang");
    await writeFile(join(f.author, "hang"), `${pids}\n`);
    const killed = f.submit(await f.push());
    const next = f.submit(await f.candidate("next.txt"));
    assert.equal(f.queue.kill(), null, "an idle runner has nothing to kill");
    f.queue.wake();
    const [gatePid, childPid, toolPid] = await until(async () => {
      const text = await readFile(pids, "utf8").catch(() => "");
      return text ? JSON.parse(text) as [number, number, number] : undefined;
    });
    const outcome = f.queue.kill();
    assert.equal(outcome?.killed, true);
    assert.equal(outcome?.operation.id, killed);
    await f.queue.idle();
    assert.deepEqual(f.result(killed), { type: "cancelled", reason: OWNER_KILL_REASON });
    const landed = f.result(next);
    assert.ok(landed?.type === "landed", JSON.stringify(landed));
    assert.equal(landed.base, before, "the killed change never integrated");
    assert.equal(alive(gatePid), false, "the gate process is gone");
    await until(() => alive(childPid) ? undefined : true, 5_000);
    // A systemd scope reaches the tool's own process group; a bare process group cannot.
    if (process.platform === "linux" && process.env.XDG_RUNTIME_DIR) assert.equal(alive(toolPid), false, "the gate's detached tool is gone");
    else process.kill(toolPid, "SIGKILL");
    assert.equal(f.queue.kill(), null);
  } finally { await f.dispose(); }
}, 120_000);

test("a kill past verification is refused and the landing completes", async () => {
  const f = await fixture(true);
  try {
    await writeFile(join(f.root, "hold-finalize"), "");
    const id = f.submit(await f.candidate("schema/a.ts"));
    f.queue.wake();
    await until(() => f.log.operation(id)!.stage === "finalizing" ? true : undefined);
    const outcome = f.queue.kill();
    assert.equal(outcome?.killed, false);
    assert.equal(outcome?.operation.stage, "finalizing");
    await rm(join(f.root, "hold-finalize"));
    await f.queue.idle();
    assert.equal(f.result(id)?.type, "landed", JSON.stringify(f.result(id)));
  } finally { await f.dispose(); }
}, 120_000);

test("the owner's kill stops a release's verification and publishes nothing", async () => {
  const f = await fixture(false, true);
  try {
    const base = f.releaseRef();
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    await writeFile(join(f.root, "hang-release"), "");
    const release = f.submitRelease(f.main());
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "release-started")).then(() => true, () => undefined));
    assert.equal(f.queue.kill()?.killed, true);
    await f.queue.idle();
    assert.deepEqual(f.result(release), { type: "cancelled", reason: OWNER_KILL_REASON });
    assert.equal(f.releaseRef(), base);
    assert.deepEqual(await f.lines("post-release.jsonl"), []);
  } finally { await f.dispose(); }
}, 120_000);

test("while paused, queued changes wait and show paused; resumed, they land in order", async () => {
  const f = await fixture();
  try {
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake(); await f.queue.idle();
    assert.deepEqual([f.log.operation(a)!.stage, f.log.operation(b)!.stage], ["paused", "paused"]);
    assert.deepEqual([f.log.operation(a)!.status, f.log.operation(b)!.position], ["queued", 2]);
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "owner" });
    f.queue.wake(); await f.queue.idle();
    const first = f.result(a);
    const second = f.result(b);
    assert.ok(first?.type === "landed" && second?.type === "landed", JSON.stringify([first, second]));
    assert.equal(second.base, first.commitId);
  } finally { await f.dispose(); }
}, 120_000);

const generations = (f: Awaited<ReturnType<typeof fixture>>, ids: string[]) =>
  ids.flatMap((id) => f.log.operation(id)!.runs).filter((run) => run.command.startsWith("node -e const fs=require(\"node:fs\");fs.mkdirSync")).length;

test("a migration-bearing change lands with one generated migration, finalized before publication", async () => {
  const f = await fixture(true);
  try {
    const id = f.submit(await f.candidate("schema/table.ts"));
    const landed = await f.land(id);
    assert.equal(landed?.type, "landed", JSON.stringify(landed));
    if (landed?.type !== "landed") throw new Error("Expected landing");
    assert.equal(f.main(), landed.commitId);
    assert.equal(f.remoteFile("migrations/0001.sql"), "-- 1");
    assert.deepEqual(await f.development(), [{ commit: landed.commitId, migrations: ["0001.sql"] }]);
    assert.deepEqual(f.log.events({ operationId: id }).flatMap((stored) => stored.event.type === "stage" ? [stored.event.stage] : []), ["fetching", "rebasing", "installing", "verifying", "integrating", "finalizing", "publishing"]);
    // Generation, its verification and the gate are all runner runs.
    assert.equal(f.log.operation(id)!.runs.length, 3);
    assert.ok(f.log.operation(id)!.runs.every((run) => run.host === f.executor.host && run.exitCode === 0));
    // A committed artifact is refused: landing generates them.
    const before = f.main();
    const committed = f.submit(await f.candidate("migrations/9999.sql"));
    const refused = await f.land(committed);
    assert.equal(refused?.type, "failed", JSON.stringify(refused));
    assert.match(refused?.type === "failed" ? refused.reason : "", /must be generated during landing/);
    assert.equal(f.main(), before);
  } finally { await f.dispose(); }
}, 180_000);

test("migration-bearing changes submitted together land one after the other with consecutive migrations", async () => {
  const f = await fixture(true);
  try {
    const a = f.submit(await f.candidate("schema/a.ts"));
    const b = f.submit(await f.candidate("schema/b.ts"));
    await f.land(b);
    const first = f.result(a), second = f.result(b);
    if (first?.type !== "landed" || second?.type !== "landed") throw new Error(JSON.stringify({ first, second }));
    assert.equal(second.base, first.commitId);
    assert.equal(f.remoteFile("migrations/0001.sql"), "-- 1");
    assert.equal(f.remoteFile("migrations/0002.sql"), "-- 2");
    assert.deepEqual(await f.development(), [
      { commit: first.commitId, migrations: ["0001.sql"] },
      { commit: second.commitId, migrations: ["0001.sql", "0002.sql"] },
    ]);
    assert.equal(generations(f, [a, b]), 2);
  } finally { await f.dispose(); }
}, 180_000);

test("a failed publication holds the finalized integration; relanding publishes it without regenerating, before other changes", async () => {
  const f = await fixture(true);
  try {
    const before = f.main();
    const request = await f.candidate("schema/held.ts");
    const other = await f.candidate("other.txt");
    await writeFile(join(f.root, "reject-push"), "");
    const held = f.submit(request);
    const failure = await f.land(held);
    assert.equal(failure?.type, "failed", JSON.stringify(failure));
    if (failure?.type !== "failed") throw new Error("Expected publication failure");
    assert.equal(failure.stage, "publishing");
    assert.match(failure.reason, /remote unavailable/);
    assert.match(failure.reason, /The runner holds [0-9a-f]{12}, integrated but not published/);
    assert.equal(f.main(), before);
    const [finalized] = await f.development();
    assert.deepEqual(finalized?.migrations, ["0001.sql"]);
    // Another change cannot land past the held integration, and does not discard it.
    const blocked = f.submit(other);
    const refusal = await f.land(blocked);
    assert.equal(refusal?.type, "failed", JSON.stringify(refusal));
    assert.equal(refusal?.type === "failed" && refusal.stage, "publishing");
    await rm(join(f.root, "reject-push"));
    const reland = f.submit(request);
    const landed = await f.land(reland);
    assert.deepEqual(landed, { type: "landed", base: before, commitId: finalized!.commit, branch: "main", remote: "origin" });
    assert.equal(f.main(), finalized!.commit);
    assert.equal(generations(f, [held, blocked, reland]), 1);
    assert.equal((await f.development()).length, 1);
    const after = f.submit(other);
    const second = await f.land(after);
    assert.equal(second?.type, "landed", JSON.stringify(second));
    assert.equal(second?.type === "landed" && second.base, finalized!.commit);
  } finally { await f.dispose(); }
}, 240_000);

test("a failed finalization reports its output, holds the integration and retries it before the next landing", async () => {
  const f = await fixture(true);
  try {
    const before = f.main();
    await writeFile(join(f.root, "fail-finalize"), "");
    const id = f.submit(await f.candidate("schema/retry.ts"));
    const failure = await f.land(id);
    assert.equal(failure?.type, "failed", JSON.stringify(failure));
    if (failure?.type !== "failed") throw new Error("Expected finalization failure");
    assert.equal(failure.stage, "finalizing");
    assert.match(failure.output ?? "", /development migrate failed/);
    assert.equal(f.main(), before);
    await rm(join(f.root, "fail-finalize"));
    const next = f.submit(await f.candidate("next.txt"));
    const landed = await f.land(next);
    if (landed?.type !== "landed") throw new Error(JSON.stringify(landed));
    const [finalized] = await f.development();
    assert.deepEqual(finalized?.migrations, ["0001.sql"]);
    assert.equal(landed.base, finalized!.commit);
    assert.equal(f.remoteFile("migrations/0001.sql"), "-- 1");
  } finally { await f.dispose(); }
}, 240_000);

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

test("the candidate bookmark is gone from origin before any landing verdict, including after a restart or a queued cancel", async () => {
  const f = await fixture();
  try {
    const landed = f.submit(await f.candidate("landed.txt"));
    assert.equal((await f.land(landed))?.type, "landed");
    const failed = f.submit(await f.candidate("fail"));
    assert.equal((await f.land(failed))?.type, "failed");
    const interrupted = f.submit(await f.candidate("interrupted.txt"));
    f.log.append(interrupted, { type: "stage", stage: "verifying" });
    await f.queue.recover();
    assert.equal(f.result(interrupted)?.type, "failed");
    assert.deepEqual([landed, failed, interrupted].map((id) => f.candidateAtVerdict.get(id)), [false, false, false]);
    const request = await f.candidate("cancelled.txt");
    const cancelled = f.submit(request);
    f.log.append(cancelled, { type: "cancelled", reason: "cancelled by the author" });
    f.queue.cancelled(f.log.operation(cancelled)!);
    await f.queue.idle();
    assert.equal(execFileSync("git", ["--git-dir", f.origin, "for-each-ref", `refs/heads/${request.bookmark}`], { encoding: "utf8" }), "");
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

const stagesOf = (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  f.log.events({ operationId: id }).flatMap((stored) => stored.event.type === "stage" ? [stored.event.stage] : []);

test("a release takes its turn, verifies the exact candidate on the runner, publishes the release branch and runs its post-release step", async () => {
  const f = await fixture(false, true);
  try {
    const base = f.releaseRef();
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const candidate = f.main();
    const release = f.submitRelease(candidate);
    const behind = f.submit(await f.candidate("b.txt"));
    f.queue.wake(); await f.queue.idle();
    const outcome = f.result(release);
    assert.ok(outcome?.type === "released" && outcome.result.status === "released", JSON.stringify(outcome));
    assert.equal(f.releaseRef(), outcome.result.merge);
    assert.deepEqual(f.parents(outcome.result.merge), [base, candidate]);
    assert.equal(outcome.result.postRelease?.ok, true, JSON.stringify(outcome.result.postRelease));
    assert.deepEqual(stagesOf(f, release), ["fetching", "installing", "verifying", "publishing", "finalizing"]);
    // The check ran once, through the executor, in the runner's warm checkout.
    assert.deepEqual(await f.lines("release-verified.log"), [join(f.home, "repos", "fixture/repo")]);
    assert.equal(f.log.operation(release)!.runs.length, 1);
    assert.equal(f.log.operation(release)!.runs[0]!.exitCode, 0);
    assert.deepEqual((await f.lines("post-release.jsonl")).map((line) => JSON.parse(line)), [{ merge: outcome.result.merge, key: "from-runner" }],
      "the step ran once, with the declared key from the runner's environment");
    // The landing submitted behind the release waited for it.
    assert.equal(f.result(behind)?.type, "landed", JSON.stringify(f.result(behind)));
    const order = f.published.filter((stored) => ["released", "landed"].includes(stored.event.type)).map((stored) => stored.operationId);
    assert.deepEqual(order.slice(-2), [release, behind]);
  } finally { await f.dispose(); }
}, 120_000);

test("a failed release verification publishes nothing and reports its output verbatim", async () => {
  const f = await fixture(false, true);
  try {
    const base = f.releaseRef();
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    await writeFile(join(f.root, "fail-release"), "");
    const outcome = await f.land(f.submitRelease(f.main()));
    assert.ok(outcome?.type === "failed", JSON.stringify(outcome));
    assert.equal(outcome.stage, "verifying");
    assert.match(outcome.output ?? "", /release boom/);
    assert.equal(f.releaseRef(), base);
    assert.deepEqual(await f.lines("post-release.jsonl"), []);
  } finally { await f.dispose(); }
}, 120_000);

test("a release of a candidate the release branch already holds verifies nothing and names the release that shipped it", async () => {
  const f = await fixture(false, true);
  try {
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const older = f.main();
    assert.equal((await f.land(f.submit(await f.candidate("b.txt"))))?.type, "landed");
    const newer = f.main();
    const shipped = await f.land(f.submitRelease(newer));
    assert.ok(shipped?.type === "released" && shipped.result.status === "released", JSON.stringify(shipped));
    const again = await f.land(f.submitRelease(older));
    assert.ok(again?.type === "released" && again.result.status === "released_by", JSON.stringify(again));
    assert.equal(again.result.releasedBy, newer);
    assert.equal(again.result.merge, shipped.result.merge);
    assert.equal((await f.lines("release-verified.log")).length, 1);
    assert.equal((await f.lines("post-release.jsonl")).length, 1, "a completed post-release step is not rerun");
  } finally { await f.dispose(); }
}, 120_000);

test("recovery fails an interrupted release with the command that reruns it", async () => {
  const f = await fixture(false, true);
  try {
    const release = f.submitRelease(f.main());
    f.log.append(release, { type: "stage", stage: "verifying" });
    await f.queue.recover();
    assert.deepEqual(f.result(release), { type: "failed", stage: "verifying",
      reason: `runner restarted during verifying; rerun slipjay promote --confirm ${f.main().slice(0, 12)}` });
  } finally { await f.dispose(); }
}, 120_000);

test("a landing deploys staging from an exact view of the landed commit and records it; the next records the changes since", async () => {
  const f = await fixture(false, false, { minIntervalMs: 0 });
  try {
    const a = await f.land(f.submit(await f.candidate("a.txt")));
    assert.equal(a?.type, "landed");
    await f.queue.idle();
    const [first] = f.log.deployments("fixture/repo", "staging");
    assert.equal(first?.status, "deployed", JSON.stringify(first?.result));
    assert.ok(first?.result?.type === "deployed");
    const firstRecord = first.result.record;
    assert.equal(firstRecord.commitId, f.main());
    assert.equal(firstRecord.previous, null);
    assert.deepEqual(firstRecord.changes.map((change) => change.subject), ["Add a.txt"]);
    assert.deepEqual(firstRecord.projects, ["app", "hq"].map((name) => ({ name, ok: true, url: `https://${name}-${f.main().slice(0, 7)}.example` })));
    assert.deepEqual((await f.lines("deploys.jsonl")).map((line) => JSON.parse(line)), ["app", "hq"].map((project) =>
      ({ project, environment: "staging", commit: f.main(), key: "from-runner", head: f.main() })), "each project ran in the exact commit with the declared key");
    assert.deepEqual(first.runs.map((run) => run.exitCode), [0, 0]);
    await writeFile(join(f.root, "fail-deploy-hq"), "");
    await f.land(f.submit(await f.candidate("b.txt")));
    await f.land(f.submit(await f.candidate("c.txt")));
    await f.queue.idle();
    const deploys = f.log.deployments("fixture/repo", "staging");
    const latest = deploys[0]!;
    assert.equal(latest.commitId, f.main(), "the latest landing is deployed");
    assert.ok(latest.result?.type === "failed" && latest.result.deployment);
    assert.equal(latest.result.reason, "deploy failed: hq (exited 5: hq build failed)");
    // The landing of b deployed app but not hq: staging served b, so c's changes start there.
    assert.equal(latest.result.deployment.previous, deploys[1]!.commitId);
    assert.notEqual(deploys[1]!.commitId, firstRecord.commitId);
    assert.ok(latest.result.deployment.changes.map((change) => change.subject).includes("Add c.txt"));
    assert.deepEqual(latest.result.deployment.projects.map((project) => [project.name, project.ok]), [["app", true], ["hq", false]]);
    assert.match(latest.result.deployment.projects[1]!.reason!, /exited 5: hq build failed/);
    await rm(join(f.root, "fail-deploy-hq"));
    await f.land(f.submit(await f.candidate("d.txt")));
    await f.queue.idle();
    const next = f.log.deployments("fixture/repo", "staging")[0]!;
    assert.ok(next.result?.type === "deployed", JSON.stringify(next.result));
    assert.equal(next.result.record.previous, latest.commitId, "a deploy that reached some projects is what the environment served");
    // A commit that never landed is refused before any project runs.
    const unlanded = await f.candidate("e.txt");
    const refused = newOperationId();
    f.log.append(refused, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "staging", commitId: unlanded.commitId, submittedBy: "test" });
    f.queue.wake(); await f.queue.idle();
    const outcome = f.result(refused);
    assert.ok(outcome?.type === "failed" && !outcome.deployment, JSON.stringify(outcome));
    assert.match(outcome.reason, /is not on main; only landed commits deploy/);
  } finally { await f.dispose(); }
}, 120_000);

test("a promotion releases only a commit staging deployed, then deploys production from exactly it; a rerun confirm reuses that deploy", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true });
  try {
    await f.land(f.submit(await f.candidate("a.txt")));
    await f.queue.idle();
    const green = f.main();
    assert.equal(f.log.deployments("fixture/repo", "staging")[0]?.status, "deployed");
    await writeFile(join(f.root, "fail-deploy-app"), "");
    await f.land(f.submit(await f.candidate("b.txt")));
    await f.queue.idle();
    await rm(join(f.root, "fail-deploy-app"));
    const red = f.main();
    assert.equal(f.log.deployments("fixture/repo", "staging")[0]?.status, "failed");
    const base = f.releaseRef();

    const refused = f.submitRelease(red);
    await f.land(refused);
    const refusal = f.result(refused);
    assert.ok(refusal?.type === "failed" && /Staging is not green on/.test(refusal.reason), JSON.stringify(refusal));
    assert.equal(f.releaseRef(), base, "nothing was verified or published");
    assert.deepEqual(f.log.deployments("fixture/repo", "production"), []);

    const promotion = f.submitRelease(green);
    await f.land(promotion);
    await f.queue.idle();
    const outcome = f.result(promotion);
    assert.ok(outcome?.type === "released" && outcome.result.status === "released" && outcome.deploy, JSON.stringify(outcome));
    const [production] = f.log.deployments("fixture/repo", "production");
    assert.equal(production?.id, outcome.deploy);
    assert.equal(production?.submittedBy, `promotion:${promotion}`);
    assert.ok(production?.result?.type === "deployed", JSON.stringify(production?.result));
    assert.equal(production.result.record.commitId, green, "production deploys the staging-verified commit, not the release merge");
    assert.deepEqual(production.result.record.projects.map((project) => project.name), ["app", "hq", "www"]);
    assert.deepEqual((await f.lines("deploys.jsonl")).map((line) => JSON.parse(line)).filter((entry) => entry.environment === "production"),
      ["app", "hq", "www"].map((project) => ({ project, environment: "production", commit: green, key: "from-runner", head: green })));
    const urls = ["app", "hq", "www"].map((project) => ({ project, url: `https://${project}-${green.slice(0, 7)}.example` }));
    assert.deepEqual((await f.lines("health.jsonl")).map((line) => JSON.parse(line)), urls, "each deployment is checked");
    assert.deepEqual((await f.lines("activate.jsonl")).map((line) => JSON.parse(line)), urls, "then activated");
    assert.ok(production.result.record.projects.every((project) => project.activated === true));

    const rerun = f.submitRelease(green);
    await f.land(rerun);
    await f.queue.idle();
    const again = f.result(rerun);
    assert.ok(again?.type === "released" && again.result.status === "released_by", JSON.stringify(again));
    assert.equal(again.deploy, outcome.deploy, "a deployed promotion is not deployed twice");
    assert.equal(f.log.deployments("fixture/repo", "production").length, 1);
  } finally { await f.dispose(); }
}, 180_000);

test("a promotion that fails its health check activates nothing and returns the release branch; one whose activation fails moves the activated projects back", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true });
  const activations = async () => (await f.lines("activate.jsonl")).map((line) => JSON.parse(line) as { project: string; url: string });
  const url = (project: string, commit: string) => `https://${project}-${commit.slice(0, 7)}.example`;
  const promote = async (commit: string) => {
    const promotion = f.submitRelease(commit);
    await f.land(promotion);
    await f.queue.idle();
    const outcome = f.result(promotion);
    assert.ok(outcome?.type === "released" && outcome.deploy, JSON.stringify(outcome));
    return f.log.operation(outcome.deploy)!;
  };
  try {
    await f.land(f.submit(await f.candidate("a.txt")));
    await f.queue.idle();
    const first = f.main();
    // The first promotion has no earlier deployment to move app back to.
    await writeFile(join(f.root, "fail-activate-hq"), "");
    const incomplete = (await promote(first)).result;
    assert.ok(incomplete?.type === "failed", JSON.stringify(incomplete));
    assert.match(incomplete.reason, /; rollback incomplete: app still serves the promotion \(could not be moved back: no earlier deployment is recorded\); the release branch stays on the release$/);
    const merge = f.releaseRef();
    assert.deepEqual(f.parents(merge).at(-1), first, "production partly serves the release, so the release branch keeps it");
    await rm(join(f.root, "fail-activate-hq"));

    // A rerun confirm of a promotion that carried a non-additive migration keeps that restriction.
    const original = newOperationId();
    f.log.append(original, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "production", commitId: first, submittedBy: "promotion:test",
      promotion: { merge, nonAdditiveMigrations: ["migrations/0002.sql"] } });
    f.log.append(original, { type: "failed", stage: "deploying", reason: "an earlier failure" });
    await writeFile(join(f.root, "fail-health-app"), "");
    const held = await promote(first);
    assert.deepEqual(held.kind === "deploy" && held.promotion, { merge, nonAdditiveMigrations: ["migrations/0002.sql"] });
    assert.ok(held.result?.type === "failed" && held.result.deployment?.rollback?.automatic === false, JSON.stringify(held.result));
    assert.match(held.result.reason, /not rolled back automatically, because the promotion carries non-additive migrations \(migrations\/0002\.sql\): the owner decides$/);
    assert.equal(f.releaseRef(), merge, "the release branch is left where it was");
    await rm(join(f.root, "fail-health-app"));
    assert.equal((await promote(first)).status, "deployed");

    await f.land(f.submit(await f.candidate("b.txt")));
    await f.queue.idle();
    const second = f.main();
    const before = f.releaseRef();
    await writeFile(join(f.root, "fail-health-hq"), "");
    const unhealthy = await promote(second);
    const failure = unhealthy.result;
    assert.ok(failure?.type === "failed" && failure.deployment, JSON.stringify(failure));
    assert.match(failure.reason, /^deploy failed: hq \(health check failed: exited 6: hq health failed\); rolled back: production serves what it served before, and the release branch is back on /);
    assert.deepEqual(failure.deployment.rollback, { automatic: true, releaseBranch: before, reason: failure.deployment.rollback?.reason });
    assert.equal(f.releaseRef(), before, "the release branch matches what production serves");
    assert.equal((await activations()).length, 4, "nothing was activated");
    assert.ok(failure.deployment.projects.every((project) => project.activated === false));

    await rm(join(f.root, "fail-health-hq"));
    await writeFile(join(f.root, "fail-activate-www"), "");
    const partial = await promote(second);
    const moved = partial.result;
    assert.ok(moved?.type === "failed" && moved.deployment, JSON.stringify(moved));
    assert.match(moved.reason, /www \(activation failed: exited 6: www activate failed\); rolled back/);
    assert.deepEqual((await activations()).slice(4), [
      { project: "app", url: url("app", second) }, { project: "hq", url: url("hq", second) },
      { project: "app", url: url("app", first) }, { project: "hq", url: url("hq", first) },
    ], "app and hq moved to the new deployment and back to the one they served before");
    assert.deepEqual(moved.deployment.projects.map(({ name, activated, restored }) => [name, activated, restored ?? false]),
      [["app", false, true], ["hq", false, true], ["www", false, false]]);
    assert.equal(f.releaseRef(), before);
  } finally { await f.dispose(); }
}, 300_000);

test("within the interval a landing does not deploy, and recovery fails a deploy interrupted by a restart", async () => {
  const f = await fixture(false, false, { minIntervalMs: 3_600_000 });
  try {
    await f.land(f.submit(await f.candidate("a.txt")));
    await f.queue.idle();
    await f.land(f.submit(await f.candidate("b.txt")));
    await f.queue.idle();
    assert.equal(f.log.deployments("fixture/repo").length, 1, "the second landing waits for the hour");
    const interrupted = newOperationId();
    f.log.append(interrupted, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "staging", commitId: f.main(), submittedBy: "test" });
    f.log.append(interrupted, { type: "stage", stage: "deploying" });
    await f.queue.recover();
    assert.equal(f.result(interrupted)?.type, "failed");
    assert.match(f.result(interrupted)!.type === "failed" ? (f.result(interrupted) as { reason: string }).reason : "", /runner restarted during deploying; deploy again with slipjay deploy staging/);
    const production = newOperationId();
    f.log.append(production, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "production", commitId: f.main(), submittedBy: "promotion:test" });
    f.log.append(production, { type: "stage", stage: "deploying" });
    await f.queue.recover();
    const outcome = f.result(production);
    assert.ok(outcome?.type === "failed" && outcome.reason.endsWith(`deploy again with slipjay promote --confirm ${f.main().slice(0, 12)}`), JSON.stringify(outcome));
  } finally { await f.dispose(); }
}, 120_000);
