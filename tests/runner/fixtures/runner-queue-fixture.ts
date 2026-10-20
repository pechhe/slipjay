import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test as serialTest } from "vite-plus/test";
import { candidateBookmark, TERMINAL_EVENT_TYPES } from "../../../src/lib/runner/runner-contract.ts";
import type { Executor, RunnerConfig, StoredEvent, SubmitRequest } from "../../../src/lib/runner/runner-contract.ts";
import { newOperationId, openOperationLog } from "../../../src/lib/runner/runner-log.ts";
import { createRunnerQueue, runnerLogOptions } from "../../../src/lib/runner/runner-queue.ts";
import { runBoundedProcess } from "../../../src/lib/infra/bounded-process.ts";
import { directExecutor, testExecutor } from "../../support/executor.ts";

// Shells are forbidden by the landing policy; preserve the requested gate's behaviour.
// A committed `hang` file names where to record the pids of the gate, of a child in its
// process group, of a tool it starts in its own group (as YardSmith's task runners
// do) and, under systemd, of a tool in a scope of its own that joins the run's slice
// (as YardSmith's heavy-check wrapper does); then it never ends.
export const gateFailureOutput = "boom\nFAIL tests/fixture.test.ts > fixture > rejects the candidate\n";
export const gate = `const fs=require("node:fs");if (fs.existsSync("fail")) { process.stderr.write(${JSON.stringify(gateFailureOutput)}); process.exit(3); }`
  + 'if (fs.existsSync("hang")) { const spawn=(detached)=>require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached,stdio:"ignore"});'
  + 'const child=spawn(false), tool=spawn(true), slice=process.env.SLIPJAY_SYSTEMD_SLICE;'
  + 'const scoped=slice?require("node:child_process").spawn("systemd-run",["--user","--scope","--quiet","--collect","--slice="+slice,"--",process.execPath,"-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"}):null;'
  + 'const record=()=>fs.writeFileSync(fs.readFileSync("hang","utf8").trim(),JSON.stringify([process.pid,child.pid,tool.pid,...scoped?[scoped.pid]:[]]));'
  + 'setTimeout(record,scoped?500:0); setInterval(()=>{},1000); }';
