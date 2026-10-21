import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as serialTest } from "vite-plus/test";
import { auditSummary, promotionRefusal } from "../../src/lib/release/audit-ledger.ts";
import { AUDIT_INTERRUPTED_REASON, candidateBookmark } from "../../src/lib/runner/runner-contract.ts";
import type { AuditOperation, SubmitRequest } from "../../src/lib/runner/runner-contract.ts";
import { newOperationId, openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { createRunnerQueue } from "../../src/lib/runner/runner-queue.ts";
import { directExecutor } from "../support/executor.ts";
import { fixtureJjConfig } from "../support/jj-user-config.ts";

// Every test builds its own origin, checkouts and queue under a fresh root, so they run together.
const test = serialTest.concurrent;
const jj = (cwd: string, args: string[]) => execFileSync("jj", ["--color=never", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const REPO = "fixture/repo";

// The audit's second command records where it ran, holds while `hold-audit` exists, and fails when the head carries `break.txt`.
const auditCheck = (root: string) => `const fs=require("node:fs"),path=require("node:path"),at=(name)=>path.join(${JSON.stringify(root)},name);
fs.appendFileSync(at("audit-ran.log"), process.cwd()+"\\n");
while (fs.existsSync(at("hold-audit"))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
if (fs.existsSync("break.txt")) { process.stderr.write("FAIL tests/fixture.test.ts > fixture > the suite is broken\\n"); process.exit(3); }`;

/**
 * A repository whose policy declares an audit and a release branch, an author's clone of it, and a runner queue on
 * its own log. `audit: false` declares none.
 */
async function fixture({ audit = true }: { audit?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "audit-runner-")));
  const origin = join(root, "origin.git"), seed = join(root, "seed"), author = join(root, "author"), home = join(root, "runner");
  await mkdir(seed);
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { cwd: root, stdio: "pipe" });
  fixtureJjConfig();
  jj(seed, ["git", "init"]);
  await writeFile(join(seed, "slipjay.json"), JSON.stringify({
    version: 1, integrationBranch: "main",
    sourcePublication: { version: 1, mode: "required", remote: "origin" },
    // A candidate carrying `slow.txt` holds its landing gate while `hold-landing` exists.
    requiredLandingVerification: [{ executable: "node", args: ["-e", `const fs=require("node:fs");
while (fs.existsSync("slow.txt") && fs.existsSync(${JSON.stringify(join(root, "hold-landing"))})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);`] }],
    // Release verification holds while `hold-release` exists.
    releaseBranch: "release", requiredReleaseVerification: [{ executable: "node", args: ["-e", `const fs=require("node:fs");
while (fs.existsSync(${JSON.stringify(join(root, "hold-release"))})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);`] }],
    ...audit ? { audit: { commands: [{ executable: "node", args: ["-e", "console.log('install')"] }, { executable: "node", args: ["-e", auditCheck(root)] }] } } : {},
  }));
  jj(seed, ["describe", "-m", "Seed policy"]);
  jj(seed, ["git", "remote", "add", "origin", origin]);
  jj(seed, ["git", "push", "--remote", "origin", "--named", "main=@"]);
  jj(seed, ["git", "push", "--remote", "origin", "--named", "release=main"]);
  jj(root, ["git", "clone", origin, author]);
  const log = openOperationLog(":memory:");
  const queue = createRunnerQueue({ log, executor: directExecutor("test"), home, config: { repos: { "Fixture/Repo": { url: origin } },
    jj: { "user.name": "Runner Identity", "user.email": "runner@example.com" } } });
  const main = () => execFileSync("git", ["--git-dir", origin, "rev-parse", "main"], { encoding: "utf8" }).trim();
  async function candidate(file: string): Promise<SubmitRequest> {
    jj(author, ["git", "fetch", "--remote", "origin"]);
    jj(author, ["new", "main@origin"]);
    await writeFile(join(author, file), `${file}\n`);
    jj(author, ["describe", "-m", `Add ${file}`]);
    const changeId = jj(author, ["log", "-r", "@", "--no-graph", "-T", "change_id"]);
    const commitId = jj(author, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    const bookmark = candidateBookmark(changeId);
    jj(author, ["git", "push", "--remote", "origin", "--named", `${bookmark}=@`]);
    return { repo: REPO, changeId, commitId, bookmark, submittedBy: "test" };
  }
  const submit = (request: SubmitRequest) => { const id = newOperationId(); log.append(id, { type: "submitted", ...request }); return id; };
  const audits = () => log.audits(REPO);
  const summary = () => auditSummary({ audits: audits(), landings: log.landings(REPO) }, new Date());
  /** Wake the queue and wait until `done` holds of the audits (an audit's discovery and run are asynchronous). */
  async function settle(done: (audits: AuditOperation[]) => boolean) {
    for (const deadline = Date.now() + 90_000; !done(audits()) && Date.now() < deadline;) {
      queue.wake();
      await queue.idle();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await queue.idle();
    return audits();
  }
  return { root, log, queue, main, candidate, submit, audits, summary, settle,
    async dispose() { queue.close(); await queue.idle(); log.close(); await rm(root, { recursive: true, force: true }); } };
}

test("an audit starts in a repository that never landed, audits the exact remote head in full and records it green", async () => {
  const f = await fixture();
  try {
    assert.equal(f.log.lastLanded(REPO), null, "no landing in the ledger");
    await f.queue.recover();
    const [audit] = await f.settle((audits) => audits.some((operation) => operation.status === "audited"));
    assert.ok(audit?.status === "audited" && audit.result?.type === "audited", JSON.stringify(audit?.result));
    assert.equal(audit.head, f.main());
    assert.equal(audit.result.commit, f.main());
    assert.equal(audit.result.commands.length, 2);
    assert.deepEqual(audit.result.passed, audit.result.commands);
    assert.deepEqual([audit.result.skipped, audit.result.reused], [[], []]);
    assert.equal(audit.submittedBy.endsWith(":schedule"), true);
    assert.deepEqual(audit.runs.map((run) => [run.purpose, run.exitCode]), [["gate", 0], ["gate", 0]]);
    const ran = (await readFile(join(f.root, "audit-ran.log"), "utf8")).trim().split("\n");
    assert.deepEqual(ran, [join(f.root, "runner", "repos", REPO)], "ran once, in the runner's checkout of the repository");
    const { lastGreen, openFailure } = f.summary();
    assert.equal(lastGreen?.commit, f.main());
    assert.equal(openFailure, null);
    // The slot is covered: asking the schedule again submits nothing.
    await f.queue.recover();
    await f.settle(() => true);
    assert.equal(f.audits().length, 1);
  } finally { await f.dispose(); }
}, 120_000);

test("a repository that declares no audit is never audited", async () => {
  const f = await fixture({ audit: false });
  try {
    await f.queue.recover();
    await f.queue.idle();
    assert.equal(f.audits().length, 0);
  } finally { await f.dispose(); }
}, 120_000);

test("an audit that fails records the head, the suspects and the failing command, and is not green", async () => {
  const f = await fixture();
  try {
    await f.queue.recover();
    await f.settle((audits) => audits.some((operation) => operation.status === "audited"));
    // A landing that breaks the suite, which its own light gate did not notice.
    const landing = f.submit(await f.candidate("break.txt"));
    // Landing it asks the schedule again; the slot is covered, so no second audit runs tonight.
    f.queue.wake();
    await f.queue.idle();
    assert.equal(f.log.operation(landing)?.status, "landed");
    assert.equal(f.audits().length, 1);
    // The next night's audit.
    const night = newOperationId();
    f.log.append(night, { type: "submitted", kind: "audit", repo: REPO, commitId: "", slot: new Date(Date.now() + 86_400_000).toISOString(), submittedBy: "test" });
    f.queue.wake();
    await f.queue.idle();
    const failed = f.log.operation(night) as AuditOperation;
    assert.equal(failed.status, "failed", JSON.stringify(failed.result));
    assert.equal(failed.head, f.main());
    assert.ok(failed.result?.type === "failed" && failed.result.stage === "verifying" && /the suite is broken/.test(failed.result.output ?? ""), JSON.stringify(failed.result));
    const { openFailure, lastGreen, latest } = f.summary();
    assert.equal(latest?.status, "failed");
    assert.notEqual(lastGreen?.commit, f.main());
    assert.deepEqual(openFailure?.suspects, [f.main()]);
    assert.equal(openFailure?.cause, null);
  } finally { await f.dispose(); }
}, 240_000);

test("a promotion is refused while the latest audit failed without a recorded cause, and allowed once one is recorded", async () => {
  const f = await fixture();
  try {
    const landing = f.submit(await f.candidate("break.txt"));
    f.queue.wake();
    // The landing asks the schedule, which audits the new head: the suite is broken.
    const [failed] = await f.settle((audits) => audits.some((operation) => operation.status === "failed"));
    assert.equal(f.log.operation(landing)?.status, "landed");
    assert.equal(failed?.status, "failed", JSON.stringify(failed?.result));
    assert.equal(promotionRefusal(f.summary())?.includes(f.main().slice(0, 12)), true);
    const refused = newOperationId();
    f.log.append(refused, { type: "submitted", kind: "release", repo: REPO, commitId: f.main(), migrationsReady: false, submittedBy: "test" });
    f.queue.wake();
    await f.queue.idle();
    const refusal = f.log.operation(refused)?.result;
    assert.ok(refusal?.type === "failed" && /latest audit failed at .* and no cause is recorded/.test(refusal.reason), JSON.stringify(refusal));
    // Someone looks, and records which landing broke it.
    f.log.append(failed!.id, { type: "audit_cause", cause: { kind: "culprits", landings: [f.main()] }, by: "henry" });
    assert.equal(f.summary().escapes, 1, "the landing's gate was green");
    const allowed = newOperationId();
    f.log.append(allowed, { type: "submitted", kind: "release", repo: REPO, commitId: f.main(), migrationsReady: false, submittedBy: "test" });
    f.queue.wake();
    await f.queue.idle();
    assert.equal(f.log.operation(allowed)?.result?.type, "released", JSON.stringify(f.log.operation(allowed)?.result));
  } finally { await f.dispose(); }
}, 240_000);

test("an audit that fails while a release verifies refuses its publication", async () => {
  const f = await fixture();
  try {
    await f.queue.recover();
    await f.settle((audits) => audits.some((operation) => operation.status === "audited"));
    // Something to release; the night's slot is already covered, so landing it audits nothing.
    const landing = f.submit(await f.candidate("feature.txt"));
    f.queue.wake();
    await f.queue.idle();
    assert.equal(f.log.operation(landing)?.status, "landed");
    await writeFile(join(f.root, "hold-release"), "");
    const release = newOperationId();
    f.log.append(release, { type: "submitted", kind: "release", repo: REPO, commitId: f.main(), migrationsReady: false, submittedBy: "test" });
    f.queue.wake();
    for (const deadline = Date.now() + 60_000; f.log.operation(release)?.stage !== "verifying" && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.log.operation(release)?.stage, "verifying");
    // The next night's audit fails meanwhile.
    const night = newOperationId();
    f.log.append(night, { type: "submitted", kind: "audit", repo: REPO, commitId: "", slot: new Date(Date.now() + 86_400_000).toISOString(), submittedBy: "test" });
    f.log.append(night, { type: "audit_head", commit: f.main() });
    f.log.append(night, { type: "failed", stage: "verifying", reason: "the suite is broken" });
    await rm(join(f.root, "hold-release"));
    await f.queue.idle();
    const refusal = f.log.operation(release)?.result;
    assert.ok(refusal?.type === "failed" && /latest audit failed at .* and no cause is recorded/.test(refusal.reason), JSON.stringify(refusal));
    assert.equal(execFileSync("git", ["--git-dir", join(f.root, "origin.git"), "rev-parse", "release"], { encoding: "utf8" }).trim() === f.main(), false, "nothing was published");
  } finally { await f.dispose(); }
}, 240_000);

test("cancelling a queued audit makes its time due again at once, without waiting for other work", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "hold-landing"), "");
    const first = f.submit(await f.candidate("first.txt"));
    const slow = f.submit(await f.candidate("slow.txt"));
    f.queue.wake();
    // The first landing asks the schedule, whose audit queues behind the held second landing.
    for (const deadline = Date.now() + 60_000; !(f.log.operation(slow)?.status === "running" && f.audits().some((audit) => audit.status === "queued")) && Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(f.log.operation(first)?.status, "landed");
    const [queued] = f.audits();
    assert.equal(queued?.status, "queued");
    // As the runner API cancels it.
    f.log.append(queued!.id, { type: "cancelled", reason: "cancelled by the author" });
    f.queue.cancelled(f.log.operation(queued!.id)!);
    const replacement = f.audits().find((audit) => audit.id !== queued!.id);
    assert.equal(replacement?.status, "queued", "the slot was submitted again while the landing still runs");
    await rm(join(f.root, "hold-landing"));
    await f.settle((audits) => audits.some((audit) => audit.status === "audited"));
    assert.equal(f.log.operation(replacement!.id)?.status, "audited");
  } finally { await f.dispose(); }
}, 240_000);

