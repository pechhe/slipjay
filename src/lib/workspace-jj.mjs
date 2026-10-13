import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { readExecutionPolicy, readIntegrationPolicy, UNDECLARED_POLICY } from "./execution-policy.mjs";
import { runWorkspaceCommand } from "./workspace-command.mjs";

/**
 * JJ repository facts every workspace operation starts from: the bounded command
 * runner, the current/integration workspace context and revision queries.
 */

export class CommandError extends Error {
  constructor(message, result) {
    super(message);
    this.result = result;
  }
}

export function explicitIssueNumber(value) {
  if (typeof value !== "string") return null;
  const match =
    value.match(
      /\b(?:implement|work on|fix|address|take on|continue(?: with)?|start)\b[\s\S]{0,80}?(?:github\s+)?issue\s*#?\s*(\d+)\b/i,
    ) ??
    value.match(
      /\b(?:implement|work on|fix|address|take on|continue(?: with)?|start)\b[\s\S]{0,40}?#(\d+)\b/i,
    );
  return match ? Number(match[1]) : null;
}

/**
 * Two-letter project code used in workspace names: the initials of the first two
 * words of the folder name (`peach-pi` → `pp`, `YardSmith` → `ys`), else its
 * first two letters (`slipjay` → `sl`).
 */
