/**
 * A Claude Code PreToolUse guard: in a repository governed by `slipjay.json`, the
 * integration branch moves and is published only through `slipjay land`, and a
 * declared release branch only through `slipjay promote`.
 * Pushing feature bookmarks for a pull request stays allowed.
 *
 * It also keeps work from being orphaned: in a secondary workspace of such a
 * repository, a command that moves `@` away from a non-empty, unintegrated commit
 * without a real description (`jj new`, `jj edit`, `jj workspace forget`, ...) is
 * refused until the work is described, abandoned or landed.
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { jjWorkspaceRoot, parseWorkspaceList, run } from "./workspace-jj.ts";
import { workspaceMetadata } from "./workspace-state.ts";
import { EXECUTION_POLICY_PROBE_PATHS, parseExecutionPolicy, selectExecutionPolicyPath } from "./execution-policy.ts";

type Governance = { branches: string[]; release: string | null; retired: string | null };
type Violation = [reason: string, branch: string | null];
type Checkout = { cwd: string; target: string; byName?: string };
type HookInput = { tool_name?: unknown; tool_input?: { command?: unknown } | null; cwd?: string | null };
type HookOutput = { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } };

const LAND = "Use `slipjay land` (or `--direct` in a Direct checkout): it verifies, integrates and pushes.";
const RELEASE = "Use `slipjay promote`: it verifies the exact candidate and publishes the release after human approval.";

/** The raw `integrationBranch` of an unparseable or refused policy text, if it names one. */
const rawBranch = (raw: string): string | null => {
  try { const declared = (JSON.parse(raw) as { integrationBranch?: unknown } | null)?.integrationBranch; return typeof declared === "string" && declared ? declared : null; } catch { return null; }
};

/**
 * Nearest policy above `cwd` and the branches it guards, or null when ungoverned.
 * A directory with only Slipway's retired `slipway.json` is refused, not read,
 * but still guarded (fail closed): `retired` carries the refusal for the deny reason.
 */
async function governance(cwd: string): Promise<Governance | null> {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const texts = new Map<string, string>();
    for (const candidate of EXECUTION_POLICY_PROBE_PATHS) {
      const text = await readFile(join(dir, candidate), "utf8").catch(() => null);
      if (text !== null) texts.set(candidate, text);
    }
    let found: string | null;
    try { found = await selectExecutionPolicyPath(async (candidate: string) => texts.has(candidate), dir); } catch (error) {
      const declared = rawBranch([...texts.values()][0]!);
      return { branches: [...new Set([...(declared ? [declared] : []), "main", "master"])], release: null, retired: (error as Error).message };
    }
    if (found !== null) {
      const raw = texts.get(found)!;
      let declared: string | null | undefined;
      let release: string | null = null;
      // An invalid policy still governs: keep guarding whatever branch it names.
      try {
        const policy = parseExecutionPolicy(raw, found);
        declared = policy.integrationBranch;
        release = policy.releaseBranch ?? null;
      } catch { declared = rawBranch(raw); }
      const integration = typeof declared === "string" && declared ? [declared] : ["main", "master"];
      return { branches: [...new Set([...integration, ...(release ? [release] : [])])], release, retired: null };
    }
    if (dirname(dir) === dir) return null;
  }
}

/** Nearest policy above `cwd` (`slipjay.json`), with its guarded branches; null when ungoverned. */
export async function governedBranches(cwd: string): Promise<string[] | null> {
  return (await governance(cwd))?.branches ?? null;
}

/** Split a shell line into simple commands' words; quoting is honoured, expansion is not attempted. */
export function simpleCommands(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: string | null = null;
  const endWord = (): void => { if (word) words.push(word); word = ""; };
  const endCommand = (): void => { endWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "\\" && i + 1 < line.length) word += line[++i];
    else if (char === "\n" || ";&|()`".includes(char) || (char === "$" && line[i + 1] === "(")) endCommand();
    else if (/\s/.test(char)) endWord();
    else word += char;
  }
  endCommand();
  // Leading environment assignments and wrappers do not change what runs.
  return commands.map((command) => {
    let start = 0;
    while (start < command.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command[start]!) || ["env", "command", "exec", "sudo", "nohup", "time"].includes(command[start]!))) start += 1;
    return command.slice(start);
  }).filter((command) => command.length);
}

