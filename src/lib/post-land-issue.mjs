/**
 * Turn a failed or errored post-land run into one GitHub Issue on the landed
 * repository, carrying the landing's context so a repair needs no original
 * session. The record is the idempotency key: once it names an Issue URL, no
 * other Issue is opened for that landed commit.
 */
import { Effect, Schedule } from "effect";
import { runBoundedProcess } from "./bounded-process.mjs";

const GH_TIMEOUT_MS = 60_000;
const NO_REMOTE = "the repository has no GitHub remote";
/** `gh issue create` tries per invocation: the first plus two backed-off retries. */
const IN_RUN_RETRIES = 2;
const RETRY_SCHEDULE = Schedule.exponential("5 seconds");
/** Invocations (a run's own report, then later post-land runs) before a transient failure is abandoned. */
export const MAX_ISSUE_ATTEMPTS = 5;

/** `owner/name` of a GitHub remote in `jj git remote list` output, preferring `preferred`. */
export function githubRepository(remoteList, preferred) {
  const remotes = remoteList.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 2)
    .map(([name, url]) => ({ name, repository: /github\.com[:/]([^\s/]+\/[^\s/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null }))
    .filter((remote) => remote.repository);
  return (remotes.find((remote) => remote.name === preferred) ?? remotes[0])?.repository ?? null;
}

/** The Issue a landing served: workspace metadata first, else a closing reference or `(#N)` in its description. */
export function originatingIssue(issueNumber, description) {
  if (Number.isInteger(issueNumber) && issueNumber > 0) return issueNumber;
  const match = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#(\d+)\b/i.exec(description ?? "") ?? /\(#(\d+)\)/.exec(description ?? "");
  return match ? Number(match[1]) : null;
}

/** Whether `description` already refers to Issue `issueNumber` (`#N`, `Fixes #N`, or `owner/repo#N`). */
export function referencesIssue(description, issueNumber) {
  return new RegExp(`(?<![\\w&])#${issueNumber}(?!\\d)|[\\w.-]+/[\\w.-]+#${issueNumber}(?!\\d)`).test(description ?? "");
}

/** `description` plus an `Issue: owner/repo#N` git trailer, unless it has no Issue or already names it. */
export function withIssueTrailer(description, issueNumber, repository) {
  const text = (description ?? "").trimEnd();
  if (!Number.isInteger(issueNumber) || issueNumber <= 0 || referencesIssue(text, issueNumber)) return text;
  const trailer = `Issue: ${repository ?? ""}#${issueNumber}`;
  const paragraphs = text.split(/\n\s*\n/);
  const inTrailerBlock = paragraphs.length > 1 && paragraphs.at(-1).split("\n").every((line) => /^[A-Za-z][\w-]*: \S/.test(line));
  return `${text}${inTrailerBlock ? "\n" : "\n\n"}${trailer}`;
}

const firstLine = (record) => (record.description ?? "").split(/\r?\n/)[0].trim() || record.commit.slice(0, 12);

export function postLandIssueTitle(record) {
  return `Post-land verification ${record.status === "error" ? "errored" : "failed"}: ${firstLine(record)}`;
}

export function postLandIssueBody(record) {
  const fence = (text) => `\`\`\`\n${String(text ?? "").trimEnd()}\n\`\`\``;
  const failure = record.failed
    ? [`Failing command: \`${record.failed.command}\``, `Exit code: \`${record.failed.exitCode}\``, "", "Failure tail:", "", fence(record.failed.tail)]
    : [`Run error: ${record.reason ?? record.status}`];
  return [
    `Post-land verification of a landed commit ${record.status === "error" ? "errored" : "failed"}.`,
    "",
    `- Landed commit: \`${record.commit}\``,
    `- Base: \`${record.base}\``,
    `- Originating Issue: ${record.originatingIssue ? `#${record.originatingIssue}` : "unknown"}`,
    `- Log on the landing host: \`${record.log}\``,
    "",
    "## Landing description",
    "",
    fence(record.description ?? "(none recorded)"),
    "",
    "## Changes",
    "",
    fence(record.diffStat ?? "(not recorded)"),
    "",
    "## Failure",
    "",
    ...failure,
    "",
    `Rerun with \`SLIPJAY_POST_LAND_BASE=${record.base} SLIPJAY_POST_LAND_COMMIT=${record.commit}\` against the landed source.`,
  ].join("\n");
}

const ghRunner = (env) => async (args) => {
  const result = await runBoundedProcess({ executable: "gh", args, cwd: process.cwd(), env, timeoutMs: GH_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 });
  if (result.exitCode !== 0) {
    const detail = result.timedOut ? `timed out after ${GH_TIMEOUT_MS / 1000}s` : (result.stderr || result.stdout || result.signal || "timeout").toString().trim();
    throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
};

// Failures that may succeed later: timeouts, network errors, GitHub 5xx and rate
// limits. Anything else (no auth, no access, validation) is permanent.
const TRANSIENT = /\btime(?:d )?out\b|SIGTERM|SIGKILL|ETIMEDOUT|ECONN(?:RESET|REFUSED|ABORTED)|EAI_AGAIN|ENOTFOUND|EPIPE|\bnetwork\b|\bconnection\b|could not resolve|TLS handshake|unexpected EOF|HTTP 5\d\d|\b5\d\d (?:Internal|Bad Gateway|Service Unavailable|Gateway Time)|HTTP 429|rate limit/i;

/** Whether a `gh` failure reason is worth retrying. */
export function transientIssueFailure(reason) {
  return reason !== NO_REMOTE && TRANSIENT.test(reason ?? "");
}

/**
 * Whether a later post-land invocation should try again to open this record's
 * Issue. Records written before failures were classified carry only a reason.
 */
export function pendingIssueRetry(record) {
  const issue = record?.issue;
  if ((record?.status !== "failed" && record?.status !== "error") || issue?.status !== "not_opened" || issue.url) return false;
  return (issue.transient ?? transientIssueFailure(issue.reason)) && (issue.attempts ?? 1) < MAX_ISSUE_ATTEMPTS;
}

/**
 * The `issue` field for a finished record. Never throws: a missing remote or
 * `gh` failure becomes `not_opened` with its reason, whether it is `transient`,
 * and how many invocations have tried. A transient failure is retried with
 * backoff within this invocation. `gh` and the retry `schedule` are injectable for tests.
 */
export async function openPostLandIssue(record, { env = process.env, gh = ghRunner(env), schedule = RETRY_SCHEDULE } = {}) {
  if (record.issue?.url) return record.issue;
  if (record.status !== "failed" && record.status !== "error") return record.issue;
  const repository = record.repository;
  if (!repository) return { status: "not_opened", reason: NO_REMOTE, transient: false };
  const attempts = (record.issue?.status === "not_opened" ? record.issue.attempts ?? 1 : 0) + 1;
  const reasonOf = (error) => error instanceof Error ? error.message : String(error);
  const create = Effect.tryPromise({
    try: () => gh(["issue", "create", "--repo", repository, "--title", postLandIssueTitle(record), "--body", postLandIssueBody(record), "--label", "bug"]),
    catch: reasonOf,
  }).pipe(Effect.retry({ schedule, times: IN_RUN_RETRIES, while: transientIssueFailure }), Effect.result);
  const result = await Effect.runPromise(create);
  if (result._tag === "Failure") {
    return { status: "not_opened", reason: result.failure, transient: transientIssueFailure(result.failure), attempts };
  }
  const url = result.success.split(/\r?\n/).find((line) => line.startsWith("https://github.com/")) ?? result.success;
  return { status: "opened", url };
}

/** Link an opened Issue to the landing's originating Issue: a native blocked-by edge plus a comment. */
export async function linkPostLandIssue(record, { env = process.env, gh = ghRunner(env) } = {}) {
  const issue = record.issue;
  if (!issue?.url || !record.originatingIssue || issue.link) return issue;
  const number = /\/issues\/(\d+)$/.exec(issue.url)?.[1];
  try {
    if (!number) throw new Error(`cannot read an Issue number from ${issue.url}`);
    const id = await gh(["api", `repos/${record.repository}/issues/${number}`, "--jq", ".id"]);
    await gh(["api", "--method", "POST", `repos/${record.repository}/issues/${record.originatingIssue}/dependencies/blocked_by`, "-F", `issue_id=${id}`]);
    await gh(["issue", "comment", String(record.originatingIssue), "--repo", record.repository, "--body",
      `Post-land verification of \`${record.commit.slice(0, 12)}\` ${record.status === "error" ? "errored" : "failed"}; repair is tracked in ${issue.url}.`]);
    return { ...issue, link: { status: "linked", originatingIssue: record.originatingIssue } };
  } catch (error) {
    return { ...issue, link: { status: "not_linked", originatingIssue: record.originatingIssue, reason: error instanceof Error ? error.message : String(error) } };
  }
}
