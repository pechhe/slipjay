import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Schedule } from "effect";
import { test } from "vite-plus/test";
import { assertHermeticHome } from "../scripts/hermetic-home-guard.mjs";
import { landWorkspace } from "../src/lib/slipjay.mjs";
import { githubRepository, MAX_ISSUE_ATTEMPTS, originatingIssue, pendingIssueRetry, postLandIssueBody, postLandIssueTitle } from "../src/lib/post-land-issue.mjs";
import { describePostLandFailure, latestPostLandResult, postLandRoot, retryPostLandIssues, runPostLandVerification, startPostLandVerification, type PostLandRecord } from "../src/lib/post-land-verification.mjs";

// These tests write post-land records; outside the hermetic setup they would
// land in the developer's real ~/.pi/agent/workspace-state (#991).
assertHermeticHome();

const jj = (cwd: string, args: string[]) =>
  execFileSync("jj", ["--color=never", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// The declared check proves it ran against the exact landed source and range,
// then passes or fails as the landed value says.
const CHECK = [
  "const fs = require('node:fs');",
  "const value = fs.readFileSync('value.txt', 'utf8');",
"const both = (name) => process.env['PEACH_POST_LAND_' + name] === undefined ? process.env['SLIPJAY_POST_LAND_' + name] : 'retired-name-set';",
  "fs.writeFileSync(process.env.EVIDENCE, JSON.stringify({ value, base: both('BASE'), commit: both('COMMIT') }));",
  "process.exit(value === 'broken' ? 3 : 0);",
].join("\n");

async function fixture() {
  process.env.JJ_USER ??= "Fixture";
  process.env.JJ_EMAIL ??= "fixture@example.com";
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "peach-post-land-")));
  const repo = path.join(root, "repo");
  const evidence = path.join(root, "evidence.json");
  await mkdir(repo, { recursive: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.com"]);
  await writeFile(path.join(repo, "value.txt"), "initial");
  await writeFile(path.join(repo, "slipjay.json"), JSON.stringify({
    version: 1, integrationBranch: "main", requiredLocalVerification: [],
    postLandVerification: [{ executable: process.execPath, args: ["-e", CHECK] }],
  }));
  git(["add", "."]);
  git(["commit", "-qm", "Initial"]);
  jj(repo, ["git", "init", "--colocate"]);
  process.env.EVIDENCE = evidence;
  let count = 0;
  return {
    root, repo, evidence,
    /** Land `value` from a fresh workspace, as one delivery. */
    async land(value: string, description: string | null = `Set ${value}`) {
      const workspace = path.join(root, `workspace-${++count}`);
      jj(repo, ["workspace", "add", "--name", `post-land-${path.basename(root)}-${count}`, "--revision", "main", workspace]);
      await writeFile(path.join(workspace, "value.txt"), value);
      if (description) jj(workspace, ["describe", "-m", description]);
      const base = jj(repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]);
      return { base, landed: await landWorkspace(workspace, { onProgress: () => {}, releaseLandedWorkspace: false }) };
    },
  };
}

async function finished(repo: string, commit: string): Promise<PostLandRecord> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const record = await latestPostLandResult(repo);
    if (record?.commit === commit) return record;
    await sleep(50);
  }
  const root = postLandRoot();
  const log = await readFile(path.join(root, `${commit}.log`), "utf8").catch((error) => String(error));
  const record = await readFile(path.join(root, `${commit}.json`), "utf8").catch((error) => String(error));
  throw new Error(`Post-land run for ${commit} did not finish.\nRecord: ${record}\nLog: ${log}`);
}

test("the hermetic guard refuses the account's real home and accepts a disposable one", () => {
  assert.throws(() => assertHermeticHome("/Users/someone", "/Users/someone"), /hermetic HOME/);
  assert.throws(() => assertHermeticHome("/Users/someone/", "/Users/someone"), /hermetic HOME/);
  assert.doesNotThrow(() => assertHermeticHome("/tmp/peach-test-home-x", "/Users/someone"));
  assert.notEqual(path.resolve(homedir()), path.resolve(userInfo().homedir), "this file runs under a disposable HOME");
  assert.ok(postLandRoot().startsWith(homedir()));
});