/** Global options that take a value, per program. */
const VALUED: { git: string[]; jj: string[]; [name: string]: string[] } = {
  git: ["-C", "-c", "--git-dir", "--work-tree", "--namespace"],
  jj: ["-R", "--repository", "--config", "--config-file", "--at-op", "--at-operation", "--color"],
};

/** The subcommand and its arguments, past global options (and the values those options take). */
function subcommand(args: string[], valued: readonly string[]): string[] {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += valued.includes(args[i]!) ? 2 : 1;
  return args.slice(i);
}

const branchOf = (ref: string): string => ref.replace(/^\+/, "").split(":").pop()!.replace(/^refs\/heads\//, "");

/** A violation is `[reason, branch]`; the branch is null when the command is not specific to one. */
function gitViolation(args: string[], branches: readonly string[]): Violation | null {
  const [verb, ...rest] = subcommand(args, VALUED.git);
  if (verb === "push") {
    if (rest.some((arg) => ["--all", "--mirror", "--delete", "-d"].includes(arg))) return ["pushes every branch or deletes one", null];
    const refspecs = rest.filter((arg) => !arg.startsWith("-")).slice(1);
    if (!refspecs.length) return ["pushes the current branch, which may be the integration branch", null];
    const hit = refspecs.map(branchOf).find((branch) => branches.includes(branch));
    return hit ? [`pushes ${hit}`, hit] : null;
  }
  if (verb === "update-ref") {
    const hit = rest.map(branchOf).find((branch) => branches.includes(branch));
    return hit ? [`moves ${hit}`, hit] : null;
  }
  if (verb === "branch" && rest.some((arg) => /^-(?:f|D|m|M|-force|-delete|-move)/.test(arg))) {
    const hit = rest.find((arg) => branches.includes(arg));
    return hit ? [`rewrites ${hit}`, hit] : null;
  }
  return null;
}

const BOOKMARK_ACTIONS: Record<string, string> = { s: "set", set: "set", m: "move", move: "move", c: "create", create: "create",
  d: "delete", delete: "delete", f: "forget", forget: "forget", r: "rename", rename: "rename" };

function jjViolation(args: string[], branches: readonly string[]): Violation | null {
  const [verb, action, ...rest] = subcommand(args, VALUED.jj);
  if (verb === "git" && action === "push") {
    if (rest.some((arg) => ["--all", "--tracked", "--deleted"].includes(arg))) return ["pushes every tracked bookmark", null];
    const named: string[] = [];
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i]!;
      if (["-b", "--bookmark", "--named"].includes(arg)) named.push(rest[i + 1] ?? "");
      else if (/^--(?:bookmark|named)=/.test(arg)) named.push(arg.slice(arg.indexOf("=") + 1));
      else if (["-c", "--change", "-r", "--revisions"].includes(arg)) named.push("");
    }
    if (!named.length) return ["pushes tracked bookmarks, which include the integration branch", null];
    const hit = named.map((name) => name.split("=")[0]!).find((name) => branches.includes(name));
    return hit ? [`pushes ${hit}`, hit] : null;
  }
  const bookmarkAction = BOOKMARK_ACTIONS[action ?? ""];
  if ((verb === "bookmark" || verb === "b") && bookmarkAction) {
    const hit = rest.find((arg) => branches.includes(arg));
    return hit ? [`${bookmarkAction}s the ${hit} bookmark`, hit] : null;
  }
  return null;
}

/** Why one parsed command bypasses landing (or, for `releaseBranch`, release), or null. */
function commandBypass([program, ...args]: string[], branches: readonly string[], releaseBranch: string | null): string | null {
  const name = program!.split("/").pop();
  const violation: Violation | null = name === "git" ? gitViolation(args, branches)
    : name === "jj" ? jjViolation(args, branches)
    : name === "gh" && args[0] === "pr" && args[1] === "merge" ? ["merges a pull request into the integration branch", null]
    : null;
  return violation ? `This command ${violation[0]}. ${releaseBranch && violation[1] === releaseBranch ? RELEASE : LAND}` : null;
}

/**
 * Why this shell line bypasses landing (or, for `releaseBranch`, release) in a
 * repository guarding these branches, or null.
 */
export function landingBypass(line: string, branches: readonly string[], releaseBranch: string | null = null): string | null {
  for (const command of simpleCommands(line)) {
    const bypass = commandBypass(command, branches, releaseBranch);
    if (bypass) return bypass;
  }
  return null;
}

