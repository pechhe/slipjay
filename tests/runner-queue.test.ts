import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as serialTest } from "vite-plus/test";
import { candidateBookmark, OWNER_KILL_REASON, RUNNER_CONTROL_ID, TERMINAL_EVENT_TYPES } from "../src/lib/runner-contract.ts";
import type { Executor, StoredEvent, SubmitRequest } from "../src/lib/runner-contract.ts";
import { newOperationId, openOperationLog } from "../src/lib/runner-log.ts";
import { createReceiptDrain } from "../src/lib/build-receipts.ts";
import { importSubmissionSource, retainSubmissionSource } from "../src/lib/submission-source.ts";
import { readCommandArtifact } from "../src/lib/command-artifact.ts";
import { createRunnerQueue, localExecutor, runContainment, runnerWorkers } from "../src/lib/runner-queue.ts";
import { runBoundedProcess } from "../src/lib/bounded-process.ts";
import { TEST_SLICE, testExecutor } from "./support/executor.ts";

// Shells are forbidden by the landing policy; preserve the requested gate's behaviour.
// A committed `hang` file names where to record the pids of the gate, of a child in its
// process group, of a tool it starts in its own group (as YardSmith's task runners
// do) and, under systemd, of a tool in a scope of its own that joins the run's slice
// (as YardSmith's heavy-check wrapper does); then it never ends.
const gateFailureOutput = "boom\nFAIL tests/fixture.test.ts > fixture > rejects the candidate\n";
const gate = `const fs=require("node:fs");if (fs.existsSync("fail")) { process.stderr.write(${JSON.stringify(gateFailureOutput)}); process.exit(3); }`
  + 'if (fs.existsSync("hang")) { const spawn=(detached)=>require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached,stdio:"ignore"});'
  + 'const child=spawn(false), tool=spawn(true), slice=process.env.SLIPJAY_SYSTEMD_SLICE;'
  + 'const scoped=slice?require("node:child_process").spawn("systemd-run",["--user","--scope","--quiet","--collect","--slice="+slice,"--",process.execPath,"-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"}):null;'
  + 'const record=()=>fs.writeFileSync(fs.readFileSync("hang","utf8").trim(),JSON.stringify([process.pid,child.pid,tool.pid,...scoped?[scoped.pid]:[]]));'
  + 'setTimeout(record,scoped?500:0); setInterval(()=>{},1000); }';
const command = `node -e ${gate}`;
// Late-bound migrations: each generation writes the next numbered file; finalization
// records which migrations the integrated commit carries, unless `fail-finalize` exists;
// it waits while `hold-finalize` exists. A committed `schema/drop` makes generated migrations non-additive.
const generate = 'const fs=require("node:fs");fs.mkdirSync("migrations",{recursive:true});const n=fs.readdirSync("migrations").length+1;fs.writeFileSync("migrations/"+String(n).padStart(4,"0")+".sql",(fs.existsSync("schema/drop")?"drop table t;\\n":"")+"-- "+n+"\\n");';
const finalize = (root: string) => `const fs=require("node:fs");
while (fs.existsSync(${JSON.stringify(join(root, "hold-finalize"))})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
if (fs.existsSync(${JSON.stringify(join(root, "fail-finalize"))})) { console.error("development migrate failed"); process.exit(9); }
fs.appendFileSync(${JSON.stringify(join(root, "development.jsonl"))}, JSON.stringify({ commit: process.env.SLIPJAY_FINALIZATION_COMMIT, migrations: fs.existsSync("migrations") ? fs.readdirSync("migrations").sort() : [] }) + "\\n");`;
// The release check records where it ran, and its temporary directory with whether an earlier
// turn's file was left there; it fails while `fail-release` exists. It writes `release-started`,
// then holds while `hold-release` exists; with `hang-release` it never ends.
const releaseCheck = (root: string) => `const fs=require("node:fs");const at=(name)=>require("node:path").join(${JSON.stringify(root)}, name);
fs.appendFileSync(at("release-verified.log"), process.cwd() + "\\n");
const tmp=require("node:os").tmpdir(), left=require("node:path").join(tmp, "left-by-release");
fs.appendFileSync(at("release-tmp.jsonl"), JSON.stringify({ tmp, stale: fs.existsSync(left) }) + "\\n"); fs.writeFileSync(left, "");
if (fs.existsSync(at("fail-release"))) { process.stderr.write("release boom\\n"); process.exit(4); }
fs.writeFileSync(at("release-started"), "");
while (fs.existsSync(at("hold-release"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
if (fs.existsSync(at("hang-release"))) setInterval(()=>{},1000);`;
// The reset step records what it was given and the source it ran in, and prints the declared key, which must
// stay out of the log (the command line itself never names it). It writes `reset-started` and holds while `hold-reset` exists, and fails while `fail-reset` exists,
// handing SlipJay a reason line with a control character and a second line. Its probe names another
// target while `wrong-target` exists.
const resetStep = (root: string) => `const fs=require("node:fs"); const at=(name)=>require("node:path").join(${JSON.stringify(root)}, name);
fs.writeFileSync(at("reset-started"), "");
while (fs.existsSync(at("hold-reset"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
fs.appendFileSync(at("reset.jsonl"), JSON.stringify({ target: process.env.SLIPJAY_RESET_TARGET, source: process.env.SLIPJAY_RESET_SOURCE, reasonFile: Boolean(process.env.SLIPJAY_RESET_REASON_FILE), key: process.env.FIXTURE_KEY ?? null, head: require("node:child_process").execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() }) + "\\n");
console.log("postgres://owner:" + process.env.FIXTURE_KEY + "@db.example/prod restored");
console.error("Error: private-" + "customer-record-fixture");
if (fs.existsSync(at("fail-reset"))) { fs.writeFileSync(process.env.SLIPJAY_RESET_REASON_FILE, "Scrub refused:\\u0007 a real-customer tenant\\nsecond-" + "line"); process.exit(3); }`;
const resetProbe = (root: string) => `console.log(JSON.stringify({ target: require("node:fs").existsSync(${JSON.stringify(join(root, "wrong-target"))}) ? "production-db" : "fixture-development-db" }))`;
// Each deploy project records what it deployed and prints its deployment URL; it fails while `fail-deploy-<name>` exists.
const deployStep = (root: string, name: string) => `const fs=require("node:fs");
if (fs.existsSync(${JSON.stringify(join(root, `fail-deploy-${name}`))})) { console.error("${name} build failed"); process.exit(5); }
fs.appendFileSync(${JSON.stringify(join(root, "deploys.jsonl"))}, JSON.stringify({ project: "${name}", environment: process.env.SLIPJAY_DEPLOY_ENVIRONMENT, commit: process.env.SLIPJAY_DEPLOY_COMMIT, key: process.env.FIXTURE_KEY ?? null, head: require("node:child_process").execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() }) + "\\n");
console.log("building"); if (!fs.existsSync(${JSON.stringify(join(root, `omit-url-${name}`))})) console.log("https://${name}-" + process.env.SLIPJAY_DEPLOY_COMMIT.slice(0, 7) + ".example");`;
// Activation switches a real traffic pointer before a forward failure. Restoration failures
// have a separate marker and leave that pointer unchanged.
const productionStep = (root: string, name: string, step: "health" | "activate") => `const fs=require("node:fs");
if ("${step}" === "activate") fs.appendFileSync(${JSON.stringify(join(root, "rollback-authority.jsonl"))}, JSON.stringify({ project: "${name}", allowed: process.env.SLIPJAY_DEPLOY_ROLLBACK_ALLOWED, restore: process.env.SLIPJAY_DEPLOY_RESTORE ?? null }) + "\\n");
const restore = process.env.SLIPJAY_DEPLOY_RESTORE === "1";
if ("${step}" === "activate") {
  if (restore && fs.existsSync(${JSON.stringify(join(root, "reject-after-restore"))})) fs.writeFileSync(${JSON.stringify(join(root, "reject-push"))}, "");
  if (restore && fs.existsSync(${JSON.stringify(join(root, `fail-restore-${name}`))})) { console.error("${name} restore failed"); process.exit(7); }
  fs.writeFileSync(${JSON.stringify(join(root, `active-${name}.txt`))}, process.env.SLIPJAY_DEPLOY_URL);
}
if (!restore && fs.existsSync(${JSON.stringify(join(root, `fail-${step}-${name}`))})) { console.error("${name} ${step} failed"); process.exit(6); }
fs.appendFileSync(${JSON.stringify(join(root, `${step}.jsonl`))}, JSON.stringify({ project: "${name}", url: process.env.SLIPJAY_DEPLOY_URL, ...process.env.SLIPJAY_DEPLOY_RESTORE ? { restore: true } : {} }) + "\\n");
fs.appendFileSync(${JSON.stringify(join(root, "order.log"))}, "${step} ${name}\\n");`;
// Production's database is \`production-db.json\`, the migrations it applied. Verify exits 0 when they are
// the commit's \`migrations/\`, 2 when some are pending, and 1 while \`fail-verify\` exists; apply fails while
// \`fail-apply\` exists. Failures print a database URL, which the record must not carry.
const migrationStep = (root: string, step: "verify" | "apply") => `const fs=require("node:fs");
const db=${JSON.stringify(join(root, "production-db.json"))}; const applied=fs.existsSync(db)?JSON.parse(fs.readFileSync(db,"utf8")):[];
const wanted=fs.existsSync("migrations")?fs.readdirSync("migrations").sort():[];
fs.appendFileSync(${JSON.stringify(join(root, "order.log"))}, "${step}\\n");
if (fs.existsSync(${JSON.stringify(join(root, `fail-${step}`))})) { console.error("postgres://owner:hunter2@db.example/prod refused"); process.exit(1); }
if ("${step}"==="apply") fs.writeFileSync(db, JSON.stringify(wanted));
else process.exit(JSON.stringify(applied)===JSON.stringify(wanted)?0:2);`;
// Every test builds its own origin, checkouts and queue under a fresh root, so they run together:
// one after another they take over five minutes, the longest pole of the suite.
const test = serialTest.concurrent;
const jj = (cwd: string, args: string[]) => execFileSync("jj", ["--color=never", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();

// `other` adds a second repository, Fixture/Other, with the same policy: its own origin, author and warm checkout.
async function fixture(migrations = false, release = false, deployments?: { minIntervalMs: number; production?: boolean | "migrations" }, reset = false,
  { workers, other = false, lane, branch = "main", verificationDepth, prefixGate, durable = false, combinedLimits = true }: { workers?: number; other?: boolean; lane?: string; branch?: string; verificationDepth?: 1 | 2; prefixGate?: (root: string) => string; durable?: boolean; combinedLimits?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runner-queue-")));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const author = join(root, "author");
  const home = join(root, "runner");
  await mkdir(seed);
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git(["init", "--bare", "-b", branch, origin]);
  // Both clone and later bounded jj commands use this file's disposable HOME.
  jj(root, ["config", "set", "--user", "user.name", "Fixture"]);
  jj(root, ["config", "set", "--user", "user.email", "fixture@example.com"]);
  jj(seed, ["git", "init"]);
  await writeFile(join(seed, "slipjay.json"), JSON.stringify({
    version: 1, integrationBranch: branch,
    sourcePublication: { version: 1, mode: "required", remote: "origin" },
    requiredLandingVerification: [{ executable: "node", args: ["-e", prefixGate?.(root) ?? gate] }],
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
        ...(deployments.production ? { production: { timeoutMs: 30_000, environmentKeys: ["FIXTURE_KEY", "SLIPJAY_DEPLOY_ROLLBACK_ALLOWED"],
          projects: ["app", "hq", "www"].map((name) => ({ name, command: { executable: "node", args: ["-e", deployStep(root, name)] },
            healthCheck: { executable: "node", args: ["-e", productionStep(root, name, "health")] },
            activate: { executable: "node", args: ["-e", productionStep(root, name, "activate")] } })),
          ...(deployments.production === "migrations" ? { migrations: { verify: { executable: "node", args: ["-e", migrationStep(root, "verify")] },
            apply: { executable: "node", args: ["-e", migrationStep(root, "apply")] } } } : {}) } } : {}),
      } },
    } : {}),
    ...(release ? {
      releaseBranch: "release",
      requiredReleaseVerification: [{ executable: "node", args: ["-e", releaseCheck(root)] }],
    } : {}),
    ...(reset ? {
      reset: {
        version: 1, target: "fixture-development-db", timeoutMs: 30_000, intervalMs: 3_600_000, environmentKeys: ["FIXTURE_KEY"],
        command: { executable: "node", args: ["-e", resetStep(root)] },
        targetProbe: { executable: "node", args: ["-e", resetProbe(root)] },
      },
    } : {}),
  }));
  jj(seed, ["describe", "-m", "Seed policy"]);
  jj(seed, ["git", "remote", "add", "origin", origin]);
  jj(seed, ["git", "push", "--remote", "origin", "--named", `${branch}=@`]);
  if (release) jj(seed, ["git", "push", "--remote", "origin", "--named", "release=main"]);
  jj(root, ["git", "clone", origin, author]);
  const otherOrigin = join(root, "other.git");
  const otherAuthor = join(root, "other-author");
  if (other) {
    const otherSeed = join(root, "other-seed");
    await mkdir(otherSeed);
    git(["init", "--bare", "-b", "main", otherOrigin]);
    jj(otherSeed, ["git", "init"]);
    await writeFile(join(otherSeed, "slipjay.json"), await readFile(join(seed, "slipjay.json"), "utf8"));
    jj(otherSeed, ["describe", "-m", "Seed policy"]);
    jj(otherSeed, ["git", "remote", "add", "origin", otherOrigin]);
    jj(otherSeed, ["git", "push", "--remote", "origin", "--named", "main=@"]);
    jj(root, ["git", "clone", otherOrigin, otherAuthor]);
  }
  // While `reject-push` exists the remote refuses every push, as an outage would.
  await writeFile(join(origin, "hooks", "pre-receive"), `#!/bin/sh\nif [ -e ${JSON.stringify(join(root, "reject-push"))} ]; then echo "remote unavailable" >&2; exit 1; fi\n`);
  await chmod(join(origin, "hooks", "pre-receive"), 0o755);
  const logPath = durable ? join(root, "events.sqlite") : ":memory:";
  const log = openOperationLog(logPath, { ...workers === undefined ? {} : { workers }, ...lane ? { lane: () => lane } : {} });
  const published: StoredEvent[] = [];
  // Whether each landing's candidate bookmark was still on origin when its verdict was published.
  const candidateAtVerdict = new Map<string, boolean>();
  const requestedTimeouts: { command: string; timeoutMs: number; migrationContext?: string }[] = [];
  const local = testExecutor({ home });
  // Unless told otherwise the fixture stands in for an enforced combined budget, so concurrent paths run on
  // every platform: without systemd it runs commands directly rather than one at a time.
  const run = local.combinedLimits ? local.run : runBoundedProcess;
  const executor: Executor = { ...local, combinedLimits, run: (request) => {
    requestedTimeouts.push({ command: [request.executable, ...request.args].join(" "), timeoutMs: request.timeoutMs,
      ...(request.env?.SLIPJAY_MIGRATION_CONTEXT ? { migrationContext: request.env.SLIPJAY_MIGRATION_CONTEXT } : {}) });
    return run(request);
  } };
  const unsubscribe = log.subscribe((event) => {
    if (event.event.type !== "submitted") published.push(event);
    const operation = log.operation(event.operationId);
    if (operation?.kind === "landing" && TERMINAL_EVENT_TYPES.includes(event.event.type as never))
      candidateAtVerdict.set(event.operationId, Boolean(git(["--git-dir", origin, "for-each-ref", `refs/heads/${operation.bookmark}`])));
  });
  const queue = createRunnerQueue({ log, executor, home, config: { repos: { "Fixture/Repo": { url: origin, verificationDepth, ...lane ? { lane } : {} }, ...other ? { "Fixture/Other": { url: otherOrigin, ...lane ? { lane } : {} } } : {} },
    ...workers === undefined ? {} : { workers },
    jj: { "user.name": "Runner Identity", "user.email": "runner@example.com" } },
    environment: () => ({ ...process.env, FIXTURE_KEY: "from-runner", SLIPJAY_DEPLOY_ROLLBACK_ALLOWED: "spoofed-environment-value" }) });
  const main = () => git(["--git-dir", origin, "rev-parse", branch]);
  const releaseRef = () => git(["--git-dir", origin, "rev-parse", "release"]);
  const parents = (commit: string) => git(["--git-dir", origin, "log", "-1", "--format=%P", commit]).split(" ");
  const remoteFile = (file: string) => git(["--git-dir", origin, "show", `main:${file}`]);
  const authorRoot = author;
  async function push(author = authorRoot, repo = "fixture/repo"): Promise<SubmitRequest> {
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
    return { repo, changeId, commitId, bookmark, submittedBy: "test" };
  }
  async function candidate(file: string, author = authorRoot, repo = "fixture/repo"): Promise<SubmitRequest> {
    jj(author, ["new", `${branch}@origin`]);
    await mkdir(join(author, file, ".."), { recursive: true });
    await writeFile(join(author, file), `${file}\n`);
    jj(author, ["describe", "-m", `Add ${file}`]);
    return push(author, repo);
  }
  function submit(request: SubmitRequest) {
    const id = newOperationId();
    log.append(id, { type: "submitted", ...request });
    return id;
  }
  function submitReset() {
    const id = newOperationId();
    log.append(id, { type: "submitted", kind: "reset", repo: "fixture/repo", commitId: log.lastLanded("fixture/repo")?.commitId ?? "0".repeat(40), submittedBy: "test" });
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
  const otherMain = () => git(["--git-dir", otherOrigin, "rev-parse", "main"]);
  return { root, logPath, requestedTimeouts, candidateAtVerdict, development, land, origin, author, otherAuthor, otherMain, home, log, queue, executor, published, main, releaseRef, parents, remoteFile, push, candidate, submit, submitRelease, submitReset, lines, result,
    async dispose() {
      queue.close(); await queue.idle(); unsubscribe();
      const capture = process.env.SLIPJAY_CAPTURE_PIPELINE_FIXTURES;
      if (capture) {
        await mkdir(capture, { recursive: true });
        await writeFile(join(capture, `${root.slice(root.lastIndexOf("/") + 1)}.json`), JSON.stringify(log.events()).split(root).join("[FIXTURE]"));
      }
      log.close();
      // A hanging gate's detached tools outlive a process-group kill where no systemd slice holds them.
      for (const file of (await readdir(root)).filter((name) => name.endsWith("pids.json")))
        for (const pid of JSON.parse(await readFile(join(root, file), "utf8").catch(() => "[]")) as number[]) try { process.kill(pid, "SIGKILL"); } catch {}
      await rm(root, { recursive: true, force: true });
    } };
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
      assert.equal(operation.runs[0]!.timeoutMs, f.requestedTimeouts.find((request) => request.command === command)!.timeoutMs);
      assert.equal(operation.runs[0]!.exitCode, 0);
      const evidence = f.log.events({ operationId: id }).map((row) => row.event);
      const shape = evidence.findLast((event) => event.type === "change_shape");
      assert.ok(shape?.type === "change_shape");
      assert.equal(shape.files, 1);
      assert.equal(shape.insertions, 1);
      assert.equal(shape.migrationBearing, false);
      assert.match(shape.fileSet, /^[a-f0-9]{64}$/);
      assert.ok(evidence.some((event) => event.type === "queue_snapshot" && event.depth >= event.position));
      assert.ok(evidence.some((event) => event.type === "verification_base" && event.base === (id === a ? first.base : second.base)));
      assert.ok(evidence.some((event) => event.type === "stage_detail" && event.stage === "verifying" && event.durationMs >= 0));
      assert.equal(operation.runs[0]!.killed, false);
      assert.ok(Number.isFinite(operation.runs[0]!.outputBytes));
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

test("a renamed integration bookmark is fetched and tracked without deleting the old bookmark", async () => {
  const f = await fixture();
  try {
    jj(f.author, ["new", "main"]);
    const policyPath = join(f.author, "slipjay.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    await writeFile(policyPath, JSON.stringify({ ...policy, integrationBranch: "renamed" }));
    jj(f.author, ["describe", "-m", "Rename integration"]);
    const rename = await f.land(f.submit(await f.push()));
    assert.equal(rename?.type, "landed", JSON.stringify(rename));
    const oldTip = f.main();
    jj(f.author, ["git", "fetch", "--remote", "origin", "--branch", "main"]);
    jj(f.author, ["git", "push", "--remote", "origin", "--named", "renamed=main@origin"]);
    const checkout = join(f.home, "repos", "fixture/repo");
    assert.equal(jj(checkout, ["log", "--no-graph", "-r", 'bookmarks("renamed")', "-T", "commit_id"]), "");
    const next = await f.land(f.submit(await f.candidate("after-rename.txt")));
    assert.equal(next?.type, "landed", JSON.stringify(next));
    if (next?.type !== "landed") throw new Error("Expected renamed landing");
    assert.equal(next.branch, "renamed");
    assert.equal(execFileSync("git", ["--git-dir", f.origin, "rev-parse", "renamed"], { encoding: "utf8" }).trim(), next.commitId);
    assert.equal(f.main(), oldTip, "old remote bookmark remains unchanged");
    assert.equal(jj(checkout, ["log", "--no-graph", "-r", "main", "-T", "commit_id"]), oldTip, "old local bookmark remains unchanged");
    assert.equal(jj(checkout, ["log", "--no-graph", "-r", 'tracked_remote_bookmarks(exact:"renamed")', "-T", "commit_id"]), next.commitId);
  } finally { await f.dispose(); }
}, 120_000);

test("a missing renamed integration bookmark names the local and remote failure", async () => {
  const f = await fixture();
  try {
    jj(f.author, ["new", "main"]);
    const policyPath = join(f.author, "slipjay.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    await writeFile(policyPath, JSON.stringify({ ...policy, integrationBranch: "missing" }));
    jj(f.author, ["describe", "-m", "Rename integration"]);
    assert.equal((await f.land(f.submit(await f.push())))?.type, "landed");
    const oldTip = f.main();
    const next = await f.land(f.submit(await f.candidate("after-rename.txt")));
    assert.equal(next?.type, "failed", JSON.stringify(next));
    assert.match(JSON.stringify(next), /integration bookmark 'missing'.*locally.*remote 'origin'/);
    assert.equal(f.main(), oldTip);
  } finally { await f.dispose(); }
}, 120_000);

for (const verificationDepth of [1, 2] as const) test(`a two-commit landing preserves feature attribution at depth ${verificationDepth}`, async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth });
  try {
    const base = f.main();
    jj(f.author, ["new", "main", "-m", "feat: deliver the feature\n\nFeature body.\n\nIssue: pechhe/slipjay#59"]);
    await writeFile(join(f.author, "feature.txt"), "feature\n");
    jj(f.author, ["new", "@", "-m", "fix: answer review\n\nReview body."]);
    await writeFile(join(f.author, "review.txt"), "review\n");
    const result = await f.land(f.submit(await f.push()));
    assert.equal(result?.type, "landed", JSON.stringify(result));
    const description = execFileSync("git", ["--git-dir", f.origin, "show", "-s", "--format=%B", f.main()], { encoding: "utf8" }).trim();
    if (verificationDepth === 2) {
      assert.equal(description, "feat: deliver the feature\n\nFeature body.\n\nIssue: pechhe/slipjay#59\n\nfix: answer review\n\nReview body.");
      assert.equal(f.parents(f.main())[0], base, "folded artifact extends integration directly");
    } else {
      assert.equal(description, "fix: answer review\n\nReview body.");
      const first = f.parents(f.main())[0]!;
      assert.equal(execFileSync("git", ["--git-dir", f.origin, "show", "-s", "--format=%B", first], { encoding: "utf8" }).trim(),
        "feat: deliver the feature\n\nFeature body.\n\nIssue: pechhe/slipjay#59");
      assert.equal(f.parents(first)[0], base, "serial landing preserves both commits");
    }
    assert.equal(f.remoteFile("feature.txt"), "feature");
    assert.equal(f.remoteFile("review.txt"), "review");
  } finally { await f.dispose(); }
}, 120_000);