export function projectCode(folderName) {
  const words = folderName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`;
  return (words[0] ?? "").slice(0, 2).padEnd(2, "x");
}

/**
 * A repository's project code: its policy's `projectCode` when declared, so renaming
 * the checkout folder keeps workspace names stable, else derived from the folder name.
 */
export async function repositoryProjectCode(root) {
  const policy = await readExecutionPolicy(root).catch(() => null);
  return policy?.projectCode ?? projectCode(basename(root));
}

/** `pp-412` for an Issue, `pp-fix-toast` for a named task, `pp-a6f18e` otherwise. */
export function taskWorkspaceName(project, issueNumber, task) {
  if (issueNumber) return `${project}-${issueNumber}`;
  const slug = taskSlug(task);
  return slug ? `${project}-${slug}` : `${project}-${randomUUID().slice(0, 6).toLowerCase()}`;
}

/** At most 24 characters of the task's slug, cut at a word boundary where one exists. */
function taskSlug(task) {
  if (typeof task !== "string") return "";
  const full = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (full.length <= 24) return full;
  const cut = full.slice(0, 24);
  const atWord = full[24] === "-" ? cut : cut.replace(/-[^-]*$/, "");
  return (atWord || cut).replace(/-+$/, "");
}

/** The names an Issue's workspace had before project codes: `peach-pi-i412`. */
export function legacyIssueWorkspaceName(folderName, issueNumber) {
  return `${workspaceSlug(folderName, 24)}-i${issueNumber}`;
}

/** Bounded jj/git/gh runner with the landing command environment; see workspace-command. */
export const run = runWorkspaceCommand;

async function checked(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new CommandError(
      `${command} ${args.slice(0, 3).join(" ")} failed${detail ? `: ${detail}` : ""}`,
      result,
    );
  }
  return result.stdout.trim();
}

/** A checked `jj --color=never` call: its trimmed stdout, or a CommandError. */
export async function jj(cwd, args, options = {}) {
  return await checked("jj", ["--color=never", ...args], { cwd, ...options });
}

function unquoteWorkspaceName(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      // Keep the raw symbol if JJ emitted a non-JSON quoted value.
    }
  }
  return value;
}

export function parseWorkspaceList(output) {
  const entries = [];
  for (const line of output.split("\n").filter(Boolean)) {
    const [rawName, root = "", changeId, commitId] = line.split("\t");
    // Older JJ workspaces may have no root; rows without identity/target data
    // are not actionable and should not disable the whole extension.
    if (!rawName || !changeId || !commitId) continue;
    entries.push({ name: unquoteWorkspaceName(rawName), root, changeId, commitId });
  }
  return entries;
}

/** The nearest ancestor holding `.jj`, which is how `jj workspace root` resolves
 *  a checkout. Every workspace operation starts here, so it avoids a process. */
export async function jjWorkspaceRoot(cwd) {
  let dir;
  try { dir = await realpath(cwd); } catch { return null; }
  for (;;) {
    if (await stat(join(dir, ".jj")).then((entry) => entry.isDirectory(), () => false)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function sameDirectory(left, right) {
  if (!left || !right) return false;
  const [a, b] = await Promise.all([realpath(left).catch(() => resolve(left)), realpath(right).catch(() => resolve(right))]);
  return a === b;
}

export async function workspaceContext(cwd = process.cwd(), integratedBranch) {
  const currentRoot = await jjWorkspaceRoot(cwd);
  if (!currentRoot) return null;
  let output;
  try {
    output = await jj(cwd, [
      "--ignore-working-copy",
      "workspace",
      "list",
      "-T",
      'name ++ "\\t" ++ root ++ "\\t" ++ target.change_id() ++ "\\t" ++ target.commit_id() ++ "\\n"',
    ]);
  } catch {
    return null;
  }
  const workspaces = parseWorkspaceList(output);
  // An empty root is an unavailable checkout, never this process cwd.
  let current = null;
  for (const entry of workspaces) if (await sameDirectory(entry.root, currentRoot)) { current = entry; break; }
  if (!current) {
    // A workspace whose root JJ never recorded is recognised by its target.
    const target = await jj(cwd, ["--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "commit_id"]).catch(() => "");
    const matches = workspaces.filter((entry) => !entry.root && entry.commitId === target);
    if (matches.length === 1) current = { ...matches[0], root: currentRoot };
  }
  if (!current) return null;
  const integration = workspaces.find((entry) => entry.name === "default");
  if (!integration?.root) throw new Error("The canonical jj workspace named 'default' is missing or unavailable");
  if (integratedBranch) return { current, integration, integrationBranch: integratedBranch, configuration: { ...UNDECLARED_POLICY, integrationBranch: integratedBranch } };
  // D3: the policy committed on the integration bookmark, not the primary checkout's working files.
  const { integrationBranch, policy } = await readIntegrationPolicy(cwd, { hintRoot: integration.root });
  return { current, integration, integrationBranch, configuration: policy ?? UNDECLARED_POLICY };
}

export async function revisionExists(cwd, revision) {
  const result = await run(
    "jj",
    ["--color=never", "--ignore-working-copy", "log", "-r", revision, "--no-graph", "-T", '"ok"'],
    { cwd },
  );
  return result.code === 0 && result.stdout.includes("ok");
}

export async function revisionFacts(cwd, revision) {
  const output = await jj(cwd, ["log", "-r", revision, "--no-graph", "-T",
    'change_id ++ "\\t" ++ commit_id ++ "\\t" ++ empty ++ "\\t" ++ conflict ++ "\\t" ++ description.first_line() ++ "\\n"']);
  const [changeId, commitId, empty, conflict, description = ""] = output.split("\t");
  return {
    changeId,
    commitId,
    empty: empty === "true",
    conflict: conflict === "true",
    description,
  };
}

/** A lowercase, hyphenated workspace-name segment. */
export function workspaceSlug(value, limit = 40) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, limit) || "task"
  );
}

export async function issueTitle(repositoryRoot, issueNumber) {
  const result = await run(
    "gh",
    ["issue", "view", String(issueNumber), "--json", "title", "-q", ".title"],
    {
      cwd: repositoryRoot,
    },
  );
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

/** Stable short project prefix used in workspace names, e.g. "ys". */
export async function projectPrefix(cwd = process.cwd()) {
  const context = await workspaceContext(cwd);
  if (!context) return null;
  return repositoryProjectCode(context.integration.root);
}

/**
 * Whether the workspace holds non-empty commits the integration branch lacks.
 * Snapshots the working copy first unless `ignoreWorkingCopy`, for a caller that
 * has snapshotted once and must judge that one state (see `workingCopyCommit`).
 */
export async function workspaceHasUnintegratedWork(workspaceRoot, integrationBranch, { ignoreWorkingCopy = false } = {}) {
  const output = await jj(workspaceRoot, [
    ...(ignoreWorkingCopy ? ["--ignore-working-copy"] : []),
    "log",
    "-r",
    `(${integrationBranch}..@) & ~empty()`,
    "--no-graph",
    "-T",
    'commit_id.short() ++ "\\n"',
  ]);
  return Boolean(output.trim());
}

/** The workspace's working-copy commit id, snapshotting the on-disk tree first. */
export async function workingCopyCommit(workspaceRoot) {
  return jj(workspaceRoot, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
}

/** Issue state (`OPEN`/`CLOSED`) as `gh` reports it, or null when it cannot be read. */
export async function issueState(repositoryRoot, issueNumber) {
  const result = await run("gh", ["issue", "view", String(issueNumber), "--json", "state", "-q", ".state"],
    { cwd: repositoryRoot, timeoutMs: 20_000 });
  return result.code === 0 ? result.stdout.trim() || null : null;
}

/** The working-copy description `start` gives a new workspace: `wip: <task> (#<issue>)`. */
export function wipDescription(task, issueNumber) {
  const line = String(task ?? "").split("\n")[0].replace(/\s+/g, " ").trim().slice(0, 100);
  const issue = issueNumber && !line.includes(`#${issueNumber}`) ? ` (#${issueNumber})` : "";
  return `wip: ${line || "task"}${issue}`;
}
