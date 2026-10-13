/**
 * Background verification of a landed commit. A repository may declare
 * `postLandVerification` commands that are too slow to block every landing. Land
 * starts them after integration, against an exact-revision source view, without
 * holding the landing slot. The outcome is a record that the next landing and
 * `slipjay status` report; it never changes the landed integration.
 */
import { spawn } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runBoundedProcess } from "./bounded-process.mjs";
import { checkoutCwd } from "./checkout-cwd.mjs";
import { withFinalizationSource } from "./post-integration-source.mjs";
import { withVerificationSlot } from "./verification-slot.mjs";
import { linkPostLandIssue, openPostLandIssue, pendingIssueRetry } from "./post-land-issue.mjs";
import { prepareWorkspaceDependencies } from "./workspace-dependencies.mjs";
import { postLandHome } from "./workspace-paths.mjs";

const RETAINED_RECORDS = 30;
const CHECK_TIMEOUT_MS = 45 * 60_000;
const FAILURE_TAIL_LINES = 60;

export const postLandRoot = postLandHome;
const recordFile = (commit) => path.join(postLandRoot(), `${commit}.json`);

/**
 * Queue a run for `base..commit`; returns its record. A long-lived host (the
 * Peach runtime, a Pi session) runs it in-process. A process that exits after
 * landing, such as the CLI, passes `runner`: a command that runs one record file
 * (appended) and outlives it.
 */