/** The option naming the repository a command runs against, per program. */
const TARGET: Record<string, string[]> = { git: ["-C"], jj: ["-R", "--repository"] };

/**
 * A path word the guard can resolve as written: plain path characters only
 * (no expansion, glob or redirection in bash or zsh), with `~` only as a leading `~` or `~/`.
 */
const literalPath = (word: string): boolean => /^[\w./~+@%,: -]+$/.test(word) && !word.slice(1).includes("~") && (!word.startsWith("~") || word === "~" || word.startsWith("~/"));

/** Whether a line sources a file, which could set git's repository variables unseen. */
const sourcesFile = (line: string): boolean => simpleCommands(line).some(([program]) => program === "." || program === "source");

/**
 * The directory a command runs against, or `cwd` when the guard cannot be sure:
 * git applies every `-C` before the subcommand in turn; jj takes its last `-R`
 * anywhere on the line (`-R <dir>`, `-R<dir>`, `--repository[=]<dir>`). A value
 * needing shell expansion, a git command that also names `--git-dir`,
 * `--work-tree` or a `GIT_*DIR`/`GIT_WORK_TREE` variable, and a line that sources
 * a file (which could set those) keep `cwd`: the old, closed answer.
 */
function targetDirectory(name: string, args: string[], cwd: string, line: string): string {
  const flags = TARGET[name];
  if (!flags) return cwd;
  if (name === "git" && (/\bGIT_(?:[A-Z_]*DIR|WORK_TREE)=/.test(line) || sourcesFile(line) || args.some((arg) => /^--(?:git-dir|work-tree)(?:=|$)/.test(arg)))) return cwd;
  const values: (string | undefined)[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (name === "git" && !arg.startsWith("-")) break;
    if (flags.includes(arg)) values.push(args[(i += 1)]);
    else if (arg.startsWith("--repository=") && name === "jj") values.push(arg.slice("--repository=".length));
    else if (name === "jj" && arg.startsWith("-R") && arg.length > 2) values.push(arg.slice(2));
    else if (!arg.includes("=") && VALUED[name]!.includes(arg)) i += 1;
  }
  if (!values.length) return cwd;
  if (values.some((value) => value === undefined || !literalPath(value))) return cwd;
  return name === "git"
    ? values.reduce<string>((dir, value) => resolve(dir, expandHome(value!)), cwd)
    : resolve(cwd, expandHome(values.at(-1)!));
}

const expandHome = (target: string): string => (target === "~" ? homedir() : target.startsWith("~/") ? join(homedir(), target.slice(2)) : target);

const ORPHAN_REMEDY = "Run `jj describe -m \"<what this change does>\"` to keep it, `jj abandon` to discard it, or `slipjay land` to ship it.";

/** The verbs that move `@` off its commit, in one place. */
const MOVING_VERBS: readonly (string | undefined)[] = ["new", "edit", "checkout", "co", "next", "prev"];

/**
 * The workspaces whose working copy a jj command would leave behind: `[]` for the
 * current one (`new`, `edit <rev>`, `checkout`, `next`/`prev`), the named ones for
 * `workspace forget` (the current one when none is named), null when it moves nothing.
 */
function abandonedWorkspaces(args: string[]): string[] | null {
  const [verb, ...rest] = subcommand(args, VALUED.jj);
  const operands = rest.filter((arg) => !arg.startsWith("-"));
  if (MOVING_VERBS.includes(verb)) return (verb === "new" && rest.includes("--no-edit")) || (verb === "edit" && operands.every((arg) => arg === "@")) ? null : [];
  if (verb === "workspace" && operands[0] === "forget") return operands.slice(1);
  return null;
}

/**
 * A deny reason when this jj command would abandon unfinished work in a SlipJay
 * workspace: `dir` is in a governed repository (a secondary workspace, unless the
 * command forgets named workspaces, which is judged from any checkout) and a workspace
 * the command leaves (or forgets) has a non-empty, unintegrated `@` that is undescribed
 * or still carries the description `start` generated. One jj query per workspace left,
 * run in that workspace's checkout so it snapshots its edits; fails open when jj cannot
 * be queried.
 */
