import { trackerIsBuild, type Tracker } from "./tracker.ts";

/** GitHub repository and Issue references a landing reads from remotes and descriptions. */

const githubRemoteRepository = (remote: string): string | null => {
  let path: string;
  if (remote.includes("://")) {
    try {
      const url = new URL(remote);
      if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol) || url.hostname.toLowerCase() !== "github.com") return null;
      path = url.pathname;
    } catch { return null; }
  } else {
    const scp = /^(?:[^@/:\s]+@)?github\.com:([^?#\s]+)$/i.exec(remote);
    if (!scp) return null;
    path = scp[1]!;
  }
  const match = /^\/?([A-Za-z0-9-]+)\/([\w.-]+)\/?$/.exec(path);
  if (!match) return null;
  const repository = match[2]!.replace(/\.git$/, "");
  if (!repository || repository === "." || repository === "..") return null;
  return `${match[1]}/${repository}`;
};

/** `owner/name` of a GitHub remote in `jj git remote list` output, preferring `preferred`. */
export function githubRepository(remoteList: string, preferred?: string | null): string | null {
  const remotes = remoteList.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 2)
    .map(([name, url]) => ({ name, repository: githubRemoteRepository(url!) }))
    .filter((remote) => remote.repository);
  return (remotes.find((remote) => remote.name === preferred) ?? remotes[0])?.repository ?? null;
}

/** The Issue a landing served: workspace metadata first, else a closing reference or `(#N)` in its description. */
export function originatingIssue(issueNumber: unknown, description: string | null | undefined): number | null {
  if (typeof issueNumber === "number" && Number.isInteger(issueNumber) && issueNumber > 0) return issueNumber;
  const match = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#(\d+)\b/i.exec(description ?? "") ?? /\(#(\d+)\)/.exec(description ?? "");
  return match ? Number(match[1]) : null;
}

/** Whether `description` already refers to Issue `issueNumber` (`#N`, `Fixes #N`, or `owner/repo#N`). */
export function referencesIssue(description: string | null | undefined, issueNumber: number): boolean {
  return new RegExp(`(?<![\\w&])#${issueNumber}(?!\\d)|[\\w.-]+/[\\w.-]+#${issueNumber}(?!\\d)`).test(description ?? "");
}

/** One item trailer line: `Build: #N`, `Forge: #N` or `Issue: [owner/repo]#N`. */
const ITEM_TRAILER = /^(?:(Build|Forge): #(\d+)|Issue: ([\w.-]+\/[\w.-]+)?#(\d+))\s*$/;

/** Blank text and item trailers alone do not describe the work. */
export function isUndescribed(description: string): boolean {
  return description.split(/\r?\n/).every((line) => !line.trim() || trailerItem(line));
}

/** The work item a commit message's trailer names. */
export interface CommitItem { tracker: Tracker; number: number; repository: string | null }

/** The item one line names when it is an item trailer, else null: the one reader of item trailers. */
function trailerItem(line: string): CommitItem | null {
  const match = ITEM_TRAILER.exec(line);
  if (!match) return null;
  return match[1] ? { tracker: match[1] === "Forge" ? "forge" : "build", number: Number(match[2]), repository: null }
    : { tracker: "github", number: Number(match[4]), repository: match[3] ?? null };
}

/** Every item trailer in `message`, in order. */
const itemTrailers = (message: string | null | undefined): CommitItem[] =>
  (message ?? "").split(/\r?\n/).map(trailerItem).filter((item): item is CommitItem => item !== null);

/** The item a message's first item trailer names, or null; a `#N` outside a trailer names nothing. */
export const commitItem = (message: string | null | undefined): CommitItem | null => itemTrailers(message)[0] ?? null;

/** `message` without its item trailer lines, trimmed. */
export const withoutItemTrailers = (message: string): string =>
  message.split(/\r?\n/).filter((line) => !trailerItem(line)).join("\n").trim();

/**
 * `description` plus a git trailer naming its work item, unless it has none or already names it:
 * `Issue: owner/repo#N` for a GitHub Issue, or `Build: #N` for a Build item. A Build item is named only
 * by that trailer, since `#N` in a description may be a GitHub reference.
 */
export function withIssueTrailer(description: string, issueNumber: number | null | undefined, repository: string | null, tracker: Tracker = "github"): string {
  const text = (description ?? "").trimEnd();
  if (!Number.isInteger(issueNumber) || issueNumber! <= 0) return text;
  if (trackerIsBuild(tracker) ? buildTrailerItem(text) === issueNumber : referencesIssue(text, issueNumber!)) return text;
  const trailer = tracker === "forge" ? `Forge: #${issueNumber}` : tracker === "build" ? `Build: #${issueNumber}` : `Issue: ${repository ?? ""}#${issueNumber}`;
  const paragraphs = text.split(/\n\s*\n/);
  const inTrailerBlock = paragraphs.length > 1 && paragraphs.at(-1)!.split("\n").every((line) => /^[A-Za-z][\w-]*: \S/.test(line));
  return `${text}${inTrailerBlock ? "\n" : "\n\n"}${trailer}`;
}


/** The Build item a description's `Build: #N` trailer names, or null. */
export function buildTrailerItem(description: string | null | undefined): number | null {
  return itemTrailers(description).find((item) => item.tracker !== "github")?.number ?? null;
}

/**
 * The work item a commit description served in `repository`: its `Issue:` trailer, else a closing
 * reference or `(#N)`. In a Build-tracked repository only its `Build:` trailer counts: any other `#N`
 * is a GitHub number, which a Build number is not.
 */
export function commitIssue(description: string | null | undefined, repository: string | null, tracker: Tracker = "github"): number | null {
  if (trackerIsBuild(tracker)) return buildTrailerItem(description);
  const issue = itemTrailers(description).find((item) => item.tracker === "github" && (!item.repository || item.repository === repository));
  if (issue) return issue.number;
  return originatingIssue(null, description);
}