test("a post-land run whose process died before recording a result is reported, not left queued", async () => {
  const commit = "d".repeat(40);
  const exited = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  await mkdir(postLandRoot(), { recursive: true });
  await writeFile(path.join(postLandRoot(), `${commit}.json`), JSON.stringify({
    version: 1, status: "queued", integrationRoot: "/repository", commit, checks: [],
    queuedAt: new Date().toISOString(), log: path.join(postLandRoot(), `${commit}.log`),
  }));
  await writeFile(path.join(postLandRoot(), `${commit}.pid`), exited);
  const record = await latestPostLandResult("/repository");
  assert.equal(record?.status, "error");
  assert.match(describePostLandFailure(record) ?? "", /exited before recording a result/);
});

test("a detached runner that cannot start is recorded as an error instead of failing the landing process", async () => {
  const commit = "e".repeat(40);
  await startPostLandVerification({
    integrationRoot: "/unstartable", gitDirectory: "/unstartable/.git", base: "f".repeat(40), commit, checks: [],
    runner: ["/nonexistent/peach-post-land-runner"],
  });
  const record = await finished("/unstartable", commit);
  assert.equal(record.status, "error");
  assert.match(record.reason ?? "", /could not start/);
});

test("landing starts declared post-land verification against the exact landed source, and the next landing reports its failure", async () => {
  const f = await fixture();
  try {
    const good = await f.land("good");
    assert.equal(good.landed.ok, true);
    assert.equal(good.landed.postLand?.status, "queued");
    assert.equal((await finished(f.repo, good.landed.artifact.commitId)).status, "passed");
    assert.deepEqual(JSON.parse(await readFile(f.evidence, "utf8")),
      { value: "good", base: good.base, commit: good.landed.artifact.commitId });

    const broken = await f.land("broken");
    assert.equal(broken.landed.ok, true, "background verification never blocks the landing");
    assert.equal(broken.landed.postLandWarning, undefined);
    const failure = await finished(f.repo, broken.landed.artifact.commitId);
    assert.equal(failure.status, "failed");
    assert.equal(failure.failed?.exitCode, 3);
    assert.equal(failure.description, "Set broken");
    assert.match(failure.diffStat ?? "", /value\.txt/);
    assert.deepEqual(failure.issue, { status: "not_opened", reason: "the repository has no GitHub remote", transient: false });

    const next = await f.land("fixed");
    assert.match(next.landed.postLandWarning ?? "", new RegExp(`${broken.landed.artifact.commitId.slice(0, 12)} failed`));
    assert.equal((await finished(f.repo, next.landed.artifact.commitId)).status, "passed");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 300_000); // Two full landings; it blocks every landing, so it must survive a loaded gate.

const failedRecord = (overrides: Partial<PostLandRecord> = {}): PostLandRecord => ({
  version: 1, status: "failed", integrationRoot: "/repository", gitDirectory: "/repository/.git",
  base: "b".repeat(40), commit: "c".repeat(40), checks: [], queuedAt: "2026-10-01T00:00:00.000Z", log: "/logs/c.log",
  description: "Speed up parsing\n\nFixes #42\n\nLonger rationale.", diffStat: "src/parse.ts | 4 ++--\n1 file changed",
  originatingIssue: 42, repository: "owner/repo",
  failed: { command: "bun run test:slow", exitCode: 1, tail: "expected 1 to be 2" },
  ...overrides,
});

test("a failure Issue carries the landing's description, range, originating Issue, change summary and failure", () => {
  const record = failedRecord();
  assert.equal(postLandIssueTitle(record), "Post-land verification failed: Speed up parsing");
  const body = postLandIssueBody(record);
  for (const expected of [record.commit, record.base, "#42", "Longer rationale.", "src/parse.ts | 4 ++--", "`bun run test:slow`", "Exit code: `1`", "expected 1 to be 2"])
    assert.ok(body.includes(expected), `body lacks ${expected}:\n${body}`);
  assert.equal(postLandIssueTitle({ ...record, status: "error", failed: undefined, reason: "clone failed" }), "Post-land verification errored: Speed up parsing");
  assert.match(postLandIssueBody({ ...record, status: "error", failed: undefined, reason: "clone failed" }), /Run error: clone failed/);
});

test("the originating Issue and GitHub repository are resolved from metadata, description and remotes", () => {
  assert.equal(originatingIssue(7, "Fixes #42"), 7);
  assert.equal(originatingIssue(undefined, "Speed up parsing\n\nCloses #42"), 42);
  assert.equal(originatingIssue(null, "Speed up parsing (#43)"), 43);
  assert.equal(originatingIssue(null, "Speed up parsing"), null);
  const remotes = "mirror git@gitlab.com:owner/repo.git\norigin https://github.com/owner/repo.git\nfork git@github.com:me/repo.git";
  assert.equal(githubRepository(remotes, "fork"), "me/repo");
  assert.equal(githubRepository(remotes, null), "owner/repo");
  assert.equal(githubRepository("mirror git@gitlab.com:owner/repo.git", "origin"), null);
});

/** A record whose run errors at once (its Git directory does not exist), so only the Issue path is exercised. */
async function erroringRecord(overrides: Partial<PostLandRecord>) {
  const record = failedRecord({ status: "queued", failed: undefined, gitDirectory: "/nonexistent/peach-post-land/.git", ...overrides });
  await mkdir(postLandRoot(), { recursive: true });
  const file = path.join(postLandRoot(), `${record.commit}.json`);
  await writeFile(file, JSON.stringify(record));
  const read = async () => JSON.parse(await readFile(file, "utf8")) as PostLandRecord;
  return { file, read };
}

test("a failed run opens one linked Issue, and a rerun of the same record reuses it", async () => {
  const { file, read } = await erroringRecord({ commit: "1".repeat(40) });
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "create") return "https://github.com/owner/repo/issues/99";
    if (args[0] === "api" && args[1] === "repos/owner/repo/issues/99") return "123456";
    return "";
  };
  await runPostLandVerification(file, process.env, { gh });
  const first = await read();
  assert.equal(first.status, "error");
  assert.deepEqual(first.issue, { status: "opened", url: "https://github.com/owner/repo/issues/99", link: { status: "linked", originatingIssue: 42 } });
  const create = calls.find((args) => args[1] === "create") ?? [];
  assert.deepEqual([create[create.indexOf("--repo") + 1], create[create.indexOf("--label") + 1]], ["owner/repo", "bug"]);
  assert.ok(calls.some((args) => args.includes("repos/owner/repo/issues/42/dependencies/blocked_by") && args.includes("issue_id=123456")));
  assert.ok(calls.some((args) => args[0] === "issue" && args[1] === "comment" && args[2] === "42" && args.at(-1)?.includes("issues/99")));

  calls.length = 0;
  await runPostLandVerification(file, process.env, { gh });
  assert.deepEqual(calls, [], "a rerun neither opens nor links again");
  assert.equal((await read()).issue?.url, "https://github.com/owner/repo/issues/99");
});