test("a rebase conflict in the policy returns the runner to integration before an independent landing", async () => {
  const f = await fixture();
  try {
    const makePolicyCandidate = async (projectCode: string) => {
      jj(f.author, ["new", "main"]);
      const path = join(f.author, "slipjay.json");
      const policy = JSON.parse(await readFile(path, "utf8"));
      policy.projectCode = projectCode;
      await writeFile(path, JSON.stringify(policy));
      jj(f.author, ["describe", "-m", `Set project code ${projectCode}`]);
      return f.push();
    };
    const first = await makePolicyCandidate("aa");
    const conflicting = await makePolicyCandidate("bb");
    const independent = await f.candidate("independent.txt");
    assert.equal((await f.land(f.submit(first)))?.type, "landed");
    const failed = f.submit(conflicting);
    const failure = await f.land(failed);
    assert.ok(failure?.type === "failed", JSON.stringify(failure));
    assert.equal(failure.stage, "rebasing");
    assert.match(failure.reason, /conflict/i);
    const checkout = join(f.home, "repos", "fixture/repo");
    assert.equal(jj(checkout, ["log", "-r", "@", "--no-graph", "-T", "conflict"]), "false");
    assert.equal(jj(checkout, ["log", "-r", "parents(@)", "--no-graph", "-T", "commit_id"]), f.main());
    assert.equal(f.candidateAtVerdict.get(failed), false);
    assert.equal(JSON.parse(await readFile(join(checkout, "slipjay.json"), "utf8")).projectCode, "aa");
    assert.equal((await f.land(f.submit(independent)))?.type, "landed");
    assert.equal(f.remoteFile("independent.txt"), "independent.txt");
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
    assert.equal(failure.output, gateFailureOutput);
    assert.equal(f.log.operation(failed)!.runs[0]!.exitCode, 3);
    const context = f.log.operation(failed)!.runs[0]!.commandEvidence;
    assert.equal(context?.status, "recorded");
    if (context?.status !== "recorded") throw new Error("Expected structured gate command");
    assert.equal(context.executable, "node");
    assert.deepEqual(context.args, ["-e", gate]);
    assert.equal(context.cwd, ".");
    assert.equal(context.redacted, false);
    assert.ok(context.environmentNames.includes("PATH"));
    assert.doesNotMatch(JSON.stringify(context), /SLIPJAY_RUNNER_TOKEN/);
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

test("middle failure diagnostics survive queue events and durable log retrieval", async () => {
  const f = await fixture(false, false, undefined, false, { durable: true, prefixGate: () =>
    `const fs=require('node:fs'); const noise='ordinary progress\\n'.repeat(7000);
    fs.writeSync(2,noise); fs.writeSync(2,' FAIL tests/hidden.test.ts > rejects stale source\\nAssertionError: stale source was accepted\\n ❯ tests/hidden.test.ts:27:3\\n');
    fs.writeSync(2,noise); process.exitCode=1;` });
  try {
    const before = f.main();
    const id = f.submit(await f.candidate("diagnostic.txt"));
    const result = await f.land(id);
    assert.ok(result?.type === "failed", JSON.stringify(result));
    assert.match(result.reason, /tests\/hidden.test.ts > rejects stale source/);
    assert.match(result.reason, /AssertionError: stale source was accepted/);
    const run = f.log.operation(id)!.runs.at(-1)!;
    assert.deepEqual(run.failingTests, ["tests/hidden.test.ts > rejects stale source"]);
    assert.ok(run.diagnostics?.some((line) => line.includes("tests/hidden.test.ts:27:3")));
    assert.equal(run.diagnosticCapture, "selected");
    assert.equal(run.artifact?.status, "retained");
    if (run.artifact?.status !== "retained") throw new Error("Expected retained command artifact");
    assert.equal(run.artifact.complete, false);
    const artifact = await readCommandArtifact(f.home, id, run.runId, run.artifact, 0, 16384);
    assert.match(Buffer.from(artifact.dataBase64, "base64").toString("utf8"), /tests\/hidden.test.ts:27:3/);
    assert.equal(f.main(), before);
    const reopened = openOperationLog(f.logPath);
    try {
      assert.deepEqual(reopened.operation(id)!.runs.at(-1)!.failingTests, run.failingTests);
      assert.match(JSON.stringify(reopened.events({ operationId: id })), /stale source was accepted/);
    } finally { reopened.close(); }
    const retrieved = await f.queue.readLog(id);
    assert.match(retrieved!, /tests\/hidden.test.ts:27:3/);
  } finally { await f.dispose(); }
}, 120_000);

test("artifact capture failure keeps the original failed gate and selected diagnostics", async () => {
  const f = await fixture();
  try {
    await mkdir(f.home, { recursive: true });
    await writeFile(join(f.home, "command-artifacts"), "storage unavailable");
    const before = f.main();
    const id = f.submit(await f.candidate("fail"));
    const result = await f.land(id);
    assert.equal(result?.type, "failed");
    assert.equal(f.main(), before);
    const run = f.log.operation(id)!.runs[0]!;
    assert.equal(run.exitCode, 3);
    assert.deepEqual(run.artifact, { status: "unavailable", reason: "capture-failed" });
    assert.equal(run.diagnosticCapture, "selected");
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
/** Whether runs get systemd slices here: the runner's production executor. */
const systemd = process.platform === "linux" && Boolean(process.env.XDG_RUNTIME_DIR);
/** The cgroup path of a live process (Linux). */
const cgroupOf = async (pid: number) => (await readFile(`/proc/${pid}/cgroup`, "utf8")).trim().split(":").at(-1)!;

test("the owner's kill stops a running gate: cancelled, never passed, main unchanged, and the queue moves on", async () => {
  const f = await fixture();
  try {
    const before = f.main();
    const pids = join(f.root, "gate-pids.json");
    await f.candidate("hang");
    await writeFile(join(f.author, "hang"), `${pids}\n`);
    const killed = f.submit(await f.push());
    const next = f.submit(await f.candidate("next.txt"));
    assert.deepEqual(f.queue.kill(), { status: "idle" }, "an idle runner has nothing to kill");
    f.queue.wake();
    const [gatePid, childPid, toolPid, scopedPid] = await until(async () => {
      const text = await readFile(pids, "utf8").catch(() => "");
      return text ? JSON.parse(text) as [number, number, number, number?] : undefined;
    });
    const outcome = f.queue.kill();
    assert.ok(outcome.status === "killed" && outcome.operation.id === killed, JSON.stringify(outcome));
    await f.queue.idle();
    assert.deepEqual(f.result(killed), { type: "cancelled", reason: OWNER_KILL_REASON });
    const landed = f.result(next);
    assert.ok(landed?.type === "landed", JSON.stringify(landed));
    assert.equal(landed.base, before, "the killed change never integrated");
    assert.equal(alive(gatePid), false, "the gate process is gone");
    await until(() => alive(childPid) ? undefined : true, 5_000);
    // A systemd scope reaches the tool's own process group; a bare process group cannot.
    if (systemd) {
      assert.equal(alive(toolPid), false, "the gate's detached tool is gone");
      assert.equal(alive(scopedPid!), false, "the tool in the gate's own nested scope is gone");
    } else process.kill(toolPid, "SIGKILL");
    assert.deepEqual(f.queue.kill(), { status: "idle" });
  } finally { await f.dispose(); }
}, 120_000);

test("without enforced combined limits the runner runs one operation at a time and refuses concurrent workers", async () => {
  assert.equal(runnerWorkers({}, { combinedLimits: true }), 2);
  assert.equal(runnerWorkers({ workers: 3 }, { combinedLimits: true }), 3);
  assert.equal(runnerWorkers({}, {}), 1);
  assert.equal(runnerWorkers({ workers: 1 }, { combinedLimits: false }), 1);
  assert.throws(() => runnerWorkers({ workers: 2 }, {}), /2 workers require an executor with enforced combined resource limits/);
  const f = await fixture(false, false, undefined, false, { other: true, combinedLimits: false });
  try {
    const pids = join(f.root, "gate-pids.json");
    const stuck = f.submit(await hanging(f, pids));
    const other = f.submit(await f.candidate("other.txt", f.otherAuthor, "fixture/other"));
    f.queue.wake();
    await started(pids);
    assert.equal(f.log.operation(other)!.status, "queued", "another repository's landing does not run beside it");
    assert.equal(f.queue.kill(stuck).status, "killed");
    await f.queue.idle();
    assert.equal(f.result(other)?.type, "landed", JSON.stringify(f.result(other)));
  } finally { await f.dispose(); }
}, 120_000);

test("without systemd the executor runs one command at a time, stops each command's group, and recovers a killed runner's group", async () => {
  const home = await mkdtemp(join(tmpdir(), "runner-group-"));
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  try {
    // No XDG_RUNTIME_DIR: the process-group executor, on every platform.
    const executor = testExecutor({ env: {}, home });
    assert.equal(executor.combinedLimits, undefined);
    const spans = join(home, "spans.jsonl");
    const span = `const fs=require("node:fs");const start=Date.now();setTimeout(()=>{fs.appendFileSync(${JSON.stringify(spans)},JSON.stringify([start,Date.now()])+"\\n")},300)`;
    const request = { executable: process.execPath, args: ["-e", span], cwd: home, timeoutMs: 30_000, maxOutputBytes: 65_536 };
    await Promise.all([executor.run(request), executor.run(request)]);
    const [first, second] = (await readFile(spans, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as [number, number]);
    assert.ok(second![0] >= first![1], `the second command started only after the first ended: ${JSON.stringify([first, second])}`);
    // A command's own group is stopped after it, even when the command itself exits.
    const pidFile = join(home, "member.pid");
    const leaves = `const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref()`;
    await executor.run({ ...request, args: ["-e", leaves] });
    const member = Number(await readFile(pidFile, "utf8"));
    await until(() => alive(member) ? undefined : true, 5_000);
    // A runner killed outright leaves its command's group; the next process with the same home stops it.
    const pids = join(home, "pids.json");
    await writeFile(join(home, "hang"), `${pids}\n`);
    const driver = `
      import { localExecutor } from ${JSON.stringify(new URL("../src/lib/runner-queue.ts", import.meta.url).href)};
      localExecutor({ env: {}, home: ${JSON.stringify(home)} }).run({ executable: process.execPath, args: ["-e", ${JSON.stringify(gate)}], cwd: ${JSON.stringify(home)}, timeoutMs: 60_000, maxOutputBytes: 65_536 });
      setInterval(() => {}, 1000);
    `;
    child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", driver], { stdio: "ignore" });
    exited = new Promise((resolve) => child!.once("exit", resolve));
    const [gatePid, childPid, toolPid] = await until(async () => {
      const text = await readFile(pids, "utf8").catch(() => "");
      return text ? JSON.parse(text) as number[] : undefined;
    });
    child.kill("SIGKILL"); await exited;
    assert.deepEqual([alive(gatePid!), alive(childPid!)], [true, true], "the killed runner's command outlives it");
    await testExecutor({ env: {}, home }).recover!();
    await until(() => alive(gatePid!) || alive(childPid!) ? undefined : true, 5_000);
    assert.deepEqual(await readdir(join(home, "commands")), [], "recovery clears what it stopped");
    // The tool that left the group is out of the fallback's reach, as documented.
    process.kill(toolPid!, "SIGKILL");
  } finally {
    child?.kill("SIGKILL"); await exited;
    await rm(home, { recursive: true, force: true });
  }
}, 120_000);

test("a run whose processes cannot be shown stopped fails, and every later run waits until they stop", async () => {
  const { settled, contained } = runContainment();
  const failures = ["still running", "still running", null];
  const stop = async () => failures.shift() ?? null;
  await assert.rejects(contained("run-a", async () => "done", stop), /could not stop the processes of run-a/);
  await assert.rejects(settled(), /earlier run \(run-a\) could not be stopped: still running/);
  await settled();
  assert.equal(await contained("run-b", async () => "done", async () => null), "done");
  await assert.rejects(contained("run-c", async () => { throw new Error("gate failed"); }, async () => "stuck"), /gate failed/);
  await assert.rejects(settled(), /run-c/);
});

(systemd ? test : test.skip)("each run's processes, nested scopes included, stay within the runner's slice and stop with the run", async () => {
  const home = await mkdtemp(join(tmpdir(), "runner-slice-"));
  const controller = new AbortController();
  try {
    const executor = testExecutor({ home });
    const pids = join(home, "pids.json");
    await writeFile(join(home, "hang"), `${pids}\n`);
    const running = executor.run({ executable: "node", args: ["-e", gate], cwd: home, timeoutMs: 60_000, maxOutputBytes: 65_536, abortSignal: controller.signal });
    const recorded = await until(async () => {
      const text = await readFile(pids, "utf8").catch(() => "");
      return text ? JSON.parse(text) as number[] : undefined;
    });
    assert.equal(recorded.length, 4, "the gate started a nested scope");
    const ownSlice = await cgroupOf(recorded[0]!);
    for (const pid of recorded) {
      const cgroup = await cgroupOf(pid);
      // The budget is the disposable test slice, or the enclosing runner command's slice when nested in one.
      assert.ok(cgroup.includes(`/${process.env.SLIPJAY_SYSTEMD_SLICE ?? TEST_SLICE}/`), `${pid} is within the combined budget: ${cgroup}`);
      assert.ok(cgroup.startsWith(ownSlice.slice(0, ownSlice.lastIndexOf("/"))), `${pid} is within its run's slice: ${cgroup}`);
    }
    controller.abort();
    await running;
    await until(() => recorded.some(alive) ? undefined : true, 10_000);
  } finally { controller.abort(); await rm(home, { recursive: true, force: true }); }
}, 120_000);

(systemd ? test : test.skip)("after the runner is killed outright, the next process stops only the commands it left before reusing their checkout", async () => {
  const f = await fixture(false, false, undefined, false, { durable: true });
  const bystanderHome = await mkdtemp(join(tmpdir(), "runner-bystander-"));
  const bystanderStop = new AbortController();
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  let stderr = "";
  try {
    // Another runner's command on the same host, which recovery must leave alone.
    const bystanderPids = join(bystanderHome, "pids.json");
    await writeFile(join(bystanderHome, "hang"), `${bystanderPids}\n`);
    const bystander = testExecutor({ home: bystanderHome })
      .run({ executable: "node", args: ["-e", gate], cwd: bystanderHome, timeoutMs: 120_000, maxOutputBytes: 65_536, abortSignal: bystanderStop.signal });
    const pids = join(f.root, "gate-pids.json");
    const stuck = f.submit(await hanging(f, pids));
    const driver = `
      import { createRunnerQueue, localExecutor } from ${JSON.stringify(new URL("../src/lib/runner-queue.ts", import.meta.url).href)};
      import { openOperationLog } from ${JSON.stringify(new URL("../src/lib/runner-log.ts", import.meta.url).href)};
      const log = openOperationLog(${JSON.stringify(f.logPath)});
      const queue = createRunnerQueue({ log, executor: localExecutor({ home: ${JSON.stringify(f.home)}, slice: ${JSON.stringify(TEST_SLICE)} }), home: ${JSON.stringify(f.home)},
        config: { repos: { 'Fixture/Repo': { url: ${JSON.stringify(f.origin)} } }, jj: { 'user.name': 'Runner Identity', 'user.email': 'runner@example.com' } } });
      queue.wake(); setInterval(() => {}, 1000);
    `;
    child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", driver], { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr!.on("data", (data) => { stderr += data.toString(); });
    exited = new Promise((resolve) => child!.once("exit", resolve));
    const left = await until(async () => {
      assert.equal(child!.exitCode, null, stderr);
      const text = await readFile(pids, "utf8").catch(() => "");
      return text ? JSON.parse(text) as number[] : undefined;
    });
    const others = await until(async () => {
      const text = await readFile(bystanderPids, "utf8").catch(() => "");
      return text ? JSON.parse(text) as number[] : undefined;
    });
    assert.equal(left.length, 4, "the gate started a nested scope");
    child.kill("SIGKILL"); await exited;
    // Nothing stopped the gate: the killed runner had no chance to.
    assert.deepEqual(left.map(alive), [true, true, true, true], "the killed runner's commands outlive it");
    await f.queue.recover();
    assert.deepEqual(left.map(alive), [false, false, false, false], "recovery stopped every command the killed runner left");
    assert.deepEqual(others.map(alive), [true, true, true, true], "another runner's commands are untouched");
    assert.equal(f.result(stuck)?.type, "failed", JSON.stringify(f.result(stuck)));
    assert.match(JSON.stringify(f.result(stuck)), /runner restarted/);
    assert.equal((await f.land(f.submit(await f.candidate("after.txt"))))?.type, "landed", "the checkout is reused only after recovery");
    bystanderStop.abort();
    await bystander;
    await until(() => others.some(alive) ? undefined : true, 10_000);
  } finally {
    child?.kill("SIGKILL"); await exited; bystanderStop.abort();
    await rm(bystanderHome, { recursive: true, force: true }); await f.dispose();
  }
}, 180_000);

test("a kill past verification is refused and the landing completes", async () => {
  const f = await fixture(true);
  try {
    await writeFile(join(f.root, "hold-finalize"), "");
    const id = f.submit(await f.candidate("schema/a.ts"));
    f.queue.wake();
    await until(() => f.log.operation(id)!.stage === "finalizing" ? true : undefined);
    const outcome = f.queue.kill();
    assert.ok(outcome.status === "refused" && outcome.operation.stage === "finalizing", JSON.stringify(outcome));
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
    assert.equal(f.queue.kill().status, "killed");
    await f.queue.idle();
    assert.deepEqual(f.result(release), { type: "cancelled", reason: OWNER_KILL_REASON });
    assert.equal(f.releaseRef(), base);
  } finally { await f.dispose(); }
}, 120_000);

/** Commit a `hang` gate in `author` that records its pids in `pids`, and push it: the gate then never ends. */
async function hanging(f: Awaited<ReturnType<typeof fixture>>, pids: string, author = f.author, repo = "fixture/repo") {
  await f.candidate("hang", author, repo);
  await writeFile(join(author, "hang"), `${pids}\n`);
  return f.push(author, repo);
}
const started = (pids: string) => until(async () => await readFile(pids, "utf8").then((text) => text ? true : undefined, () => undefined));

test("another repository's landing runs beside a hanging one; a kill must name which of the two it stops", async () => {
  const f = await fixture(false, false, undefined, false, { other: true });
  try {
    const pids = join(f.root, "gate-pids.json");
    const stuck = f.submit(await hanging(f, pids));
    const queued = f.submit(await f.candidate("queued.txt"));
    const otherPids = join(f.root, "other-pids.json");
    const other = f.submit(await hanging(f, otherPids, f.otherAuthor, "fixture/other"));
    f.queue.wake();
    await started(pids);
    await started(otherPids);
    assert.deepEqual([f.log.operation(stuck)!.status, f.log.operation(other)!.status], ["running", "running"]);
    // The same repository's next landing still waits for its predecessor.
    assert.match(f.log.operation(queued)!.waitingFor ?? "", /^landing [0-9a-z]{12}$/);
    const ambiguous = f.queue.kill();
    assert.ok(ambiguous.status === "ambiguous" && ambiguous.operations.map((operation) => operation.id).sort().join() === [stuck, other].sort().join(), JSON.stringify(ambiguous));
    assert.equal(f.log.operation(stuck)!.status, "running", "an ambiguous kill stops nothing");
    assert.deepEqual(f.queue.kill("op_0000000000_000000000000000000000000"), { status: "not_running", operation: null });
    assert.equal(f.queue.kill(other).status, "killed");
    await until(() => f.log.operation(other)!.result ? true : undefined);
    assert.deepEqual(f.result(other), { type: "cancelled", reason: OWNER_KILL_REASON });
    assert.equal(f.log.operation(stuck)!.status, "running", "killing one operation leaves the other running");
    const finished = f.queue.kill(other);
    assert.ok(finished.status === "not_running" && finished.operation?.status === "cancelled", JSON.stringify(finished));
    // With one left running, the unnamed kill stops it, and the queued landing follows.
    assert.equal(f.queue.kill().status, "killed");
    await f.queue.idle();
    assert.equal(f.result(queued)?.type, "landed", JSON.stringify(f.result(queued)));
    for (const file of [pids, otherPids]) for (const pid of JSON.parse(await readFile(file, "utf8")) as number[]) try { process.kill(pid, "SIGKILL"); } catch {}
  } finally { await f.dispose(); }
}, 120_000);

test("a candidate on an older base lands without abandoning the integration published since, on a branch jj does not call trunk", async () => {
  const f = await fixture(false, false, undefined, false, { branch: "rollover" });
  try {
    const stale = await f.candidate("stale.txt");
    const first = await f.land(f.submit(await f.candidate("first.txt")));
    const second = await f.land(f.submit(await f.candidate("second.txt")));
    assert.ok(first?.type === "landed" && second?.type === "landed", JSON.stringify([first, second]));
    // `jj git clone` names the remote's default branch trunk(); a fork whose default is another
    // branch (pechhe/t3code integrates on rollover) has no such alias, so jj calls only main trunk.
    const checkout = join(f.home, "repos", "fixture/repo");
    jj(checkout, ["config", "unset", "--repo", 'revset-aliases."trunk()"']);
    // `stale` was made before both: the runner's cleanup must keep them, and land it on top.
    const landed = await f.land(f.submit(stale));
    assert.ok(landed?.type === "landed", JSON.stringify(landed));
    assert.equal(landed.base, second.commitId);
    assert.deepEqual(f.parents(second.commitId), [first.commitId]);
    assert.equal(jj(checkout, ["log", "-r", "rollover", "--no-graph", "-T", "commit_id"]), f.main());
    // A later landing still finds its integration branch.
    assert.equal((await f.land(f.submit(await f.candidate("after.txt"))))?.type, "landed");
  } finally { await f.dispose(); }
}, 120_000);

test("repositories that share a lane take turns even with a worker free", async () => {
  const f = await fixture(false, false, undefined, false, { other: true, lane: "shared-database" });
  try {
    const pids = join(f.root, "gate-pids.json");
    const stuck = f.submit(await hanging(f, pids));
    const other = f.submit(await f.candidate("other.txt", f.otherAuthor, "fixture/other"));
    f.queue.wake();
    await started(pids);
    assert.deepEqual([f.log.operation(other)!.status, f.log.operation(other)!.position], ["queued", 2]);
    assert.match(f.log.operation(other)!.waitingFor ?? "", /^landing [0-9a-z]{12}$/);
    assert.equal(f.queue.kill(stuck).status, "killed");
    await f.queue.idle();
    assert.equal(f.result(other)?.type, "landed", JSON.stringify(f.result(other)));
    for (const pid of JSON.parse(await readFile(pids, "utf8")) as number[]) try { process.kill(pid, "SIGKILL"); } catch {}
  } finally { await f.dispose(); }
}, 120_000);

test("with one worker, another repository's landing waits for it and names what holds the worker", async () => {
  const f = await fixture(false, false, undefined, false, { other: true, workers: 1 });
  try {
    const pids = join(f.root, "gate-pids.json");
    const stuck = f.submit(await hanging(f, pids));
    const other = f.submit(await f.candidate("other.txt", f.otherAuthor, "fixture/other"));
    f.queue.wake();
    await started(pids);
    const waiting = f.log.operation(other)!;
    assert.equal(waiting.status, "queued");
    assert.match(waiting.waitingFor ?? "", /^a worker \(landing [0-9a-z]{12}\)$/);
    assert.equal(f.queue.kill(stuck).status, "killed");
    await f.queue.idle();
    assert.equal(f.result(other)?.type, "landed", JSON.stringify(f.result(other)));
    for (const pid of JSON.parse(await readFile(pids, "utf8")) as number[]) try { process.kill(pid, "SIGKILL"); } catch {}
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

test("a Build-bound landing never starts before admission, holds no place in its lane, and once admitted still waits out a pause", async () => {
  const f = await fixture();
  try {
    const binding = { specId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", ticketIds: [], bodyRevision: null, bindGeneration: 1, sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" };
    const bound = newOperationId();
    f.log.append(bound, { type: "submitted", ...await f.candidate("bound.txt"), admission: { binding, specBodyHash: null, helperRevisions: [], repairsOperationId: null, supersedes: null } });
    const other = f.submit(await f.candidate("other.txt"));
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.result(other)?.type, "landed", JSON.stringify(f.result(other)));
    const pending = f.log.operation(bound)!;
    assert.ok(pending.kind === "landing" && pending.admission === "pending" && pending.status === "queued" && pending.runs.length === 0);
    assert.equal(pending.waitingFor, "Build admission");
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    f.log.append(bound, { type: "build_admitted", sequence: 1, sessionId: binding.sessionId, recordedAt: null });
    f.queue.wake(); await f.queue.idle();
    assert.deepEqual([f.log.operation(bound)!.status, f.log.operation(bound)!.stage], ["queued", "paused"]);
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "owner" });
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.result(bound)?.type, "landed", JSON.stringify(f.result(bound)));
  } finally { await f.dispose(); }
}, 120_000);

test("an admitted candidate waits while a newer one of its change awaits admission, and runs once Build refuses that one", async () => {
  const f = await fixture();
  try {
    const binding = { specId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", ticketIds: [], bodyRevision: null, bindGeneration: 1, sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" };
    const record = { binding, specBodyHash: null, helperRevisions: [], repairsOperationId: null, supersedes: null };
    const source = await f.candidate("held.txt");
    const admitted = newOperationId(), newer = newOperationId();
    f.log.append(admitted, { type: "submitted", ...source, admission: record });
    f.log.append(admitted, { type: "build_admitted", sequence: 1, sessionId: binding.sessionId, recordedAt: null });
    f.log.append(newer, { type: "submitted", ...source, admission: { ...record, supersedes: admitted } });
    f.queue.wake(); await f.queue.idle();
    const waiting = f.log.operation(admitted)!;
    assert.ok(waiting.status === "queued" && waiting.runs.length === 0 && waiting.waitingFor === "Build admission of a newer candidate", JSON.stringify(waiting));
    // Build refuses the newer one (a stale bind): the drain records it, and the queue starts the admitted candidate.
    const drain = createReceiptDrain({ log: f.log, route: () => Promise.resolve({ kind: "refused", code: "bind_generation_stale" }), onAdmissionSettled: f.queue.wake });
    drain.wake(); await drain.idle(); drain.close();
    await until(() => f.result(admitted)?.type === "landed" ? true : undefined);
    assert.equal(f.log.operation(newer)!.status, "declined");
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
    const shape = f.log.events({ operationId: id }).findLast((row) => row.event.type === "change_shape")?.event;
    assert.ok(shape?.type === "change_shape");
    const verifiedTree = execFileSync("git", ["--git-dir", f.origin, "rev-parse", `${landed.commitId}^{tree}`], { encoding: "utf8" }).trim();
    assert.equal(shape.fileSet, createHash("sha256").update(verifiedTree).digest("hex"), "source evidence includes generated migration artifacts verified by the gate");
    assert.equal(shape.migrationBearing, true);
    assert.equal(f.remoteFile("migrations/0001.sql"), "-- 1");
    assert.deepEqual(await f.development(), [{ commit: landed.commitId, migrations: ["0001.sql"] }]);
    assert.deepEqual(f.log.events({ operationId: id }).flatMap((stored) => stored.event.type === "stage" ? [stored.event.stage] : []), ["fetching", "rebasing", "installing", "verifying", "integrating", "finalizing", "publishing"]);
    // Generation, verification, the target probe and finalization all share the executor.
    assert.equal(f.log.operation(id)!.runs.length, 5);
    assert.deepEqual(f.log.operation(id)!.runs.map((run) => run.purpose), ["migration_generate", "migration_verify", "gate", "finalization", "finalization"]);
    const contexts = f.requestedTimeouts.flatMap((request) => request.migrationContext ? [JSON.parse(request.migrationContext) as { baseCommit: string; candidateChangeId: string; candidateCommit: string }] : []);
    assert.equal(contexts.length, 2, "both migration commands retain authoritative provenance through the runner");
    assert.deepEqual(contexts[0], contexts[1]);
    assert.equal(contexts[0]!.baseCommit, landed.base);
    const operation = f.log.operation(id)!;
    assert.equal(contexts[0]!.candidateChangeId, operation.kind === "landing" && operation.changeId);
    assert.notEqual(contexts[0]!.candidateCommit, landed.commitId, "provenance remains bound to the semantic source before generation");
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
    const checkout = join(f.home, "repos", "fixture/repo");
    assert.equal(jj(checkout, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]), finalized!.commit);
    assert.equal(jj(checkout, ["log", "-r", "parents(@)", "--no-graph", "-T", "commit_id"]), finalized!.commit);
    assert.equal(jj(checkout, ["log", "-r", "@", "--no-graph", "-T", "conflict"]), "false");
    const [hold] = f.log.snapshot(f.executor.host).held;
    assert.ok(hold);
    assert.equal(hold.repo, "fixture/repo");
    assert.equal(hold.commitId, finalized!.commit);
    assert.equal(hold.retries, 0);
    assert.match(hold.reason, /remote unavailable/);
    assert.equal(f.log.openOperations().length, 0);
    // Recovery must inspect warm checkouts even when every operation is terminal.
    f.log.append(RUNNER_CONTROL_ID, { type: "integration_recovered", repo: hold.repo, commitId: hold.commitId });
    assert.deepEqual(f.log.snapshot(f.executor.host).held, []);
    await f.queue.recover();
    const [rediscovered] = f.log.snapshot(f.executor.host).held;
    assert.equal(rediscovered?.commitId, hold.commitId);
    assert.equal(rediscovered?.retries, 0);
    // Another change cannot land past the held integration, and does not discard it.
    const blocked = f.submit(other);
    const refusal = await f.land(blocked);
    assert.equal(refusal?.type, "failed", JSON.stringify(refusal));
    assert.equal(refusal?.type === "failed" && refusal.stage, "publishing");
    const [retried] = f.log.snapshot(f.executor.host).held;
    assert.equal(retried?.since, rediscovered!.since);
    assert.equal(retried?.commitId, hold.commitId);
    assert.equal(retried?.retries, 1);
    await rm(join(f.root, "reject-push"));
    const reland = f.submit(request);
    const landed = await f.land(reland);
    assert.deepEqual(landed, { type: "landed", base: before, commitId: finalized!.commit, branch: "main", remote: "origin" });
    assert.equal(f.main(), finalized!.commit);
    assert.deepEqual(f.log.snapshot(f.executor.host).held, []);
    assert.equal(generations(f, [held, blocked, reland]), 1);
    assert.equal((await f.development()).length, 1);
    // A stale hold may have recovered externally; ordinary fetch must observe it.
    f.log.append(RUNNER_CONTROL_ID, { type: "integration_held", repo: "fixture/repo", commitId: finalized!.commit,
      reason: "Recorded before external publication was observed" });
    const after = f.submit(other);
    const second = await f.land(after);
    assert.equal(second?.type, "landed", JSON.stringify(second));
    assert.equal(second?.type === "landed" && second.base, finalized!.commit);
    assert.deepEqual(f.log.snapshot(f.executor.host).held, []);
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
    const [hold] = f.log.snapshot(f.executor.host).held;
    assert.ok(hold);
    assert.equal(hold.repo, "fixture/repo");
    assert.equal(hold.retries, 0);
    assert.match(hold.reason, /Post-integration/);
    assert.equal(f.log.openOperations().length, 0);
    await f.queue.recover();
    assert.deepEqual(f.log.snapshot(f.executor.host).held, [hold]);
    assert.equal(f.main(), before);
    await rm(join(f.root, "fail-finalize"));
    const next = f.submit(await f.candidate("next.txt"));
    const landed = await f.land(next);
    if (landed?.type !== "landed") throw new Error(JSON.stringify(landed));
    const [finalized] = await f.development();
    assert.deepEqual(finalized?.migrations, ["0001.sql"]);
    assert.equal(landed.base, finalized!.commit);
    assert.deepEqual(f.log.snapshot(f.executor.host).held, []);
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

test("restart recovery closes both interrupted lanes once, preserves a pause and leaves unrelated queued work recoverable", async () => {
  const f = await fixture(false, true, undefined, false, { other: true });
  try {
    const integration = f.main();
    const releaseBase = f.releaseRef();
    const candidate = await f.candidate("interrupted.txt");
    const landing = f.submit(candidate);
    const release = f.submitRelease(integration);
    const other = f.submit(await f.candidate("queued.txt", f.otherAuthor, "fixture/other"));
    f.log.append(landing, { type: "stage", stage: "verifying" });
    f.log.append(release, { type: "stage", stage: "verifying" });
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    await f.queue.recover();
    await f.queue.recover();
    for (const id of [landing, release]) {
      assert.equal(f.result(id)?.type, "failed");
      assert.equal(f.log.events({ operationId: id }).filter(({ event }) => TERMINAL_EVENT_TYPES.includes(event.type as never)).length, 1);
    }
    assert.equal(f.main(), integration);
    assert.equal(f.releaseRef(), releaseBase);
    assert.equal(f.log.operation(other)!.stage, "paused");
    f.queue.wake();
    await f.queue.idle();
    assert.equal(f.log.operation(other)!.status, "queued");
    // Recovery never invents a source retry or publication for either interrupted operation.
    assert.equal(jj(f.author, ["--ignore-working-copy", "log", "-r", candidate.commitId, "--no-graph", "-T", "commit_id"]), candidate.commitId);
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "owner" });
    assert.equal((await f.land(other))?.type, "landed");
    assert.equal(f.result(landing)?.type, "failed");
    assert.equal(f.result(release)?.type, "failed");
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
    const interrupted = f.submit(request);
    f.log.append(interrupted, { type: "stage", stage: "publishing" });
    f.log.append(interrupted, { type: "integrated", base: landed.base, commitId: landed.commitId });
    const checkout = join(f.home, "repos", "fixture/repo");
    jj(checkout, ["git", "remote", "set-url", "origin", join(f.root, "unavailable-origin.git")]);
    try {
      await f.queue.recover();
      assert.deepEqual(f.result(interrupted), { type: "failed", stage: "publishing", reason: "runner restarted during publishing; land again" });
      const [hold] = f.log.snapshot(f.executor.host).held;
      assert.ok(hold);
      assert.equal(hold.repo, "fixture/repo");
      assert.equal(hold.commitId, landed.commitId);
      assert.match(hold.reason, /unconfirmed/);
      assert.equal(f.log.openOperations().length, 0);
      await f.queue.recover();
      assert.deepEqual(f.log.snapshot(f.executor.host).held, [hold]);
    } finally {
      jj(checkout, ["git", "remote", "set-url", "origin", f.origin]);
    }
    await f.queue.recover();
    assert.deepEqual(f.log.snapshot(f.executor.host).held, []);
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

test("a release verifies its exact candidate in a checkout of its own while the repository's landings go on, then publishes the release branch", async () => {
  const f = await fixture(false, true);
  try {
    const base = f.releaseRef();
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const candidate = f.main();
    await writeFile(join(f.root, "hold-release"), "");
    const release = f.submitRelease(candidate);
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "release-started")).then(() => true, () => undefined));
    // The landing submitted behind the release lands while the release is still verifying.
    const behind = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(() => f.result(behind));
    assert.equal(f.result(behind)?.type, "landed", JSON.stringify(f.result(behind)));
    assert.equal(f.log.operation(release)!.stage, "verifying");
    await rm(join(f.root, "hold-release"));
    await f.queue.idle();
    const outcome = f.result(release);
    assert.ok(outcome?.type === "released" && outcome.result.status === "released", JSON.stringify(outcome));
    assert.equal(f.releaseRef(), outcome.result.merge);
    assert.deepEqual(f.parents(outcome.result.merge), [base, candidate], "the pinned candidate, not the newer integration");
    assert.deepEqual(stagesOf(f, release), ["fetching", "installing", "verifying", "publishing", "finalizing"]);
    // The check ran once, through the executor, in the runner's release checkout.
    assert.deepEqual(await f.lines("release-verified.log"), [join(f.home, "releases", "fixture/repo")]);
    assert.equal(f.log.operation(release)!.runs.length, 1);
    assert.equal(f.log.operation(release)!.runs[0]!.exitCode, 0);
  } finally { await f.dispose(); }
}, 120_000);

test("a verified release publishes only after the repository's running landing, and says it is waiting", async () => {
  const f = await fixture(false, true);
  try {
    const base = f.releaseRef();
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const candidate = f.main();
    const pids = join(f.root, "gate-pids.json");
    const stuck = f.submit(await hanging(f, pids));
    f.queue.wake();
    await started(pids);
    const release = f.submitRelease(candidate);
    f.queue.wake();
    await until(() => f.log.events({ operationId: release }).some((stored) => stored.event.type === "progress" && /^Verified; publishing after /.test(stored.event.line)) || undefined);
    assert.equal(f.releaseRef(), base, "nothing publishes while the landing holds the repository lane");
    assert.equal(f.queue.kill(stuck).status, "killed");
    await f.queue.idle();
    assert.equal(f.result(stuck)?.type, "cancelled");
    const outcome = f.result(release);
    assert.ok(outcome?.type === "released" && outcome.result.status === "released", JSON.stringify(outcome));
    assert.deepEqual(f.parents(f.releaseRef()), [base, candidate]);
  } finally { await f.dispose(); }
}, 120_000);

test("a release killed while it waits for the repository's running landing publishes nothing when the landing ends", async () => {
  const f = await fixture(false, true);
  try {
    const base = f.releaseRef();
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const candidate = f.main();
    const pids = join(f.root, "gate-pids.json");
    const stuck = f.submit(await hanging(f, pids));
    f.queue.wake();
    await started(pids);
    const release = f.submitRelease(candidate);
    f.queue.wake();
    await until(() => f.log.events({ operationId: release }).some((stored) => stored.event.type === "progress" && /^Verified; publishing after /.test(stored.event.line)) || undefined);
    assert.equal(f.queue.kill(release).status, "killed");
    assert.equal(f.queue.kill(stuck).status, "killed");
    await f.queue.idle();
    assert.deepEqual(f.result(release), { type: "cancelled", reason: OWNER_KILL_REASON });
    assert.equal(f.result(stuck)?.type, "cancelled");
    assert.equal(f.releaseRef(), base, "a killed release publishes nothing once the lane frees");
    for (const pid of JSON.parse(await readFile(pids, "utf8")) as number[]) try { process.kill(pid, "SIGKILL"); } catch {}
  } finally { await f.dispose(); }
}, 120_000);

test("a pause lets a verifying release publish but admits no new landing until resumed", async () => {
  const f = await fixture(false, true);
  try {
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const candidate = f.main();
    await writeFile(join(f.root, "hold-release"), "");
    const release = f.submitRelease(candidate);
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "release-started")).then(() => true, () => undefined));
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    const behind = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    assert.equal(f.log.operation(behind)!.stage, "paused");
    await rm(join(f.root, "hold-release"));
    await until(() => f.result(release));
    assert.equal(f.result(release)?.type, "released", JSON.stringify(f.result(release)));
    assert.equal(f.log.operation(behind)!.status, "queued", "the pause still holds the landing");
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "owner" });
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.result(behind)?.type, "landed", JSON.stringify(f.result(behind)));
  } finally { await f.dispose(); }
}, 120_000);