test("a restart mid-audit records the audit interrupted, which is no verdict, and runs it again", async () => {
  const f = await fixture();
  try {
    // The audit was running when the runner stopped.
    const interrupted = newOperationId();
    f.log.append(interrupted, { type: "submitted", kind: "audit", repo: REPO, commitId: "", slot: new Date().toISOString(), submittedBy: "test" });
    f.log.append(interrupted, { type: "stage", stage: "verifying" });
    f.log.append(interrupted, { type: "audit_head", commit: f.main() });
    await f.queue.recover();
    assert.deepEqual(f.log.operation(interrupted)?.result, { type: "cancelled", reason: AUDIT_INTERRUPTED_REASON });
    const audits = await f.settle((all) => all.some((operation) => operation.status === "audited"));
    const rerun = audits.find((operation) => operation.status === "audited");
    assert.ok(rerun && rerun.id !== interrupted, "a new audit of the same slot ran");
    assert.equal(f.summary().latest?.operationId, rerun.id);
    assert.equal(f.summary().lastGreen?.commit, f.main());
  } finally { await f.dispose(); }
}, 120_000);

test("an audit takes the repository's lane like a landing: it waits for the running landing and then runs", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "hold-audit"), "");
    await f.queue.recover();
    for (const deadline = Date.now() + 60_000; f.audits()[0]?.status !== "running" && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(f.audits()[0]?.status, "running");
    const landing = f.submit(await f.candidate("late.txt"));
    f.queue.wake();
    assert.equal(f.log.operation(landing)?.status, "queued");
    assert.match(f.log.operation(landing)?.waitingFor ?? "", /^audit /);
    await rm(join(f.root, "hold-audit"));
    await f.settle((audits) => audits.every((operation) => operation.status === "audited") && f.log.operation(landing)?.status === "landed");
    assert.equal(f.log.operation(landing)?.status, "landed");
    assert.equal(f.audits()[0]?.status, "audited");
  } finally { await f.dispose(); }
}, 120_000);