test("without a GitHub remote or gh authentication, a failed run records why no Issue was opened", async () => {
  const noRemote = await erroringRecord({ commit: "2".repeat(40), repository: null });
  await runPostLandVerification(noRemote.file, process.env, { gh: async () => assert.fail("gh must not run without a GitHub remote") });
  assert.deepEqual((await noRemote.read()).issue, { status: "not_opened", reason: "the repository has no GitHub remote", transient: false });
  assert.ok((await noRemote.read()).finishedAt);

  const unauthenticated = await erroringRecord({ commit: "3".repeat(40) });
  await runPostLandVerification(unauthenticated.file, process.env, { gh: async () => { throw new Error("gh auth login required"); } });
  const record = await unauthenticated.read();
  assert.equal(record.issue?.status, "not_opened");
  assert.match(record.issue?.reason ?? "", /gh auth login required/);
  assert.ok(record.finishedAt, "the run still finishes");
});

const noDelay = { schedule: Schedule.spaced(0) };
const TIMEOUT = "gh issue create failed: timed out after 60s";

/** A `gh` that fails `issue create` with each reason in turn, then opens Issue 99. */
function flakyGh(...failures: string[]) {
  const creates: string[][] = [];
  const gh = async (args: string[]) => {
    if (args[0] === "issue" && args[1] === "create") {
      creates.push(args);
      const failure = failures.shift();
      if (failure) throw new Error(failure);
      return "https://github.com/owner/repo/issues/99";
    }
    if (args[0] === "api" && args[1] === "repos/owner/repo/issues/99") return "123456";
    return "";
  };
  return { gh, creates };
}