/** The log position of `id`'s first event of `type`. */
const seqOf = (f: Awaited<ReturnType<typeof fixture>>, id: string, type: string) =>
  f.log.events({ operationId: id }).find((stored) => stored.event.type === type)!.seq;

test("a release of a repository in a shared lane verifies only once the lane's running landing has finished", async () => {
  const f = await fixture(false, true, undefined, false, { other: true, lane: "shared-database" });
  try {
    const base = f.releaseRef();
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const candidate = f.main();
    const pids = join(f.root, "gate-pids.json");
    const request = await hanging(f, pids, f.otherAuthor, "fixture/other");
    const stuck = f.submit(request);
    f.queue.wake();
    await started(pids);
    const release = f.submitRelease(candidate);
    f.queue.wake();
    assert.equal(f.log.operation(release)!.waitingFor, `landing ${request.changeId.slice(0, 12)}`);
    assert.equal(f.queue.kill(stuck).status, "killed");
    await f.queue.idle();
    const outcome = f.result(release);
    assert.ok(outcome?.type === "released" && outcome.result.status === "released", JSON.stringify(outcome));
    assert.equal(f.releaseRef(), outcome.result.merge);
    assert.deepEqual(f.parents(f.releaseRef()), [base, candidate]);
    assert.ok(seqOf(f, release, "stage") > seqOf(f, stuck, "cancelled"), "the release started after the shared lane's landing ended");
  } finally { await f.dispose(); }
}, 120_000);

