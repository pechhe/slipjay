/**
 * What changed, read from the integration branch's commit messages: SlipJay keeps no changelog of its
 * own, so a commit's subject (what now happens), body (why) and item trailer are its record. Reads the
 * upgrade source's history as last fetched; never fetches, moves a slot or writes.
 */
import { runWorkspaceCommand } from "../infra/workspace-command.ts";
import { commitItem, withoutItemTrailers, type CommitItem } from "../build/issue-references.ts";
import { currentSlotPath, currentSlotPreviousPath } from "./workspace-paths.ts";
import { integrationBranchHead, linkedCommit, upgradeSource } from "./workspace-upgrade.ts";

/** One commit as a change: `installed` only where the reader asked whether this machine's client runs it. */
export interface Change {
  commit: string;
  date: string;
  subject: string;
  body: string;
  item: CommitItem | null;
  installed?: boolean | null;
}

const GIT_TIMEOUT_MS = 60_000;
const FIELD = "\x1f", RECORD = "\x1e";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function git(source: string, args: readonly string[]): Promise<string> {
  const result = await runWorkspaceCommand("git", args, { cwd: source, timeoutMs: GIT_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(`git ${args[0]} failed in ${source}: ${(result.stderr || result.stdout).trim().split(/\r?\n/).at(-1) ?? `exit ${result.code}`}`);
  return result.stdout;
}

/** The full commit id `revision` names in the source, or a refusal naming it. */
async function resolve(source: string, revision: string): Promise<string> {
  const result = await runWorkspaceCommand("git", ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], { cwd: source, timeoutMs: GIT_TIMEOUT_MS });
  if (result.code !== 0 || !result.stdout.trim()) throw new Error(`${revision} is not a commit in ${source}`);
  return result.stdout.trim();
}

/** The first-parent commits `rangeArgs` selects, newest first, read as changes. */
async function readChanges(source: string, rangeArgs: readonly string[]): Promise<Change[]> {
  const out = await git(source, ["log", "--first-parent", `--format=%H${FIELD}%cI${FIELD}%B${RECORD}`, ...rangeArgs, "--"]);
  return out.split(RECORD).map((record) => record.replace(/^\n/, "")).filter((record) => record.trim()).map((record) => {
    const [commit = "", date = "", message = ""] = record.split(FIELD);
    const [subject = "", ...rest] = message.trimEnd().split("\n");
    return { commit, date, subject, body: withoutItemTrailers(rest.join("\n")), item: commitItem(message) };
  });
}

/** The commits between two installs, newest first: what moving a slot from `from` to `to` brought in. */
export async function changesBetween(from: string, to: string, source: string = upgradeSource()): Promise<Change[]> {
  return readChanges(source, [`${from}..${to}`]);
}

/**
 * `slipjay changes`: the integration branch's commits after `since` (a revision, or a `YYYY-MM-DD`
 * date), newest first, each marked whether this machine's client runs it. Without `since` it starts
 * from the install the client's last upgrade replaced, else from the client's install.
 */
export async function listChanges(options: { since?: string | null; source?: string } = {}): Promise<Change[]> {
  const source = options.source ?? upgradeSource();
  const head = await integrationBranchHead(source, { fetch: false });
  const client = await linkedCommit(currentSlotPath());
  const since = options.since ?? await linkedCommit(currentSlotPreviousPath()) ?? client;
  if (!since) throw new Error("This machine has no client install to start from: name one with `slipjay changes --since <revision|YYYY-MM-DD>`");
  const range = DATE.test(since) ? [`--since=${since}T00:00:00`, head] : [`${await resolve(source, since)}..${head}`];
  const changes = await readChanges(source, range);
  // A client install the source does not hold (a stale checkout) leaves each commit's state unknown.
  const runs = client ? await resolve(source, client).catch(() => null) : null;
  const pending = runs ? new Set((await git(source, ["rev-list", `${runs}..${head}`])).split("\n").filter(Boolean)) : null;
  return changes.map((change) => ({ ...change, installed: pending ? !pending.has(change.commit) : null }));
}

/** An item as a reader names it: `Forge #N`, `Build #N`, or `owner/repo#N`. */
const itemName = (item: CommitItem): string => item.tracker === "github" ? `${item.repository ?? ""}#${item.number}`
  : `${item.tracker === "forge" ? "Forge" : "Build"} #${item.number}`;

/** One change's line: short id, date, subject, its item, and whether this machine's client runs it yet. */
export function describeChange(change: Change): string {
  const item = change.item ? ` (${itemName(change.item)})` : "";
  const pending = change.installed === false ? " [not installed]" : "";
  return `${change.commit.slice(0, 12)} ${change.date.slice(0, 10)} ${change.subject}${item}${pending}`;
}