export const command = `node -e ${gate}`;
// Late-bound migrations: each generation writes the next numbered file; finalization
// records which migrations the integrated commit carries, unless `fail-finalize` exists;
// it waits while `hold-finalize` exists. A committed `schema/drop` makes generated migrations non-additive.
export const generate = 'const fs=require("node:fs");fs.mkdirSync("migrations",{recursive:true});const n=fs.readdirSync("migrations").length+1;fs.writeFileSync("migrations/"+String(n).padStart(4,"0")+".sql",(fs.existsSync("schema/drop")?"drop table t;\\n":"")+"-- "+n+"\\n");';
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
export const deployStep = (root: string, name: string) => `const fs=require("node:fs");
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
export const test = serialTest.concurrent;
export const jj = (cwd: string, args: string[]) => execFileSync("jj", ["--color=never", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();

// `other` adds a second repository, Fixture/Other, with the same policy: its own origin, author and warm checkout.
// `extra` adds more such repositories by name, each with an author in `authors`.
/** Projects deploy and check side by side, so their log lines arrive in any order. */
export const byProject = (entries: { project: string }[]) => entries.sort((a, b) => a.project.localeCompare(b.project));

export async function fixture(migrations = false, release = false, deployments?: { minIntervalMs: number; production?: boolean | "migrations" }, reset = false,
  { workers, other = false, extra = [], lane, branch = "main", verificationDepth, prefixGate, durable = false, combinedLimits = true, recoveryRetryMs, scopes = false }: { recoveryRetryMs?: number; workers?: number; other?: boolean; extra?: string[]; lane?: string; branch?: string; verificationDepth?: 1 | 2; prefixGate?: (root: string) => string; durable?: boolean; combinedLimits?: boolean; scopes?: boolean } = {}) {
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
  async function seedRepository(name: string, repositoryOrigin: string, repositoryAuthor: string) {
    const repositorySeed = join(root, `${name}-seed`);
    await mkdir(repositorySeed);
    git(["init", "--bare", "-b", "main", repositoryOrigin]);
    jj(repositorySeed, ["git", "init"]);
    await writeFile(join(repositorySeed, "slipjay.json"), await readFile(join(seed, "slipjay.json"), "utf8"));
    jj(repositorySeed, ["describe", "-m", "Seed policy"]);
    jj(repositorySeed, ["git", "remote", "add", "origin", repositoryOrigin]);
    jj(repositorySeed, ["git", "push", "--remote", "origin", "--named", "main=@"]);
    jj(root, ["git", "clone", repositoryOrigin, repositoryAuthor]);
  }
  if (other) await seedRepository("other", otherOrigin, otherAuthor);
  const authors: Record<string, string> = {};
  const extraRepos: RunnerConfig["repos"] = {};
  for (const [index, name] of extra.entries()) {
    authors[name] = join(root, `extra-${index}-author`);
    extraRepos[name] = { url: join(root, `extra-${index}.git`), ...lane ? { lane } : {} };
    await seedRepository(`extra-${index}`, extraRepos[name].url, authors[name]);
  }
  // While `reject-push` exists the remote refuses every push, as an outage would.
  await writeFile(join(origin, "hooks", "pre-receive"), `#!/bin/sh\nif [ -e ${JSON.stringify(join(root, "reject-push"))} ]; then echo "remote unavailable" >&2; exit 1; fi\n`);
  await chmod(join(origin, "hooks", "pre-receive"), 0o755);
  const logPath = durable ? join(root, "events.sqlite") : ":memory:";
  const published: StoredEvent[] = [];
  // Whether each landing's candidate bookmark was still on origin when its verdict was published.
  const candidateAtVerdict = new Map<string, boolean>();
  const requestedTimeouts: { command: string; timeoutMs: number; migrationContext?: string }[] = [];
  // Only a test of containment (`scopes`) runs commands in the production executor's systemd scopes, where
  // the host has them. Otherwise the fixture stands in for an enforced combined budget, so concurrent paths
  // run on every platform, and runs commands directly rather than one at a time.
  const local = scopes ? testExecutor({ home }) : directExecutor(hostname());
  const run = local.combinedLimits ? local.run : runBoundedProcess;
  const executor: Executor = { ...local, combinedLimits, run: (request) => {
    requestedTimeouts.push({ command: [request.executable, ...request.args].join(" "), timeoutMs: request.timeoutMs,
      ...(request.env?.SLIPJAY_MIGRATION_CONTEXT ? { migrationContext: request.env.SLIPJAY_MIGRATION_CONTEXT } : {}) });
    return run(request);
  } };
  const config: RunnerConfig = { repos: { "Fixture/Repo": { url: origin, verificationDepth, ...lane ? { lane } : {} }, ...other ? { "Fixture/Other": { url: otherOrigin, ...lane ? { lane } : {} } } : {}, ...extraRepos },
    ...workers === undefined ? {} : { workers },
    jj: { "user.name": "Runner Identity", "user.email": "runner@example.com" } };
  const log = openOperationLog(logPath, runnerLogOptions(config, executor));
  const unsubscribe = log.subscribe((event) => {
    if (event.event.type !== "submitted") published.push(event);
    const operation = log.operation(event.operationId);
    if (operation?.kind === "landing" && TERMINAL_EVENT_TYPES.includes(event.event.type as never))
      candidateAtVerdict.set(event.operationId, Boolean(git(["--git-dir", origin, "for-each-ref", `refs/heads/${operation.bookmark}`])));
  });
  const queue = createRunnerQueue({ log, executor, home, config, ...recoveryRetryMs === undefined ? {} : { recoveryRetryMs },
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
  return { root, logPath, authors, requestedTimeouts, candidateAtVerdict, development, land, origin, author, otherAuthor, otherMain, home, log, queue, executor, published, main, releaseRef, parents, remoteFile, push, candidate, submit, submitRelease, submitReset, lines, result,
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

export async function until<T>(check: () => Promise<T | undefined> | T | undefined, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Whether runs get systemd slices here: the runner's production executor. */
export const systemd = process.platform === "linux" && Boolean(process.env.XDG_RUNTIME_DIR);
/** The cgroup path of a live process (Linux). */
export const cgroupOf = async (pid: number) => (await readFile(`/proc/${pid}/cgroup`, "utf8")).trim().split(":").at(-1)!;

export async function hanging(f: Awaited<ReturnType<typeof fixture>>, pids: string, author = f.author, repo = "fixture/repo") {
  await f.candidate("hang", author, repo);
  await writeFile(join(author, "hang"), `${pids}\n`);
  return f.push(author, repo);
}
export const started = (pids: string) => until(async () => await readFile(pids, "utf8").then((text) => text ? true : undefined, () => undefined));

export const generations = (f: Awaited<ReturnType<typeof fixture>>, ids: string[]) =>
  ids.flatMap((id) => f.log.operation(id)!.runs).filter((run) => run.command.startsWith("node -e const fs=require(\"node:fs\");fs.mkdirSync")).length;

export const stagesOf = (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  f.log.events({ operationId: id }).flatMap((stored) => stored.event.type === "stage" ? [stored.event.stage] : []);

export const seqOf = (f: Awaited<ReturnType<typeof fixture>>, id: string, type: string) =>
  f.log.events({ operationId: id }).find((stored) => stored.event.type === type)!.seq;

export const exactPrefixGate = (root: string) => `const fs=require('node:fs'), path=require('node:path');
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

/** Hold A's rebuild after a remote move, so B waits on A's outcome while A verifies again. */
export async function dependentWaitingOnRebuild(f: Awaited<ReturnType<typeof fixture>>) {
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