for (const recover of [false, true]) {
  for (const first of ["reset", "release"] as const) {
    test(`paused ${first}-first reset/release admission preserves exclusion${recover ? " after recovery" : ""}`, async () => {
      const f = await fixture(false, true, undefined, true, { workers: 2 });
      try {
        assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
        f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
        const submit = { reset: () => f.submitReset(), release: () => f.submitRelease(f.main()) };
        const second = first === "reset" ? "release" : "reset";
        const a = submit[first]();
        const b = submit[second]();
        if (recover) await f.queue.recover();
        f.queue.wake();
        assert.equal(f.log.operation(a)!.status, "queued");
        assert.equal(f.log.operation(b)!.status, "queued");
        f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "owner" });
        f.queue.wake();
        await f.queue.idle();
        assert.equal(f.result(a)?.type, first === "reset" ? "reset" : "released", JSON.stringify(f.result(a)));
        assert.equal(f.result(b)?.type, second === "reset" ? "reset" : "released", JSON.stringify(f.result(b)));
        assert.ok(seqOf(f, b, "stage") > seqOf(f, a, first === "reset" ? "reset" : "released"),
          "the second operation starts only after the first finishes, including pending lane callbacks");
      } finally { await f.dispose(); }
    }, 120_000);
  }
}

test("a release and a reset of one repository never overlap, and each says which it waits for", async () => {
  const f = await fixture(false, true, undefined, true);
  try {
    await writeFile(join(f.root, "hold-reset"), "");
    const reset = f.submitReset();
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "reset-started")).then(() => true, () => undefined));
    const release = f.submitRelease(f.main());
    f.queue.wake();
    assert.equal(f.log.operation(release)!.waitingFor, `reset ${f.log.operation(reset)!.commitId.slice(0, 12)}`);
    await rm(join(f.root, "hold-reset"));
    await f.queue.idle();
    assert.equal(f.result(reset)?.type, "reset", JSON.stringify(f.result(reset)));
    assert.equal(f.result(release)?.type, "released", JSON.stringify(f.result(release)));
    assert.ok(seqOf(f, release, "stage") > seqOf(f, reset, "reset"), "the release verified after the reset ended");

    await writeFile(join(f.root, "hold-release"), "");
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    await rm(join(f.root, "release-started"), { force: true });
    const second = f.submitRelease(f.main());
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "release-started")).then(() => true, () => undefined));
    const again = f.submitReset();
    f.queue.wake();
    assert.equal(f.log.operation(again)!.waitingFor, `release ${f.main().slice(0, 12)}`);
    await rm(join(f.root, "hold-release"));
    await f.queue.idle();
    assert.equal(f.result(second)?.type, "released", JSON.stringify(f.result(second)));
    assert.equal(f.result(again)?.type, "reset", JSON.stringify(f.result(again)));
    assert.ok(seqOf(f, again, "stage") > seqOf(f, second, "released"), "the reset ran after the release published");
  } finally { await f.dispose(); }
}, 120_000);