test("a transient gh failure is retried with backoff within the run until the Issue opens", async () => {
  const { file, read } = await erroringRecord({ commit: "4".repeat(40), integrationRoot: "/retry-in-run" });
  const { gh, creates } = flakyGh(TIMEOUT, "gh issue create failed: HTTP 502: Bad Gateway");
  await runPostLandVerification(file, process.env, { gh, ...noDelay });
  assert.equal(creates.length, 3);
  assert.equal((await read()).issue?.url, "https://github.com/owner/repo/issues/99");
});

test("a permanent gh failure is recorded once and never retried", async () => {
  const root = "/retry-permanent";
  const { file, read } = await erroringRecord({ commit: "5".repeat(40), integrationRoot: root });
  const { gh, creates } = flakyGh("gh issue create failed: To get started with GitHub CLI, please run: gh auth login");
  await runPostLandVerification(file, process.env, { gh, ...noDelay });
  assert.equal(creates.length, 1, "no in-run retry");
  const record = await read();
  assert.equal(record.issue?.status, "not_opened");
  assert.equal(record.issue?.transient, false);
  assert.equal(pendingIssueRetry(record), false);
  await retryPostLandIssues(root, process.env, { gh, ...noDelay });
  assert.equal(creates.length, 1, "no later retry");
});

test("a transient failure that outlasts the run is retried by the next post-land invocation, once, up to a bound", async () => {
  const root = "/retry-next-run";
  const { file, read } = await erroringRecord({ commit: "6".repeat(40), integrationRoot: root });
  const outage = flakyGh(TIMEOUT, TIMEOUT, TIMEOUT);
  await runPostLandVerification(file, process.env, { gh: outage.gh, ...noDelay });
  const lost = await read();
  assert.equal(outage.creates.length, 3);
  assert.deepEqual([lost.issue?.status, lost.issue?.transient, lost.issue?.attempts], ["not_opened", true, 1]);
  assert.ok(lost.finishedAt);

  // The next landing's post-land run on the same repository opens it.
  const next = await erroringRecord({ commit: "7".repeat(40), integrationRoot: root, repository: null });
  const recovered = flakyGh();
  await runPostLandVerification(next.file, process.env, { gh: recovered.gh, ...noDelay });
  assert.equal(recovered.creates.length, 1);
  assert.deepEqual((await read()).issue, { status: "opened", url: "https://github.com/owner/repo/issues/99", link: { status: "linked", originatingIssue: 42 } });
  await retryPostLandIssues(root, process.env, { gh: recovered.gh, ...noDelay });
  assert.equal(recovered.creates.length, 1, "an opened Issue is never opened again");

  // An earlier-format record (reason only) is classified by its reason; the bound stops retries.
  assert.equal(pendingIssueRetry({ ...lost, issue: { status: "not_opened", reason: "gh issue create failed: timeout" } }), true);
  assert.equal(pendingIssueRetry({ ...lost, issue: { ...lost.issue!, attempts: MAX_ISSUE_ATTEMPTS } }), false);
});

test("landing refuses a change with no description, workspace Issue or task", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.land("undescribed", null), /Landing needs a description/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