export async function startPostLandVerification({ integrationRoot, gitDirectory, base, commit, checks, runner, env = process.env, landing = {} }) {
  await mkdir(postLandRoot(), { recursive: true, mode: 0o700 });
  const file = recordFile(commit);
  // `landing` is the context a failure Issue carries: description, diff stat,
  // originating Issue and GitHub repository, captured while the workspace exists.
  const record = {
    version: 1, status: "queued", integrationRoot, gitDirectory, base, commit, checks,
    queuedAt: new Date().toISOString(), log: path.join(postLandRoot(), `${commit}.log`), ...landing,
  };
  await writeFile(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  await writeFile(record.log, "", { mode: 0o600 });
  const refuse = async (error) => {
    const failed = { ...record, status: "error", reason: `post-land verification could not start: ${error instanceof Error ? error.message : String(error)}` };
    await reportFailure(failed, env);
    await writeFile(file, JSON.stringify({ ...failed, finishedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  };
  // Kept apart from the record, which only the runner writes once started.
  let pid = process.pid;
  if (runner) {
    const [executable, ...args] = runner;
    // From the integration checkout, never the landing's own workspace: a detached run that outlives it must not hold it.
    const child = spawn(executable, [...args, file], { detached: true, stdio: "ignore", env, cwd: integrationRoot });
    child.once("error", (error) => void refuse(error).catch(() => {}));
    child.unref();
    pid = child.pid ?? 0;
  } else {
    void runPostLandVerification(file, env).catch((error) => refuse(error).catch(() => {}));
  }
  if (pid) await writeFile(pidFile(commit), String(pid), { mode: 0o600 });
  await pruneRecords();
  return record;
}

const pidFile = (commit) => path.join(postLandRoot(), `${commit}.pid`);

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
};

/** Records, with a run whose process is gone before it recorded a result reported as an error. */
async function readRecords() {
  const names = await readdir(postLandRoot()).catch(() => []);
  const records = await Promise.all(names.filter((name) => name.endsWith(".json"))
    .map((name) => readFile(path.join(postLandRoot(), name), "utf8").then(JSON.parse).catch(() => null)));
  return Promise.all(records.filter(Boolean).map(async (record) => {
    if (record.finishedAt) return record;
    const pid = Number(await readFile(pidFile(record.commit), "utf8").catch(() => ""));
    if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) return record;
    return { ...record, status: "error", reason: "the post-land process exited before recording a result", finishedAt: record.startedAt ?? record.queuedAt };
  }));
}

async function pruneRecords() {
  const settled = (await readRecords()).filter((record) => record.finishedAt)
    .sort((left, right) => right.finishedAt.localeCompare(left.finishedAt));
  for (const record of settled.slice(RETAINED_RECORDS)) {
    await rm(recordFile(record.commit), { force: true });
    await rm(pidFile(record.commit), { force: true });
    await rm(record.log, { force: true });
  }
}

/** The most recently finished run for a repository, if any. */
export async function latestPostLandResult(integrationRoot) {
  const finished = (await readRecords())
    .filter((record) => record.integrationRoot === integrationRoot && record.finishedAt)
    .sort((left, right) => right.finishedAt.localeCompare(left.finishedAt));
  return finished[0] ?? null;
}

/** One line for a run that did not pass, so the next landing sees it. */
export function describePostLandFailure(record) {
  if (!record || record.status === "passed") return null;
  const what = record.failed ? `${record.failed.command} exited ${record.failed.exitCode}` : record.reason ?? record.status;
  const issue = record.issue?.url ? ` Issue: ${record.issue.url}` : "";
  return `Post-land verification of ${record.commit.slice(0, 12)} ${record.status}: ${what}. Log: ${record.log}${issue}`;
}

/**
 * Open (once) and link the failure Issue on `record.issue`. `save` persists the
 * URL before linking, so a restart reuses the Issue instead of opening another.
 */
async function reportFailure(record, env, issueOptions = {}, save = async () => {}) {
  if (record.status !== "failed" && record.status !== "error") return;
  const options = { env, ...issueOptions };
  record.issue = await openPostLandIssue(record, options);
  await save();
  record.issue = await linkPostLandIssue(record, options);
  await save();
}

async function runChecks(record, update, baseEnv) {
  await withFinalizationSource(record.gitDirectory, record.commit, async (root) => {
    const env = { ...baseEnv, SLIPJAY_POST_LAND_BASE: record.base, SLIPJAY_POST_LAND_COMMIT: record.commit };
    // The log, not this process's output: an in-process run shares its host's.
    await appendFile(record.log, "[post-land] installing dependencies\n");
    await prepareWorkspaceDependencies(root, { quiet: true, env });
    for (const check of record.checks) {
      const command = `${check.executable} ${check.args.join(" ")}`.trim();
      await appendFile(record.log, `[post-land] ${command}\n`);
      const result = await runBoundedProcess({
        executable: check.executable, args: check.args, cwd: await checkoutCwd(root, check.cwd, `Post-land check "${command}"`), env,
        timeoutMs: CHECK_TIMEOUT_MS, maxOutputBytes: 4 * 1024 * 1024,
      });
      await appendFile(record.log, `${result.stdout}${result.stderr}\n`);
      if (result.exitCode !== 0) {
        const tail = `${result.stdout}${result.stderr}`.trimEnd().split(/\r?\n/).slice(-FAILURE_TAIL_LINES).join("\n");
        await update({ status: "failed", failed: { command, exitCode: result.exitCode ?? result.signal ?? "timeout", tail } });
        return;
      }
    }
    await update({ status: "passed" });
  });
}

/**
 * Retry opening the Issue of each finished run on `integrationRoot` whose earlier
 * attempt failed transiently, up to the attempt bound. Retries for one repository
 * serialise on their own slot and re-read the record inside it, so concurrent
 * runs never open a second Issue for the same landed commit.
 */
export async function retryPostLandIssues(integrationRoot, env = process.env, issueOptions = {}, except = null) {
  const pending = (await readRecords()).filter((record) => record.integrationRoot === integrationRoot && record.commit !== except
    && record.finishedAt && pendingIssueRetry(record));
  for (const { commit } of pending) {
    await withVerificationSlot(async () => {
      const file = recordFile(commit);
      const record = await readFile(file, "utf8").then(JSON.parse).catch(() => null);
      if (!record?.finishedAt || !pendingIssueRetry(record)) return;
      await reportFailure(record, env, issueOptions, () => writeFile(file, JSON.stringify(record, null, 2), { mode: 0o600 }));
    }, { root: path.join(postLandRoot(), "issues"), scope: integrationRoot, env: {}, label: `post-land-issue:${commit.slice(0, 12)}` });
  }
}

/**
 * One run: wait for earlier runs, verify, record the outcome, and open a failure
 * Issue, then retry earlier runs' transiently failed Issues for the repository.
 * `env` is the landing's command environment; `gh` and the retry `schedule` are
 * injectable for tests.
 */
export async function runPostLandVerification(file, env = process.env, issueOptions = {}) {
  const record = JSON.parse(await readFile(file, "utf8"));
  const update = async (fields) => {
    Object.assign(record, fields);
    await writeFile(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  };
  try {
    // Runs queue one at a time on their own slot, never the landing slot.
    await withVerificationSlot(async () => {
      await update({ status: "running", startedAt: new Date().toISOString() });
      await runChecks(record, update, env);
    }, { root: path.join(postLandRoot(), "queue"), env: {}, label: `post-land:${record.commit.slice(0, 12)}` });
  } catch (error) {
    await update({ status: "error", reason: error instanceof Error ? error.message : String(error) });
  }
  // Outside the verification slot: GitHub calls never hold up the next run.
  await reportFailure(record, env, issueOptions, () => update({}));
  await update({ finishedAt: new Date().toISOString() });
  // This run's own Issue was just attempted; the next invocation retries it.
  await retryPostLandIssues(record.integrationRoot, env, issueOptions, record.commit).catch(() => {});
}