test("a release whose release branch moved while it verified publishes nothing", async () => {
  const f = await fixture(false, true);
  try {
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    await writeFile(join(f.root, "hold-release"), "");
    const release = f.submitRelease(f.main());
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "release-started")).then(() => true, () => undefined));
    const git = (args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "--git-dir", f.origin, ...args], { encoding: "utf8" }).trim();
    const moved = git(["commit-tree", "release^{tree}", "-p", "release", "-m", "Hotfix"]);
    git(["update-ref", "refs/heads/release", moved]);
    await rm(join(f.root, "hold-release"));
    await f.queue.idle();
    const outcome = f.result(release);
    assert.ok(outcome?.type === "failed" && /release@origin moved during the release; rerun it/.test(outcome.reason), JSON.stringify(outcome));
    assert.equal(f.releaseRef(), moved);
  } finally { await f.dispose(); }
}, 120_000);

test("gate commands get a temporary directory of their own checkout, emptied at each turn", async () => {
  const f = await fixture(false, true);
  try {
    for (const file of ["a.txt", "b.txt"]) {
      assert.equal((await f.land(f.submit(await f.candidate(file))))?.type, "landed");
      const outcome = await f.land(f.submitRelease(f.main()));
      assert.ok(outcome?.type === "released" && outcome.result.status === "released", JSON.stringify(outcome));
    }
    const turns = (await f.lines("release-tmp.jsonl")).map((line) => JSON.parse(line) as { tmp: string; stale: boolean });
    assert.equal(turns.length, 2);
    assert.equal(turns[0]!.tmp, turns[1]!.tmp);
    assert.notEqual(turns[0]!.tmp, tmpdir());
    assert.deepEqual(turns.map((turn) => turn.stale), [false, false]);
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
    const deployCommands = new Set(["app", "hq"].map((name) => ["node", "-e", deployStep(f.root, name)].join(" ")));
    const deployRequests = f.requestedTimeouts.filter((request) => deployCommands.has(request.command));
    assert.equal(deployRequests.length, 2);
    assert.deepEqual(deployRequests.map((request) => request.timeoutMs), [30_000, 30_000]);
    for (const run of first.runs) {
      assert.equal(run.timeoutMs, 30_000);
      assert.equal(run.commandEvidence?.status, "recorded");
    }
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
    assert.match(incomplete.reason, /rollback incomplete/);
    assert.match(incomplete.reason, /app.*no earlier deployment is recorded/);
    assert.match(incomplete.reason, /hq.*no earlier deployment is recorded/);
    assert.ok(incomplete.deployment);
    assert.equal(incomplete.deployment.rollback?.automatic, false);
    assert.deepEqual(incomplete.deployment.projects.map(({ name, activated }) => [name, activated]),
      [["app", true], ["hq", "unknown"], ["www", false]]);
    assert.equal(await readFile(join(f.root, "active-hq.txt"), "utf8"), url("hq", first));
    assert.deepEqual(await f.lines("active-www.txt"), [], "later unattempted project is unchanged");
    assert.deepEqual((await f.lines("rollback-authority.jsonl")).map((line) => JSON.parse(line)), [
      { project: "app", allowed: "1", restore: null }, { project: "hq", allowed: "1", restore: null },
    ], "first activation receives runner authority despite declared spoofed environment key");
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
    assert.deepEqual((await f.lines("rollback-authority.jsonl")).slice(2).map((line) => JSON.parse(line)), [
      { project: "app", allowed: "0", restore: null }, { project: "hq", allowed: "0", restore: null }, { project: "www", allowed: "0", restore: null },
    ], "non-additive promotion denies downstream compensation despite spoofed environment value");

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
      { project: "app", url: url("app", first), restore: true }, { project: "hq", url: url("hq", first), restore: true }, { project: "www", url: url("www", first), restore: true },
    ], "app and hq moved to the new deployment and back to the one they served before");
    assert.deepEqual((await f.lines("rollback-authority.jsonl")).slice(5).map((line) => JSON.parse(line)), [
      { project: "app", allowed: "1", restore: null }, { project: "hq", allowed: "1", restore: null }, { project: "www", allowed: "1", restore: null },
      { project: "app", allowed: "1", restore: "1" }, { project: "hq", allowed: "1", restore: "1" }, { project: "www", allowed: "1", restore: "1" },
    ], "ordinary activation and compensation receive runner permission, with restore separately marked");
    assert.deepEqual(moved.deployment.projects.map(({ name, activated, restored }) => [name, activated, restored ?? false]),
      [["app", false, true], ["hq", false, true], ["www", false, true]]);
    assert.equal(moved.deployment.rollback?.automatic, true);
    for (const project of ["app", "hq", "www"])
      assert.equal(await readFile(join(f.root, `active-${project}.txt`), "utf8"), url(project, first), "actual traffic pointer returned");
    assert.equal(f.releaseRef(), before);
  } finally { await f.dispose(); }
}, 300_000);

for (const scenario of ["first activation", "failed restore", "forbidden compensation", "missing activation URL", "failed pointer return"] as const) {
  test(`production recovery records traffic and release pointer evidence after ${scenario}`, async () => {
    const f = await fixture(false, true, { minIntervalMs: 0, production: true });
    const promote = async (commit: string) => {
      const release = f.submitRelease(commit);
      await f.land(release);
      await f.queue.idle();
      const outcome = f.result(release);
      assert.ok(outcome?.type === "released" && outcome.deploy, JSON.stringify(outcome));
      return f.log.operation(outcome.deploy)!;
    };
    const url = (project: string, commit: string) => `https://${project}-${commit.slice(0, 7)}.example`;
    try {
      await f.land(f.submit(await f.candidate("baseline.txt")));
      await f.queue.idle();
      const baseline = f.main();
      if (scenario !== "first activation") assert.equal((await promote(baseline)).status, "deployed");
      const before = f.releaseRef();
      await f.land(f.submit(await f.candidate("candidate.txt")));
      await f.queue.idle();
      const candidate = f.main();
      const failing = scenario === "first activation" ? "app" : "hq";
      if (scenario === "missing activation URL") await writeFile(join(f.root, "omit-url-www"), "");
      else await writeFile(join(f.root, `fail-activate-${failing}`), "");
      if (scenario === "failed pointer return") await writeFile(join(f.root, "reject-after-restore"), "");
      if (scenario === "failed restore") await writeFile(join(f.root, "fail-restore-hq"), "");
      let authorityBefore = (await f.lines("rollback-authority.jsonl")).length;
      let operation;
      let restrictedMerge: string | undefined;
      if (scenario === "forbidden compensation") {
        // Leave a failed promotion on the release pointer before testing its governed retry.
        await writeFile(join(f.root, "fail-restore-hq"), "");
        assert.equal((await promote(candidate)).status, "failed");
        await rm(join(f.root, "fail-restore-hq"));
        const retainedMerge = f.releaseRef();
        restrictedMerge = retainedMerge;
        authorityBefore = (await f.lines("rollback-authority.jsonl")).length;
        // A retry carries the original migration authority, rather than deriving a new allowance.
        const prior = newOperationId();
        f.log.append(prior, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "production", commitId: candidate, submittedBy: "promotion:test",
          promotion: { merge: retainedMerge, nonAdditiveMigrations: ["migrations/drop.sql"] } });
        f.log.append(prior, { type: "failed", stage: "deploying", reason: "earlier deployment failed" });
        operation = await promote(candidate);
      } else operation = await promote(candidate);
      const result = operation.result;
      assert.ok(result?.type === "failed" && result.deployment, JSON.stringify(result));
      const record = result.deployment;
      if (scenario === "missing activation URL" || scenario === "failed pointer return") {
        assert.equal(record.rollback?.automatic, scenario === "missing activation URL");
        assert.deepEqual(record.projects.map((project) => project.activated), [false, false, false]);
        for (const project of ["app", "hq", "www"])
          assert.equal(await readFile(join(f.root, `active-${project}.txt`), "utf8"), url(project, baseline));
        assert.deepEqual((await f.lines("rollback-authority.jsonl")).slice(authorityBefore).map((line) => JSON.parse(line)), scenario === "missing activation URL" ? [] : [
          { project: "app", allowed: "1", restore: null }, { project: "hq", allowed: "1", restore: null },
          { project: "app", allowed: "1", restore: "1" }, { project: "hq", allowed: "1", restore: "1" },
        ], "only projects whose activation ran are restored");
        if (scenario === "missing activation URL") assert.equal(f.releaseRef(), before);
        else {
          assert.notEqual(f.releaseRef(), before);
          assert.match(result.reason, /rollback incomplete/);
          assert.doesNotMatch(result.reason, /; rolled back:/);
        }
        return;
      }
      assert.equal(record.rollback?.automatic, false);
      assert.equal(record.projects.find((project) => project.name === failing)?.activated, "unknown");
      assert.match(record.projects.find((project) => project.name === failing)?.reason ?? "", /activation failed: exited 6/);
      const attempts = (await f.lines("rollback-authority.jsonl")).slice(authorityBefore).map((line) => JSON.parse(line));
      if (scenario === "first activation") {
        assert.match(record.projects[0]?.reason ?? "", /no earlier deployment is recorded/);
        assert.deepEqual(attempts, [{ project: "app", allowed: "1", restore: null }]);
        assert.deepEqual(await f.lines("active-hq.txt"), []);
        assert.deepEqual(await f.lines("active-www.txt"), []);
      } else {
        assert.equal(record.projects[0]?.activated, scenario === "failed restore" ? false : true);
        assert.equal(await readFile(join(f.root, "active-app.txt"), "utf8"), url("app", scenario === "failed restore" ? baseline : candidate));
        assert.equal(await readFile(join(f.root, "active-www.txt"), "utf8"), url("www", baseline), "later project never moved");
        if (scenario === "failed restore") {
          assert.match(record.projects[1]?.reason ?? "", /could not be moved back: exited 7: hq restore failed/);
          assert.deepEqual(attempts, [
            { project: "app", allowed: "1", restore: null }, { project: "hq", allowed: "1", restore: null },
            { project: "app", allowed: "1", restore: "1" }, { project: "hq", allowed: "1", restore: "1" },
          ]);
        } else assert.deepEqual(attempts, [
          { project: "app", allowed: "0", restore: null }, { project: "hq", allowed: "0", restore: null },
        ], "forbidden compensation makes no recovery calls");
      }
      assert.equal(await readFile(join(f.root, `active-${failing}.txt`), "utf8"), url(failing, candidate), "failure happened after traffic switched");
      if (restrictedMerge) assert.equal(f.releaseRef(), restrictedMerge, "forbidden compensation retains the exact candidate release pointer");
      assert.notEqual(f.releaseRef(), before, "unresolved traffic retains the candidate release pointer");
      assert.equal(f.parents(f.releaseRef()).at(-1), candidate);
      const persisted = f.log.deployments("fixture/repo", "production").find((entry) => entry.id === operation.id)?.result;
      assert.deepEqual(persisted, result, "unknown outcome survives the stored deployment projection");
      assert.doesNotMatch(result.reason, /; rolled back:/);
    } finally { await f.dispose(); }
  }, 180_000);
}