async function orphanedWork(args: string[], dir: string, governed: Governance): Promise<string | null> {
  const leaves = abandonedWorkspaces(args);
  if (!leaves) return null;
  try {
    const root = await jjWorkspaceRoot(dir);
    // A secondary workspace's `.jj/repo` is a pointer file; the primary's is the repository directory.
    if (!root) return null;
    if (!leaves.length && !(await stat(join(root, ".jj", "repo"))).isFile()) return null;
    const integrated = governed.branches.map((branch) => `bookmarks(exact:${JSON.stringify(branch)})`).join(" | ");
    for (const { cwd, target, byName } of leaves.length ? await namedCheckouts(root, leaves) : [{ cwd: root, target: "@" }]) {
      let reason = await undescribedWork(cwd, target, integrated);
      // A checkout jj cannot read there (a stale working copy) is still judged by its last snapshot.
      if (reason === undefined && byName) reason = await undescribedWork(root, byName, integrated);
      if (reason) return reason;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Where to look at each named workspace's `@`: its own checkout, because edits made
 * there since its last snapshot are visible only to a jj command run inside it (which
 * snapshots it, as any jj command there would). A workspace without a checkout on
 * disk is read from `root` by name.
 */
async function namedCheckouts(root: string, names: string[]): Promise<Checkout[]> {
  const listed = await run("jj", ["--color=never", "--ignore-working-copy", "workspace", "list", "-T",
    'name ++ "\t" ++ root ++ "\t" ++ target.change_id() ++ "\t" ++ target.commit_id() ++ "\n"'], { cwd: root, timeoutMs: 15_000 });
  const workspaces = listed.code === 0 ? parseWorkspaceList(listed.stdout) : [];
  return names.map((name) => {
    const checkout = workspaces.find((entry) => entry.name === name)?.root;
    const byName = `${JSON.stringify(name)}@`;
    return checkout && existsSync(checkout) ? { cwd: checkout, target: "@", byName } : { cwd: root, target: byName };
  });
}

/** The deny reason when `target`, read from `cwd`, is unintegrated, non-empty and undescribed; null otherwise, undefined when jj fails. */
async function undescribedWork(cwd: string, target: string, integrated: string): Promise<string | null | undefined> {
  const queried = await run("jj", ["--color=never", "log", "-r", `(${target}) ~ ::(${integrated})`, "--no-graph", "-T",
    'working_copies ++ "\t" ++ empty ++ "\t" ++ description.first_line() ++ "\n"'], { cwd, timeoutMs: 15_000 });
  if (queried.code !== 0) return undefined;
  for (const row of queried.stdout.split("\n").filter(Boolean)) {
    const [copies, empty, description = ""] = row.split("\t");
    if (empty === "true") continue;
    const names = copies!.trim().split(/\s+/).filter((name) => name.endsWith("@")).map((name) => name.slice(0, -1));
    const generated = (await Promise.all(names.map(async (name) => (await workspaceMetadata(name))?.generatedDescription))).filter(Boolean);
    const placeholder = description.trim() !== "" && generated.includes(description.trim());
    if (description.trim() && !placeholder) continue;
    return `Workspace ${names.join(", ") || "here"} has a working-copy commit with changes that are not integrated and ${placeholder ? "only the generated `wip:` description" : "no description"}, and this command would leave them behind as an orphan. ${ORPHAN_REMEDY}`;
  }
  return null;
}

/**
 * Claude Code hook input → a deny decision, or null to let the call proceed.
 * Each command is judged by the repository it targets: `git -C <dir>` and
 * `jj -R <dir>` name it explicitly; otherwise it is the tool call's cwd. A `cd`
 * is not followed (subshells and failed `cd`s would make that unsound), so a
 * `cd` into another repository is still judged by the cwd: fail closed.
 */
export async function landingGuardDecision(input: unknown): Promise<HookOutput | null> {
  const hook = input as HookInput | null | undefined;
  if (hook?.tool_name !== "Bash" || typeof hook.tool_input?.command !== "string") return null;
  const cwd = hook.cwd ?? process.cwd();
  for (const command of simpleCommands(hook.tool_input.command)) {
    const [program, ...args] = command;
    const governed = await governance(targetDirectory(program!.split("/").pop()!, args, cwd, hook.tool_input.command));
    const bypass = governed && commandBypass(command, governed.branches, governed.release);
    let reason = bypass && governed.retired ? `${bypass} ${governed.retired}.` : bypass;
    if (!reason && governed && program!.split("/").pop() === "jj") reason = await orphanedWork(args, targetDirectory("jj", args, cwd, hook.tool_input.command), governed);
    if (reason) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
  }
  return null;
}
