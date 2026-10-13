/** GitHub repository and Issue references a landing reads from remotes and descriptions. */

/** `owner/name` of a GitHub remote in `jj git remote list` output, preferring `preferred`. */
export function githubRepository(remoteList: string, preferred?: string | null): string | null {
  const remotes = remoteList.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 2)
    .map(([name, url]) => ({ name, repository: /github\.com[:/]([^\s/]+\/[^\s/]+?)(?:\.git)?\/?$/.exec(url!)?.[1] ?? null }))
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

/** `description` plus an `Issue: owner/repo#N` git trailer, unless it has no Issue or already names it. */
export function withIssueTrailer(description: string, issueNumber: number | null | undefined, repository: string | null): string {
  const text = (description ?? "").trimEnd();
  if (!Number.isInteger(issueNumber) || issueNumber! <= 0 || referencesIssue(text, issueNumber!)) return text;
  const trailer = `Issue: ${repository ?? ""}#${issueNumber}`;
  const paragraphs = text.split(/\n\s*\n/);
  const inTrailerBlock = paragraphs.length > 1 && paragraphs.at(-1)!.split("\n").every((line) => /^[A-Za-z][\w-]*: \S/.test(line));
  return `${text}${inTrailerBlock ? "\n" : "\n\n"}${trailer}`;
}