test("a promotion migrates production after every project is healthy and before any activates; a failed verify or apply activates nothing", async () => {
  const f = await fixture(true, true, { minIntervalMs: 0, production: "migrations" });
  const promote = async (commit: string) => {
    const promotion = f.submitRelease(commit);
    await f.land(promotion);
    await f.queue.idle();
    const outcome = f.result(promotion);
    assert.ok(outcome?.type === "released" && outcome.deploy, JSON.stringify(outcome));
    return f.log.operation(outcome.deploy)!;
  };
  const order = async () => { const steps = await f.lines("order.log"); await rm(join(f.root, "order.log"), { force: true }); return steps; };
  try {
    // Non-additive, so only a deploy that changed nothing in the schema (a refused first verify, or one that never reached the migrations) is rolled back automatically.
    await f.land(f.submit(await f.candidate("schema/drop")));
    await f.queue.idle();
    const first = f.main();
    const before = f.releaseRef();
    await writeFile(join(f.root, "fail-verify"), "");
    const refused = (await promote(first)).result;
    assert.ok(refused?.type === "failed" && refused.deployment, JSON.stringify(refused));
    assert.deepEqual(refused.deployment.migrations, { artifacts: ["migrations/0001.sql"], status: "verify_failed",
      reason: "verify exited 1: [REDACTED_URL] refused" }, "the database URL never reaches the record");
    assert.match(refused.reason, /^deploy failed: migrations \(verify exited 1: \[REDACTED_URL\] refused\); rolled back: /);
    assert.equal(f.releaseRef(), before, "nothing was applied, so the release branch returns");
    assert.deepEqual(await order(), ["health app", "health hq", "health www", "verify"], "nothing applied or activated");
    await rm(join(f.root, "fail-verify"));

    // A deploy that stopped at a health check never reached the migrations, so the schema is untouched and earlier code still fits it.
    await writeFile(join(f.root, "fail-health-hq"), "");
    const unhealthy = (await promote(first)).result;
    assert.ok(unhealthy?.type === "failed" && unhealthy.deployment, JSON.stringify(unhealthy));
    assert.equal(unhealthy.deployment.migrations, undefined);
    assert.equal(unhealthy.deployment.rollback?.automatic, true, JSON.stringify(unhealthy.deployment.rollback));
    assert.equal(f.releaseRef(), before, "nothing was applied, so the release branch returns");
    assert.ok(!(await order()).includes("verify"), "the migrations were never reached");
    await rm(join(f.root, "fail-health-hq"));

    await writeFile(join(f.root, "fail-apply"), "");
    const partial = await promote(first);
    assert.ok(partial.result?.type === "failed" && partial.result.deployment?.migrations?.status === "apply_failed", JSON.stringify(partial.result));
    assert.match(partial.result.reason, /not rolled back automatically, because applying the migrations failed and the database may be partly migrated: the owner decides$/);
    const merge = f.releaseRef();
    assert.equal(f.parents(merge).at(-1), first, "the release branch keeps the release");
    assert.deepEqual(await order(), ["health app", "health hq", "health www", "verify", "apply"]);
    await rm(join(f.root, "fail-apply"));

    // A rerun that stops before the migrations still follows an earlier deploy of the commit that part-applied them.
    await writeFile(join(f.root, "fail-health-hq"), "");
    const rerun = (await promote(first)).result;
    assert.ok(rerun?.type === "failed" && rerun.deployment, JSON.stringify(rerun));
    assert.equal(rerun.deployment.migrations, undefined);
    assert.equal(rerun.deployment.rollback?.automatic, false, JSON.stringify(rerun.deployment.rollback));
    assert.equal(f.releaseRef(), merge, "the release branch keeps the release");
    await rm(join(f.root, "fail-health-hq"));
    await order();

    const applied = await promote(first);
    assert.ok(applied.result?.type === "deployed", JSON.stringify(applied.result));
    assert.deepEqual(applied.result.record.migrations, { artifacts: ["migrations/0001.sql"], status: "applied" }, "the rerun confirm keeps the promotion's migrations");
    assert.deepEqual(await order(), ["health app", "health hq", "health www", "verify", "apply", "verify", "activate app", "activate hq", "activate www"]);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, "production-db.json"), "utf8")), ["0001.sql"]);

    await f.land(f.submit(await f.candidate("b.txt")));
    await f.queue.idle();
    const current = await promote(f.main());
    assert.ok(current.result?.type === "deployed", JSON.stringify(current.result));
    assert.deepEqual(current.result.record.migrations, { artifacts: [], status: "current" }, "a promotion without migrations still verifies production");
    assert.deepEqual((await order()).filter((step) => !step.includes(" ")), ["verify"]);

    // Applied, then an activation fails: the earlier code may not run on the migrated schema, so nothing moves back.
    await f.land(f.submit(await f.candidate("schema/more")));
    await f.queue.idle();
    const merged = f.releaseRef();
    await writeFile(join(f.root, "fail-activate-hq"), "");
    const stuck = (await promote(f.main())).result;
    assert.ok(stuck?.type === "failed" && stuck.deployment?.migrations?.status === "applied", JSON.stringify(stuck));
    assert.equal(stuck.deployment.rollback?.automatic, false);
    assert.match(stuck.reason, /not rolled back automatically, because the promotion carries non-additive migrations \(migrations\/0002\.sql\): the owner decides$/);
    assert.notEqual(f.releaseRef(), merged, "the release branch keeps the release");
    await rm(join(f.root, "fail-activate-hq"));

    // A restart cut a deploy of the commit short and left no record, so a rerun that fails before the migrations still cannot say the schema is untouched.
    await f.land(f.submit(await f.candidate("schema/third")));
    await f.queue.idle();
    const third = f.main();
    const cut = newOperationId();
    f.log.append(cut, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "production", commitId: third, submittedBy: "promotion:test" });
    f.log.append(cut, { type: "stage", stage: "deploying" });
    await f.queue.recover();
    assert.match(f.result(cut)?.type === "failed" ? (f.result(cut) as { reason: string }).reason : "", /runner restarted during deploying; deploy again with slipjay promote --confirm/);
    await writeFile(join(f.root, "fail-health-hq"), "");
    const afterRestart = (await promote(third)).result;
    assert.ok(afterRestart?.type === "failed" && afterRestart.deployment, JSON.stringify(afterRestart));
    assert.equal(afterRestart.deployment.migrations, undefined);
    assert.equal(afterRestart.deployment.rollback?.automatic, false, JSON.stringify(afterRestart.deployment.rollback));
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

test("a repository's first landing resets its target at once from the integration tip, with the declared key, keeping the output out of the log", async () => {
  const f = await fixture(false, false, undefined, true);
  try {
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const [reset] = f.log.resets("fixture/repo");
    assert.ok(reset, "the landing scheduled a reset");
    assert.deepEqual(reset.result, { type: "reset", target: "fixture-development-db", source: f.main() });
    assert.doesNotMatch(JSON.stringify(f.log.events({ operationId: reset.id })), /private-customer-record-fixture/);
    assert.match(await readFile(join(f.home, "logs", `${reset.id}.reset-output`), "utf8"), /private-customer-record-fixture/);
    assert.equal(reset.submittedBy, `${f.executor.host}:schedule`);
    assert.deepEqual(stagesOf(f, reset.id), ["fetching", "resetting"]);
    assert.deepEqual(reset.runs.map((run) => run.exitCode), [0, 0], "probe and command ran through the executor");
    assert.deepEqual((await f.lines("reset.jsonl")).map((line) => JSON.parse(line)),
      [{ target: "fixture-development-db", source: f.main(), reasonFile: true, key: "from-runner", head: f.main() }]);
    const output = join(f.home, "logs", `${reset.id}.reset-output`);
    assert.match(await readFile(output, "utf8"), /owner:from-runner@/);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(f.log.events({ operationId: reset.id })) + await f.queue.readLog(reset.id), /from-runner/);
    // The next landing falls within the interval.
    assert.equal((await f.land(f.submit(await f.candidate("b.txt"))))?.type, "landed");
    assert.equal(f.log.resets("fixture/repo").length, 1);
  } finally { await f.dispose(); }
}, 120_000);

test("a failed reset reports the step's reason line and keeps its output out of events; a probe that names another target runs nothing", async () => {
  const f = await fixture(false, false, undefined, true);
  try {
    await writeFile(join(f.root, "fail-reset"), "");
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const [failed] = f.log.resets("fixture/repo");
    const result = failed?.result;
    assert.ok(result?.type === "failed", JSON.stringify(result));
    assert.equal(result.stage, "resetting");
    assert.equal(result.reason, `Reset command failed: Scrub refused:  a real-customer tenant; its output is in ${join(f.home, "logs", `${failed!.id}.reset-output`)}`);
    assert.doesNotMatch(JSON.stringify(f.log.events({ operationId: failed!.id })), /from-runner|second-line/);
    await rm(join(f.root, "fail-reset"));
    await writeFile(join(f.root, "wrong-target"), "");
    const mismatched = await f.land(f.submitReset());
    assert.deepEqual(mismatched, { type: "failed", stage: "resetting", reason: "The reset target probe did not confirm fixture-development-db; the reset command did not run" });
    assert.equal((await f.lines("reset.jsonl")).length, 1, "only the first reset's command ran");
    await rm(join(f.root, "wrong-target"));
    assert.equal((await f.land(f.submitReset()))?.type, "reset");
    assert.equal(f.log.resets("fixture/repo").length, 3, "a failed reset is not retried on its own");
  } finally { await f.dispose(); }
}, 120_000);

test("the owner's kill stops a running reset: cancelled, never passed, and the schedule does not start it again", async () => {
  const f = await fixture(false, false, undefined, true);
  try {
    await writeFile(join(f.root, "hold-reset"), "");
    f.submit(await f.candidate("a.txt"));
    f.queue.wake();
    await until(async () => await stat(join(f.root, "reset-started")).then(() => true, () => undefined));
    assert.equal(f.queue.kill().status, "killed");
    await f.queue.idle();
    const resets = f.log.resets("fixture/repo");
    assert.equal(resets.length, 1);
    assert.deepEqual(resets[0]!.result, { type: "cancelled", reason: OWNER_KILL_REASON });
    assert.deepEqual(await f.lines("reset.jsonl"), []);
  } finally { await rm(join(f.root, "hold-reset"), { force: true }); await f.dispose(); }
}, 120_000);

test("a reset of a repository that declares none fails, and recovery fails a reset interrupted by a restart", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    assert.equal(f.log.resets("fixture/repo").length, 0, "nothing schedules a reset that is not declared");
    assert.deepEqual(await f.land(f.submitReset()), { type: "failed", stage: "fetching", reason: `${f.main().slice(0, 12)} declares no reset` });
    const interrupted = f.submitReset();
    f.log.append(interrupted, { type: "stage", stage: "resetting" });
    await f.queue.recover();
    assert.deepEqual(f.result(interrupted), { type: "failed", stage: "resetting", reason: "runner restarted during resetting; run slipjay reset again" });
  } finally { await f.dispose(); }
}, 120_000);

const exactPrefixGate = (root: string) => `const fs=require('node:fs'), path=require('node:path');
const at=(name)=>path.join(${JSON.stringify(root)},name);
if(fs.existsSync('b.txt')) {
 if(!fs.existsSync('a.txt') && !fs.existsSync(at('a-gone'))) { console.error('B did not contain its exact predecessor A'); process.exit(4); }
 fs.writeFileSync(at('b-verified'),process.cwd());
 if(fs.existsSync(at('fail-combination'))) { console.error('A+B conflict'); process.exit(5); }
} else if(fs.existsSync('a.txt')) {
 fs.writeFileSync(at('a-started'),process.cwd());
 while(fs.existsSync(at('hold-a'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
 if(fs.existsSync(at('fail-a'))) process.exit(6);
}`;

test("depth-two exact prefixes let B finish first but publish exact A then B", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  try {
    await writeFile(join(f.root, "hold-a"), "");
    const base = f.main();
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(async () => f.result(b) ?? await readFile(join(f.root, "b-verified"), "utf8").catch(() => undefined));
    assert.equal(f.result(b), undefined, JSON.stringify(f.result(b)));
    await until(() => f.log.operation(b)?.stage === "waiting-for-predecessor" || undefined);
    assert.equal(f.main(), base, "B does not occupy the canonical publisher while A verifies");
    const prepared = (id: string) => f.log.events({ operationId: id }).map((row) => row.event).find((event) => event.type === "attempt_prepared");
    const pa = prepared(a), pb = prepared(b);
    assert.ok(pa?.type === "attempt_prepared" && pb?.type === "attempt_prepared");
    assert.equal(pa.base, base); assert.equal(pb.base, pa.candidate);
    assert.deepEqual(pb.predecessor, { operationId: a, attempt: 1, candidate: pa.candidate });
    await rm(join(f.root, "hold-a"));
    await f.queue.idle();
    assert.equal(f.result(a)?.type, "landed", JSON.stringify(f.result(a)));
    assert.equal(f.result(b)?.type, "landed", JSON.stringify(f.result(b)));
    assert.equal(f.main(), pb.candidate);
    assert.deepEqual(f.parents(pb.candidate), [pa.candidate]);
    assert.deepEqual(f.published.filter((row) => row.event.type === "landed").map((row) => row.operationId), [a, b]);
    assert.notEqual(pa.checkout, pb.checkout, "verifiers use independent repositories");
    assert.equal(f.remoteFile("a.txt"), "a.txt");
    assert.equal(f.remoteFile("b.txt"), "b.txt");
  } finally { await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);

test("depth-two exact prefix catches a combination failure before B publication", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  try {
    await writeFile(join(f.root, "hold-a"), "");
    await writeFile(join(f.root, "fail-combination"), "");
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(() => f.result(b));
    assert.equal(f.result(b)?.type, "failed", JSON.stringify(f.result(b)));
    assert.match(JSON.stringify(f.result(b)), /A\+B conflict/);
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    const landed = f.result(a);
    assert.ok(landed?.type === "landed");
    assert.equal(f.main(), landed.commitId);
    assert.ok(f.log.events({ operationId: b }).some((row) => row.event.type === "attempt_invalidated"));
  } finally { await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);

for (const outcome of ["failure", "kill", "hold", "remote-move"] as const) test(`depth-two exact prefix invalidates B after predecessor ${outcome} and rebuilds it once on what A left`, async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  try {
    const base = f.main();
    await writeFile(join(f.root, "hold-a"), "");
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(() => f.log.operation(b)?.stage === "waiting-for-predecessor" || f.result(b) || undefined);
    assert.equal(f.result(b), undefined, JSON.stringify(f.result(b)));
    if (outcome === "failure") await writeFile(join(f.root, "fail-a"), "");
    if (outcome === "hold") await writeFile(join(f.root, "reject-push"), "");
    if (outcome === "remote-move") {
      // Another valid writer advanced the remote after the prefix was frozen.
      const commit = execFileSync("git", ["--git-dir", f.origin, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "external move"],
        { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "f@example.com", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "f@example.com" } }).trim();
      execFileSync("git", ["--git-dir", f.origin, "update-ref", "refs/heads/main", commit, base]);
    }
    if (outcome === "kill") assert.equal(f.queue.kill(a).status, "killed");
    // Without A, B's rebuild verifies B alone.
    if (outcome !== "remote-move") await writeFile(join(f.root, "a-gone"), "");
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    assert.equal(f.result(a)?.type, outcome === "kill" ? "cancelled" : outcome === "remote-move" ? "landed" : "failed", JSON.stringify(f.result(a)));
    const prepared = (id: string) => f.log.events({ operationId: id }).map((row) => row.event).filter((event) => event.type === "attempt_prepared");
    assert.ok(f.log.events({ operationId: b }).some((row) => row.event.type === "attempt_invalidated"));
    assert.deepEqual(prepared(b).map((event) => event.attempt), [1, 2], "B's stale evidence is never reused: one fresh attempt");
    if (outcome === "hold") {
      // A held integration is finished first; while it cannot publish, nothing after it does.
      assert.equal(f.result(b)?.type, "failed", JSON.stringify(f.result(b)));
      assert.equal(f.log.snapshot(f.executor.host).held.length, 1);
      assert.equal(f.main(), base);
    } else {
      const landed = f.result(b);
      assert.ok(landed?.type === "landed", JSON.stringify(landed));
      assert.equal(f.main(), landed.commitId);
      assert.equal(landed.base, outcome === "remote-move" ? (f.result(a) as { commitId: string }).commitId : base, "B rebuilt on what A's outcome left");
      assert.equal(prepared(b)[1]!.base, landed.base);
    }
    if (outcome === "remote-move") assert.equal(prepared(a).length, 2, "one immutable automatic rebuild");
    // Every prepared candidate remains retained in the verifier after terminal outcome.
    for (const id of [a, b]) {
      const prepared = f.log.events({ operationId: id }).map((row) => row.event).find((event) => event.type === "attempt_prepared");
      assert.ok(prepared?.type === "attempt_prepared");
      assert.equal(jj(prepared.checkout, ["log", "-r", prepared.candidate, "--no-graph", "-T", "commit_id"]), prepared.candidate);
    }
  } finally { await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);

/** Hold A's rebuild after a remote move, so B waits on A's outcome while A verifies again. */
async function dependentWaitingOnRebuild(f: Awaited<ReturnType<typeof fixture>>) {
  const base = f.main();
  await writeFile(join(f.root, "hold-a"), "");
  await writeFile(join(f.root, "a-gone"), "");
  const a = f.submit(await f.candidate("a.txt"));
  const b = f.submit(await f.candidate("b.txt"));
  const unsubscribe = f.log.subscribe((row) => {
    // A's first attempt is invalidated by the move: hold its rebuild before it reaches its gate.
    if (row.operationId === a && row.event.type === "attempt_invalidated" && row.event.attempt === 1) writeFileSync(join(f.root, "hold-a"), "");
  });
  f.queue.wake();
  await until(() => f.log.operation(b)?.stage === "waiting-for-predecessor" || f.result(b) || undefined);
  const commit = execFileSync("git", ["--git-dir", f.origin, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "external move"],
    { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "f@example.com", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "f@example.com" } }).trim();
  execFileSync("git", ["--git-dir", f.origin, "update-ref", "refs/heads/main", commit, base]);
  await rm(join(f.root, "hold-a"));
  await until(() => f.log.events({ operationId: a }).some((row) => row.event.type === "attempt_started" && row.event.attempt === 2) || undefined);
  await until(() => f.log.events({ operationId: b }).some((row) => row.event.type === "attempt_invalidated") || undefined);
  return { a, b, unsubscribe };
}

test("depth-two dependent waiting on its predecessor's rebuild can be killed, and is not rebuilt", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  let unsubscribe = () => {};
  try {
    const waiting = await dependentWaitingOnRebuild(f);
    unsubscribe = waiting.unsubscribe;
    assert.equal(f.queue.kill(waiting.b).status, "killed", "the waiting dependent is still the owner's to stop");
    await until(() => f.result(waiting.b));
    assert.deepEqual(f.result(waiting.b), { type: "cancelled", reason: OWNER_KILL_REASON });
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    assert.equal(f.result(waiting.a)?.type, "landed", JSON.stringify(f.result(waiting.a)));
    assert.equal(f.log.events({ operationId: waiting.b }).filter((row) => row.event.type === "attempt_prepared").length, 1, "a killed dependent never rebuilds");
  } finally { unsubscribe(); await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);

test("depth-two dependent waiting on its predecessor's rebuild does not rebuild once the runner is paused", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  let unsubscribe = () => {};
  try {
    const waiting = await dependentWaitingOnRebuild(f);
    unsubscribe = waiting.unsubscribe;
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "fixture-owner" });
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    assert.equal(f.result(waiting.a)?.type, "landed", JSON.stringify(f.result(waiting.a)));
    const outcome = f.result(waiting.b);
    assert.ok(outcome?.type === "failed" && /predecessor invalidated/.test(outcome.reason), JSON.stringify(outcome));
    assert.equal(f.log.events({ operationId: waiting.b }).filter((row) => row.event.type === "attempt_prepared").length, 1, "a pause stops the rebuild");
  } finally { unsubscribe(); await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);

test("depth-two dependent rebuilt behind a held predecessor lands on it once the hold publishes", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  let unsubscribe = () => {};
  try {
    await writeFile(join(f.root, "hold-a"), "");
    // B's rebuild first verifies on the remote tip, before the held A publishes under it.
    await writeFile(join(f.root, "a-gone"), "");
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    // The outage ends as soon as A is held: B's rebuild then finishes A first, and lands after it.
    unsubscribe = f.log.subscribe((row) => { if (row.operationId === a && row.event.type === "failed") rmSync(join(f.root, "reject-push"), { force: true }); });
    f.queue.wake();
    await until(() => f.log.operation(b)?.stage === "waiting-for-predecessor" || f.result(b) || undefined);
    await writeFile(join(f.root, "reject-push"), "");
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    assert.equal(f.result(a)?.type, "failed", JSON.stringify(f.result(a)));
    const landed = f.result(b);
    assert.ok(landed?.type === "landed", JSON.stringify(landed));
    assert.equal(f.main(), landed.commitId);
    assert.equal(f.remoteFile("a.txt"), "a.txt", "the held predecessor published first");
    assert.deepEqual(f.log.snapshot(f.executor.host).held, []);
  } finally { unsubscribe(); await rm(join(f.root, "hold-a"), { force: true }); await rm(join(f.root, "reject-push"), { force: true }); await f.dispose(); }
}, 120_000);

test("depth-two restores a migration candidate's generated state in its verifier when the gate fails", async () => {
  const f = await fixture(true, false, undefined, false, { verificationDepth: 2 });
  try {
    const base = f.main();
    // One migration-bearing candidate whose gate fails after generation.
    await f.candidate("schema/a.ts");
    await writeFile(join(f.author, "fail"), "");
    const a = f.submit(await f.push(f.author));
    await f.land(a);
    assert.equal(f.result(a)?.type, "failed", JSON.stringify(f.result(a)));
    assert.equal(f.main(), base);
    const prepared = f.log.events({ operationId: a }).map((row) => row.event).find((event) => event.type === "attempt_prepared");
    assert.ok(prepared?.type === "attempt_prepared");
    // As at depth one: the verifier's candidate change is restored to its submitted tree, not left generated.
    assert.match(jj(prepared.checkout, ["op", "log", "--no-graph", "-T", 'description ++ "\\n"']), /restore/);
  } finally { await f.dispose(); }
}, 120_000);

test("depth-two migration finalization is a barrier and a hold invalidates its waiting dependent", async () => {
  const f = await fixture(true, false, undefined, false, { verificationDepth: 2 });
  try {
    await writeFile(join(f.root, "hold-finalize"), "");
    await writeFile(join(f.root, "fail-finalize"), "");
    const a = f.submit(await f.candidate("schema/a.ts"));
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(() => f.log.operation(a)?.stage === "finalizing" || f.result(a) || undefined);
    assert.equal(f.result(a), undefined, JSON.stringify(f.result(a)));
    assert.ok(!f.log.events({ operationId: b }).some((row) => row.event.type === "attempt_prepared" || row.event.type === "verification_passed"));
    await rm(join(f.root, "hold-finalize")); await f.queue.idle();
    assert.equal(f.result(a)?.type, "failed", JSON.stringify(f.result(a)));
    assert.equal(f.result(b)?.type, "failed", JSON.stringify(f.result(b)));
    assert.equal(f.log.snapshot(f.executor.host).held.length, 1);
    assert.ok(!f.log.events({ operationId: b }).some((row) => row.event.type === "integrated"));
  } finally { await rm(join(f.root, "hold-finalize"), { force: true }); await f.dispose(); }
}, 120_000);

test("depth-two waiting dependent can be killed without waiting for or killing its predecessor", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  try {
    await writeFile(join(f.root, "hold-a"), "");
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(() => f.log.operation(b)?.stage === "waiting-for-predecessor" || f.result(b) || undefined);
    assert.equal(f.result(b), undefined, JSON.stringify(f.result(b)));
    assert.equal(f.queue.kill(b).status, "killed");
    await until(() => f.result(b));
    assert.equal(f.result(b)?.type, "cancelled");
    assert.equal(f.result(a), undefined);
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    assert.equal(f.result(a)?.type, "landed", JSON.stringify(f.result(a)));
  } finally { await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);

test("depth-two paused queue does not rebuild a stale head or admit another operation", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  try {
    const base = f.main();
    await writeFile(join(f.root, "hold-a"), "");
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    const c = f.submit(await f.candidate("c.txt"));
    f.queue.wake();
    await until(() => f.log.operation(b)?.stage === "waiting-for-predecessor" || f.result(b) || undefined);
    assert.equal(f.result(b), undefined, JSON.stringify(f.result(b)));
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "fixture-owner" });
    const moved = execFileSync("git", ["--git-dir", f.origin, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "external move"],
      { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "f@example.com", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "f@example.com" } }).trim();
    execFileSync("git", ["--git-dir", f.origin, "update-ref", "refs/heads/main", moved, base]);
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    assert.equal(f.result(a)?.type, "failed", JSON.stringify(f.result(a)));
    assert.equal(f.result(b)?.type, "failed");
    assert.equal(f.log.operation(c)?.status, "queued");
    assert.equal(f.log.events({ operationId: a }).filter((row) => row.event.type === "attempt_prepared").length, 1);
    assert.ok(f.log.paused());
    assert.equal(f.main(), moved);
  } finally { await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);

test("depth-two publication refuses an author rewrite after preparation", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  try {
    const base = f.main();
    await writeFile(join(f.root, "hold-a"), "");
    const original = await f.candidate("a.txt");
    const a = f.submit(original);
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(() => f.log.operation(b)?.stage === "waiting-for-predecessor" || f.result(b) || undefined);
    assert.equal(f.result(b), undefined, JSON.stringify(f.result(b)));
    jj(f.author, ["edit", original.commitId]);
    await writeFile(join(f.author, "rewritten.txt"), "changed after preparation\n");
    await f.push();
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    assert.equal(f.result(a)?.type, "failed", JSON.stringify(f.result(a)));
    assert.match(JSON.stringify(f.result(a)), /Submitted source changed/);
    assert.equal(f.result(b)?.type, "failed");
    assert.equal(f.main(), base);
    assert.equal(f.log.events({ operationId: a }).filter((row) => row.event.type === "attempt_prepared").length, 1);
  } finally { await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);

test("depth-two restart uses exact publication intent when integration was not yet recorded", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2 });
  try {
    const request = await f.candidate("a.txt");
    const first = f.submit(request);
    const result = await f.land(first);
    assert.ok(result?.type === "landed", JSON.stringify(result));
    const interrupted = f.submit(request);
    f.log.append(interrupted, { type: "stage", stage: "integrating" });
    f.log.append(interrupted, { type: "publication_intent", attempt: 1, base: result.base, candidate: result.commitId });
    await f.queue.recover();
    assert.equal(f.result(interrupted)?.type, "landed", JSON.stringify(f.result(interrupted)));
    assert.deepEqual(f.log.events({ operationId: interrupted }).filter((row) => row.event.type === "integrated").map((row) => row.event),
      [{ type: "integrated", base: result.base, commitId: result.commitId }]);
    assert.equal(f.main(), result.commitId);
  } finally { await f.dispose(); }
}, 120_000);


test("depth-two queued reset fences later landing admission and uses the preceding published source", async () => {
  const f = await fixture(false, false, undefined, true, { verificationDepth: 2, prefixGate: exactPrefixGate });
  try {
    await writeFile(join(f.root, "hold-a"), "");
    await writeFile(join(f.root, "hold-reset"), "");
    const a = f.submit(await f.candidate("a.txt"));
    const reset = f.submitReset();
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(async () => await stat(join(f.root, "a-started")).then(() => true, () => undefined));
    assert.equal(f.log.operation(reset)?.status, "queued");
    assert.equal(f.log.operation(b)?.status, "queued");
    await rm(join(f.root, "hold-a"));
    await until(async () => await stat(join(f.root, "reset-started")).then(() => true, () => undefined));
    const landed = f.result(a);
    assert.ok(landed?.type === "landed", JSON.stringify(landed));
    assert.equal(f.log.operation(b)?.status, "queued");
    assert.ok(!f.log.events({ operationId: b }).some((row) => row.event.type === "attempt_started"));
    await rm(join(f.root, "hold-reset")); await f.queue.idle();
    assert.equal(f.result(reset)?.type, "reset", JSON.stringify(f.result(reset)));
    assert.equal(f.result(b)?.type, "landed", JSON.stringify(f.result(b)));
    assert.equal(JSON.parse((await f.lines("reset.jsonl"))[0]!).source, landed.commitId);
    assert.ok(seqOf(f, b, "stage") > seqOf(f, reset, "reset"));
  } finally {
    await rm(join(f.root, "hold-a"), { force: true });
    await rm(join(f.root, "hold-reset"), { force: true });
    await f.dispose();
  }
}, 120_000);

test("depth-two second remote move exhausts the one-rebuild bound and retains both attempts", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  let unsubscribe = () => {};
  try {
    const moved: string[] = [];
    unsubscribe = f.log.subscribe((row) => {
      if (row.event.type !== "verification_passed") return;
      const base = f.main();
      const commit = execFileSync("git", ["--git-dir", f.origin, "commit-tree", `${base}^{tree}`, "-p", base, "-m", `external move ${moved.length + 1}`],
        { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "f@example.com", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "f@example.com" } }).trim();
      execFileSync("git", ["--git-dir", f.origin, "update-ref", "refs/heads/main", commit, base]);
      moved.push(commit);
    });
    const request = await f.candidate("a.txt");
    const a = f.submit(request);
    await f.land(a);
    assert.equal(f.result(a)?.type, "failed", JSON.stringify(f.result(a)));
    assert.match(JSON.stringify(f.result(a)), /Remote integration changed/);
    assert.equal(moved.length, 2);
    assert.equal(f.main(), moved[1]);
    const events = f.log.events({ operationId: a }).map((row) => row.event);
    const prepared = events.filter((event) => event.type === "attempt_prepared");
    assert.deepEqual(prepared.map((event) => event.attempt), [1, 2]);
    assert.equal(events.filter((event) => event.type === "attempt_invalidated").length, 2);
    assert.ok(!events.some((event) => event.type === "integrated"));
    for (const event of prepared) {
      assert.equal(event.source, request.commitId);
      assert.equal(jj(event.checkout, ["log", "-r", event.candidate, "--no-graph", "-T", "commit_id"]), event.candidate);
    }
    await f.queue.recover(); await f.queue.recover();
    assert.deepEqual(f.result(a)?.type, "failed");
    assert.equal(f.log.events({ operationId: a }).filter((row) => row.event.type === "failed").length, 1);
  } finally { unsubscribe(); await f.dispose(); }
}, 120_000);

test("depth-two executor loss invalidates dependent evidence and releases verifier ownership", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  const run = f.executor.run;
  try {
    await writeFile(join(f.root, "hold-a"), "");
    await writeFile(join(f.root, "a-gone"), "");
    const original = await f.candidate("a.txt");
    const a = f.submit(original);
    const b = f.submit(await f.candidate("b.txt"));
    f.executor.run = async (request) => {
      if (request.args.includes(exactPrefixGate(f.root)) && await stat(join(request.cwd, "a.txt")).then(() => true, () => false)
        && !await stat(join(request.cwd, "b.txt")).then(() => true, () => false)) {
        await until(() => f.log.operation(b)?.stage === "waiting-for-predecessor" || f.result(b) || undefined);
        throw new Error("fixture executor connection lost");
      }
      return run(request);
    };
    await f.land(a);
    assert.equal(f.result(a)?.type, "failed", JSON.stringify(f.result(a)));
    assert.match(JSON.stringify(f.result(a)), /executor connection lost/);
    // B's combined evidence is invalidated; it rebuilds alone on the unchanged base and lands.
    await until(() => f.result(b));
    assert.equal(f.result(b)?.type, "landed", JSON.stringify(f.result(b)));
    assert.ok(f.log.events({ operationId: b }).some((row) => row.event.type === "attempt_invalidated" && /predecessor/i.test(row.event.reason)));
    assert.ok(!f.log.events({ operationId: a }).some((row) => row.event.type === "integrated"));
    assert.equal(f.log.operation(a)!.runs.length, 1);
    assert.equal(f.log.operation(a)!.runs[0]!.exitCode, null);
    const artifacts = [a, b].flatMap((id) => f.log.events({ operationId: id }).map((row) => row.event).filter((event) => event.type === "attempt_prepared"));
    assert.equal(artifacts.length, 3, "A's attempt, B's invalidated attempt and B's rebuild");
    f.executor.run = run;
    await rm(join(f.root, "hold-a"));
    const next = f.submit(await f.candidate("next.txt"));
    assert.equal((await f.land(next))?.type, "landed", JSON.stringify(f.result(next)));
    for (const event of artifacts)
      assert.equal(jj(event.checkout, ["log", "-r", event.candidate, "--no-graph", "-T", "commit_id"]), event.candidate);
    await f.queue.recover(); await f.queue.recover();
    assert.equal(f.log.events({ operationId: a }).filter((row) => row.event.type === "failed").length, 1);
    assert.deepEqual(f.log.events({ operationId: b }).filter((row) => row.event.type === "failed" || row.event.type === "landed").map((row) => row.event.type), ["landed"]);
  } finally { f.executor.run = run; await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);


test("depth-two actual runner process loss retains durable attempts and recovers each outcome once", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate, durable: true });
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  let stderr = "";
  try {
    const base = f.main();
    const original = await f.candidate("a.txt");
    const a = f.submit(original);
    const b = f.submit(await f.candidate("b.txt"));
    const driver = `
      import { createRunnerQueue, localExecutor } from ${JSON.stringify(new URL("../src/lib/runner-queue.ts", import.meta.url).href)};
      import { openOperationLog } from ${JSON.stringify(new URL("../src/lib/runner-log.ts", import.meta.url).href)};
      import { existsSync } from 'node:fs'; import { join } from 'node:path';
      const local = localExecutor({ slice: ${JSON.stringify(TEST_SLICE)} });
      const executor = { host: local.host, combinedLimits: true, run: (request) => {
        // The worker loses its process while awaiting its external executor: no child gate is orphaned by this fixture.
        if (existsSync(join(request.cwd, 'a.txt')) && !existsSync(join(request.cwd, 'b.txt')))
          return new Promise(() => {});
        return local.run(request);
      }};
      const log = openOperationLog(${JSON.stringify(f.logPath)});
      const queue = createRunnerQueue({log, executor, home:${JSON.stringify(f.home)}, config:{repos:{'Fixture/Repo':{url:${JSON.stringify(f.origin)},verificationDepth:2}},jj:{'user.name':'Runner Identity','user.email':'runner@example.com'}}});
      queue.wake(); setInterval(()=>{},1000);
    `;
    child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", driver], { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr!.on("data", (data) => { stderr += data.toString(); });
    exited = new Promise((resolve) => child!.once("exit", resolve));
    await until(() => {
      assert.equal(child!.exitCode, null, stderr);
      return f.log.operation(b)?.stage === "waiting-for-predecessor" || undefined;
    });
    const artifacts = [a, b].flatMap((id) => f.log.events({ operationId: id }).map((row) => row.event).filter((event) => event.type === "attempt_prepared"));
    assert.equal(artifacts.length, 2);
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "fixture-owner" });
    child.kill("SIGKILL"); await exited;
    await f.queue.recover(); await f.queue.recover();
    assert.equal(f.main(), base);
    assert.ok(f.log.paused());
    for (const id of [a, b]) {
      assert.equal(f.result(id)?.type, "failed", JSON.stringify(f.result(id)));
      assert.match(JSON.stringify(f.result(id)), /runner restarted/);
      assert.equal(f.log.events({ operationId: id }).filter((row) => row.event.type === "failed").length, 1);
      assert.ok(!f.log.events({ operationId: id }).some((row) => row.event.type === "integrated"));
    }
    const retry = f.submit(original);
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.log.operation(retry)?.status, "queued");
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "fixture-owner" });
    assert.equal((await f.land(retry))?.type, "landed", JSON.stringify(f.result(retry)));
    assert.equal(f.log.operation(retry)!.commitId, original.commitId);
    assert.equal(f.log.events().filter((row) => row.event.type === "integrated").length, 1);
    for (const event of artifacts)
      assert.equal(jj(event.checkout, ["log", "-r", event.candidate, "--no-graph", "-T", "commit_id"]), event.candidate);
  } finally { child?.kill("SIGKILL"); await exited; await f.dispose(); }
}, 120_000);


test("recovery finds a retained submission's integration under its duplicate's change ID before it was recorded", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.land(f.submit(await f.candidate("first.txt"))))?.type, "landed");
    const request = await f.candidate("retained.txt");
    const id = f.submit(request);
    const retained = await retainSubmissionSource({ home: f.home, operationId: id, request, url: f.origin, executor: f.executor });
    f.log.append(id, retained);
    // The runner verified a duplicate of the source, moved the integration bookmark to it, and stopped before recording that.
    const checkout = join(f.home, "repos", "fixture/repo");
    await importSubmissionSource(f.home, request.repo, id, retained, checkout);
    jj(checkout, ["duplicate", request.commitId, "--onto", "main@origin"]);
    const duplicate = jj(checkout, ["log", "-r", `heads(main@origin+ ~ ${request.commitId}) & description(substring:"retained.txt")`, "--no-graph", "-T", "commit_id"]);
    assert.match(duplicate, /^[a-f0-9]{40}$/);
    jj(checkout, ["bookmark", "set", "main", "-r", duplicate]);
    f.log.append(id, { type: "stage", stage: "verifying" });
    f.log.append(id, { type: "verification_passed", base: f.main(), candidate: duplicate });
    f.log.append(id, { type: "stage", stage: "integrating" });
    await f.queue.recover();
    const events = f.log.events({ operationId: id }).map((row) => row.event);
    assert.ok(events.some((event) => event.type === "integrated" && event.commitId === duplicate), "the unrecorded integration is recognised, not dropped");
    assert.ok(f.log.snapshot(f.executor.host).held.some((entry) => entry.commitId === duplicate));
  } finally { await f.dispose(); }
}, 120_000);

for (const verificationDepth of [1, 2] as const) {
  test(`retained merge source preserves ancestry through depth-${verificationDepth} preparation and publication`, async () => {
    const f = await fixture(false, false, undefined, false, { verificationDepth });
    try {
      const initial = f.main();
      jj(f.author, ["new", initial, "-m", "Upstream one"]);
      await writeFile(join(f.author, "upstream-one.txt"), "one\n");
      jj(f.author, ["new", "-m", "Upstream two"]);
      await writeFile(join(f.author, "upstream-two.txt"), "two\n");
      const upstream = jj(f.author, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
      jj(f.author, ["new", initial, "-m", "Feature title"]);
      await writeFile(join(f.author, "feature.txt"), "feature\n");
      const feature = jj(f.author, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
      jj(f.author, ["new", feature, upstream, "-m", "Merge upstream"]);
      jj(f.author, ["new", "-m", "Review fix"]);
      await writeFile(join(f.author, "fix.txt"), "fix\n");
      const request = await f.push();
      assert.equal((await f.land(f.submit(await f.candidate("meanwhile.txt"))))?.type, "landed");
      const base = f.main();
      const id = f.submit(request);
      const retained = await retainSubmissionSource({ home: f.home, operationId: id, request, url: f.origin, executor: f.executor });
      f.log.append(id, retained);
      const result = await f.land(id);
      assert.ok(result?.type === "landed", JSON.stringify(result));
      assert.equal(result.base, base);
      assert.equal(f.main(), result.commitId);
      assert.deepEqual(f.parents(result.commitId), [base, upstream], "one assembled feature merge keeps the original upstream parent");
      const git = (...args: string[]) => execFileSync("git", ["--git-dir", f.origin, ...args], { encoding: "utf8" }).trim();
      assert.equal(git("diff", "--name-only", request.commitId, result.commitId), "meanwhile.txt",
        "the full submitted tree is preserved alongside the newer integration change");
      assert.equal(git("log", "-1", "--format=%s", result.commitId), "Feature title");
      assert.deepEqual(git("log", `${base}..${result.commitId}`, "--format=%s").split("\n").sort(),
        ["Feature title", "Upstream one", "Upstream two"], "merged-in commits keep their identity instead of being copied or flattened");
      for (const [file, content] of [["feature.txt", "feature"], ["fix.txt", "fix"], ["upstream-one.txt", "one"], ["upstream-two.txt", "two"], ["meanwhile.txt", "meanwhile.txt"]])
        assert.equal(f.remoteFile(file!), content);
      const passed = f.log.events({ operationId: id }).map(({ event }) => event).find((event) => event.type === "verification_passed");
      assert.ok(passed?.type === "verification_passed" && passed.base === base && passed.candidate === result.commitId);
      assert.equal(f.log.operation(id)!.commitId, request.commitId, "submission identity remains the immutable original");
      const checkout = join(f.home, verificationDepth === 2 ? "verifiers" : "repos", "fixture/repo", ...verificationDepth === 2 ? ["0"] : []);
      assert.equal(jj(checkout, ["log", "-r", request.commitId, "--no-graph", "-T", "commit_id"]), request.commitId);
      f.queue.wake(); await f.queue.idle();
      assert.equal(f.main(), result.commitId, "completed merge publication is not repeated");
    } finally { await f.dispose(); }
  }, 120_000);
}

test("queued retained source lands after author and upstream candidate loss with a cold runner checkout", async () => {
  for (const verificationDepth of [1, 2] as const) {
    const f = await fixture(false, false, undefined, false, { verificationDepth });
    try {
      const request = await f.candidate("retained-candidate.txt");
      const id = f.submit(request);
      const retained = await retainSubmissionSource({ home: f.home, operationId: id, request, url: f.origin, executor: f.executor });
      f.log.append(id, retained);
      execFileSync("git", ["--git-dir", f.origin, "update-ref", "-d", `refs/heads/${request.bookmark}`]);
      execFileSync("git", ["--git-dir", f.origin, "gc", "--prune=now"]);
      await rm(f.author, { recursive: true, force: true });
      const result = await f.land(id);
      assert.equal(result?.type, "landed", JSON.stringify(result));
      assert.equal(f.remoteFile("retained-candidate.txt"), "retained-candidate.txt");
      const before = f.main();
      f.queue.wake(); await f.queue.idle();
      assert.equal(f.main(), before, "following/restarting a completed attempt cannot publish it twice");
    } finally { await f.dispose(); }
  }
}, 120_000);
