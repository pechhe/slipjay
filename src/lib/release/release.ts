/**
 * `slipjay promote` (formerly `release`): promote the published integration branch to the release
 * branch its committed policy declares. `releaseIntegration` only plans, on the
 * author's machine: it names the candidate (the integration branch on the
 * remote), the base (the release branch on the remote), the commits between them,
 * and any migration artifacts.
 *
 * `confirmRelease` runs on the runner, in a checkout of its own, for the candidate
 * commit a human approved: it checks that exact commit out, runs
 * `requiredReleaseVerification`, builds the release merge, refuses unless its tree
 * is the verified tree, and publishes it. Verification runs beside the repository's
 * landings; the runner orders only publication against them and other releases.
 *
 * `verifyRelease` is that verification alone, run by the runner on a commit staging
 * deployed before anyone approves it (a pre-verification). A confirm of exactly that
 * commit, with the same checks and the release base unchanged, reuses its pass.
 *
 * jj commands ignore working copies, except checking the candidate out.
 */
import { readExecutionPolicyAtCommit } from "../policy/execution-policy.ts";
import { RequiredVerificationError, runRequiredVerification } from "../landing/required-verification.ts";
import { prepareWorkspaceDependencies } from "../workspace/workspace-dependencies.ts";
import { jj, run, workspaceContext } from "../infra/workspace-jj.ts";

import type { BoundedProcessRequest, BoundedProcessResult } from "../infra/bounded-process.ts";
import type { RunnerStage, VerificationOperation } from "../runner/runner-types.ts";
import type { VerificationDeclaration } from "../policy/verification-policy.ts";
import type { WorkspaceCommandResult } from "../infra/workspace-command.ts";

export type ReleasePlan = {
  root: string;
  remote: string;
  integrationBranch: string;
  releaseBranch: string;
  /** The release branch on the remote. */
  base: string;
  /** The integration commit being released. */
  candidate: string;
  commits: Array<{ commitId: string; subject: string }>;
  migrationArtifacts: string[];
  /** The candidate's `migrationFinalization.artifactPaths`: what counts as a migration artifact. */
  migrationPaths: string[];
  /** The migration artifacts not known to be additive: SQL that `nonAdditiveSql` flags or the release deletes, and any other file that is not JSON metadata. A failed promotion carrying one is not rolled back automatically. */
  nonAdditiveMigrations: string[];
  /** Every path the release changes. */
  paths: string[];
  checks: VerificationDeclaration[];
  /** The candidate declares a production deployment: it ships by promotion, from a commit staging is green on. */
  promotes: boolean;
  /** The candidate's production deployment declares `migrations`: the runner applies the promotion's migrations itself. */
  appliesMigrations: boolean;
  /** The candidate declares a nightly `audit`: a promotion waits on an unexplained failing one. */
  audits: boolean;
};

/**
 * What changed since the candidate the owner last approved, when the candidate has
 * moved past it without that approval shipping (a fix landed after verification
 * failed): the next ask shows only this.
 */
export type PromotionDelta = {
  since: string;
  commits: Array<{ commitId: string; subject: string }>;
  paths: string[];
  migrationArtifacts: string[];
};

/**
 * What the runner knows of a promotion: the newest commit staging is green on, the
 * candidates approved before, and its pre-verifications, each newest first.
 */
export type PromotionState = { stagingGreen: string | null; approved: string[]; verifications: VerificationOperation[];
  /** Every commit staging recorded a green deploy of, newest first; absent from a runner that does not list them (then only `stagingGreen`). */
  stagingGreenCommits?: string[];
  /** Why the audits refuse a promotion (see `promotionRefusal`), or null; absent from a runner that does not audit. */
  auditRefusal?: string | null };

/**
 * The candidate's pre-verification, as its newest pre-verification that was not
 * superseded or cancelled reports it. `passed` only for one against the plan's base
 * with the plan's checks, which a confirm reuses; a pass against anything else is `none`.
 */
export type ReleaseVerificationState = {
  status: "passed" | "failed" | "running" | "queued" | "none";
  commit: string;
  operationId: string | null;
  failedCommand?: string;
};

/**
 * Whether the owner's approval of `approvedCandidate`, which has not shipped, covers
 * this candidate: only when the changes since it add or change no migration artifact
 * and every commit among them names no work item, or only items the approved range
 * already names (`Build: #N` and `Issue:` trailers). `reasons` names each rule that
 * failed. Anything SlipJay cannot establish leaves it uncovered.
 */
export type ApprovalCoverage = { approvedCandidate: string | null; covered: boolean; reasons: string[] };

export type ReleaseSummary = {
  integrationBranch: string;
  releaseBranch: string;
  remote: string;
  base: string;
  candidate: string;
  commits: number;
  migrationArtifacts: string[];
  nonAdditiveMigrations: string[];
  paths: string[];
  checks: string[];
  /** Present when the candidate moved past an earlier approval that did not ship. */
  delta?: PromotionDelta;
};

/** What a promotion's plan adds: its candidate's pre-verification, and whether an earlier approval covers it. */
export type PromotionPlan = { verification?: ReleaseVerificationState; approval?: ApprovalCoverage;
  /** `requested` when `--candidate` chose an older staging-green commit; `newerGreen` then names the newer green commits it leaves out, newest first. */
  candidateSource?: "newest_green" | "requested"; newerGreen?: string[] };

export type ReleaseResult =
  | ({ ok: true; status: "up_to_date" } & ReleaseSummary & PromotionPlan)
  | ({ ok: true; status: "planned"; subjects: string[]; next: string } & ReleaseSummary & PromotionPlan)
  /** `verification` names the reused pre-verification as `preverified` when the confirm ran no checks of its own. */
  | ({ ok: true; status: "released"; merge: string; verification: unknown; releasedAt: string } & ReleaseSummary)
  /**
   * The release branch already contains the candidate (an earlier or newer
   * release shipped it), so the confirm verified nothing. `merge` is the release merge that first contained
   * it and `releasedBy` that merge's candidate. Without such a merge (the branch
   * was moved outside `slipjay promote`), `merge` is the release branch head and
   * `releasedBy` null. The summary describes the plan against that head, so
   * `commits` is 0.
   */
  | ({ ok: true; status: "released_by"; merge: string; releasedBy: string | null } & ReleaseSummary)
  | { ok: false; status: "refused"; reason: string }
  | { ok: false; status: "verification_failed"; reason: string; evidence: RequiredVerificationError["evidence"] };

/** A pre-verification's pass: `checks` ran on `candidate`'s tree while the release branch was at `base`. */
export type VerifiedRelease = { ok: true; status: "verified"; base: string; candidate: string; checks: VerificationDeclaration[]; nonAdditiveMigrations: string[] };

type VerifyOptions = Pick<ConfirmReleaseOptions, "onProgress" | "onStage" | "run" | "environment" | "abortSignal">;

export type ConfirmReleaseOptions = {
  /** The full candidate commit id a human approved. */
  candidate: string;
  /** Acknowledges that the release's migration artifacts are already applied where it deploys; refused for a promotion, which applies them on the runner. */
  migrationsReady?: boolean;
  onProgress?: (line: string) => void;
  onStage?: (stage: Extract<RunnerStage, "installing" | "verifying" | "publishing" | "finalizing">) => void;
  /** Where each verification command runs (the runner's executor). */
  run?: (request: BoundedProcessRequest) => Promise<BoundedProcessResult>;
  environment?: () => NodeJS.ProcessEnv;
  /** Once it fires, no later release check is scheduled: an owner kill stops verification at the check it reaches. */
  abortSignal?: AbortSignal;
  /**
   * Runs publication, which moves the release branch, once nothing else may move it (the
   * runner's repository lane). Its own recheck that the release branch is still the
   * planned base keeps a verification that ran beside other work valid.
   */
  exclusively?: <T>(publication: () => Promise<T>) => Promise<T>;
  /** The id of a passed pre-verification matching the plan (see `passedVerification`): the confirm reuses it instead of verifying. */
  preverified?: (plan: ReleasePlan) => string | null;
  /** Asked once nothing else may move the release branch, just before publishing: a reason refuses the release (an audit that failed meanwhile). */
  publicationRefusal?: () => string | null;
};

const COMMIT_PREFIX = /^[a-f0-9]{12,64}$/;
const NAME = String.raw`(?:"[^"]+"|\w+)`;
const TABLE = String.raw`(?:ONLY\s+)?(${NAME}(?:\s*\.\s*${NAME})?)`;
const unquote = (name: string): string => name.replaceAll('"', "").toLowerCase();
/** A table as `schema.name`, an unqualified one being in `public`. */
const qualify = (name: string): string => {
  const parts = (name.match(/"[^"]+"|\w+/g) ?? []).map(unquote);
  return parts.length > 1 ? `${parts[0]}.${parts[1]}` : `public.${parts[0]}`;
};
const CONSTRAINT_KINDS = String.raw`CONSTRAINT|UNIQUE|PRIMARY|FOREIGN|CHECK|EXCLUDE|LIKE`;
const COLUMN_TYPE = String.raw`::\s*\w+(?:\s+\w+)?`;
const LITERAL = String.raw`(?:''|-?\d+(?:\.\d+)?)(?:\s*${COLUMN_TYPE})?`;
/** What a CHECK holds, once outer parentheses are off, for the constraint to be an `IN` list over one column. */
const IN_LIST = new RegExp(String.raw`^\(?\s*(?:${NAME}\s*\.\s*)?${NAME}\s*(?:${COLUMN_TYPE})?\s*\)?\s*(?:${COLUMN_TYPE})?\s+IN\s*\(\s*${LITERAL}(?:\s*,\s*${LITERAL})*\s*\)$`, "i");
const SQL_WORDS = new Set(["and", "or", "not", "null", "is", "in", "like", "ilike", "between", "true", "false", "any", "all", "array", "case", "when", "then", "else", "end",
  "distinct", "from", "similar", "to", "unknown", "where", "include", "nulls", "first", "last", "asc", "desc"]);

/** `sql` as its statements, comments removed and dollar-quoted bodies (`DO $$ ... $$`) also as statements of their own. */
function splitSql(sql: string): string[] {
  const statements: string[] = [];
  const bodies: string[] = [];
  let current = "";
  for (let at = 0; at < sql.length;) {
    const char = sql[at]!;
    if (sql.startsWith("--", at)) {
      const end = sql.indexOf("\n", at);
      at = end < 0 ? sql.length : end;
    } else if (sql.startsWith("/*", at)) {
      const end = sql.indexOf("*/", at + 2);
      at = end < 0 ? sql.length : end + 2;
      current += " ";
    } else if (char === "'" || char === '"') {
      let end = at + 1;
      for (;;) {
        const close = sql.indexOf(char, end);
        if (close < 0) { end = sql.length; break; }
        end = close + 1;
        if (sql[end] !== char) break;
        end += 1;
      }
      current += sql.slice(at, end);
      at = end;
    } else if (char === "$" && !/\w/.test(sql[at - 1] ?? " ")) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(at, at + 64))?.[0];
      const close = tag ? sql.indexOf(tag, at + tag.length) : -1;
      if (tag && close >= 0) {
        bodies.push(sql.slice(at + tag.length, close));
        current += sql.slice(at, close + tag.length);
        at = close + tag.length;
      } else { current += char; at += 1; }
    } else if (char === ";") {
      statements.push(current);
      current = "";
      at += 1;
    } else { current += char; at += 1; }
  }
  statements.push(current);
  return [...statements, ...bodies.flatMap(splitSql)].filter((statement) => statement.trim());
}

/** `text` split at `separator` outside parentheses and quoted names. */
function splitTop(text: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === '"') at = Math.max(text.indexOf('"', at + 1), at);
    else if (char === separator && depth === 0) { parts.push(text.slice(from, at)); from = at + 1; }
  }
  return [...parts, text.slice(from)];
}

/** The text between the parenthesis at `open` and its match, and what follows it. */
function balanced(text: string, open: number): { inner: string; after: string } | null {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === "(") depth += 1;
    else if (text[at] === ")" && --depth === 0) return { inner: text.slice(open + 1, at), after: text.slice(at + 1) };
  }
  return null;
}

/** The columns a list names, as `"a", b DESC`; an expression names none, so it stands as `(expression)`. */
const columnList = (list: string): string[] => splitTop(list).map((entry) => {
  const column = /^\s*("[^"]+"|\w+)(?![\w(.:"])/.exec(entry);
  return column ? unquote(column[1]!) : "(expression)";
});

/** The columns an expression reads, without a table qualifier: not keywords, casts, function names or literals. */
const identifiers = (expression: string): string[] =>
  [...expression.replace(/(?:"[^"]+"|\b\w+)\s*\.\s*(?=["\w])/g, "").replace(new RegExp(String.raw`${COLUMN_TYPE}(?:\s*\([^)]*\))?(?:\[\])?`, "g"), " ").matchAll(/"[^"]+"|\b[a-z_]\w*\b(?!\s*\()/gi)]
    .map((match) => unquote(match[0])).filter((word) => !SQL_WORDS.has(word));

/** The columns an UPDATE assigns, from the text after its SET. */
function setTargets(rest: string): string[] {
  let end = rest.length;
  let depth = 0;
  for (let at = 0; at < rest.length; at += 1) {
    const char = rest[at];
    if (char === "(") depth += 1;
    else if (char === ")" && --depth < 0) { end = at; break; }
    else if (char === '"') at = Math.max(rest.indexOf('"', at + 1), at);
    else if (depth === 0 && !/\w/.test(rest[at - 1] ?? " ") && /^(?:WHERE|FROM|RETURNING)\b/i.test(rest.slice(at, at + 10))) { end = at; break; }
  }
  return splitTop(rest.slice(0, end)).flatMap((assignment) => {
    const list = /^\s*\(([^)]*)\)\s*=/.exec(assignment);
    if (list) return columnList(list[1]!);
    const single = new RegExp(String.raw`^\s*(?:${NAME}\s*\.\s*)?(${NAME})\s*=`).exec(assignment);
    return single ? [unquote(single[1]!)] : ["(unparsed)"];
  });
}

/** `statement` with string contents and dollar-quoted bodies emptied, so keywords inside them are not read as SQL. */
const blank = (statement: string): string =>
  statement.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\$(\w*)\$[\s\S]*?\$\1\$/g, (match) => match.startsWith("'") ? "''" : match.startsWith('"') ? match : "$$$$");

/**
 * A heuristic for SQL that code from before the migration may not survive: removing,
 * renaming or retyping something, deleting or rewriting rows, tightening what a table
 * that already existed accepts (a constraint, a unique index, a NOT NULL column without
 * a default or generation) or changing what it does (row-level security, a trigger, a
 * replaced function, an upsert, MERGE). It errs towards flagging, since a flag only
 * withholds an automatic rollback, but not where the earlier code cannot tell the
 * difference: tables the migration creates (temporary ones too), columns it adds (earlier
 * code never writes them, so each holds its default) and constraints or unique indexes
 * over only those, a CHECK dropped and added back under the same name as an `IN (...)` list
 * over one column (an enum that gained a value; the migration cannot show the old list,
 * and a value it removed fails the constraint if any row holds it), `ON COMMIT DROP`,
 * `DROP NOT NULL`. Tables are told apart by schema; an unqualified one is in `public`.
 *
 * Returns the statements that make `sql` non-additive.
 */
export function nonAdditiveStatements(sql: string): string[] {
  const statements = splitSql(sql).map((text) => {
    const code = blank(text).replace(/\bON\s+COMMIT\s+DROP\b/gi, "");
    const alter = new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?${TABLE}`, "i").exec(code);
    return { text, code, table: alter ? qualify(alter[1]!) : null, clauses: alter ? splitTop(code.slice(alter.index + alter[0].length)) : [] };
  });
  const created = new Set(statements.flatMap(({ code }) =>
    [...code.matchAll(new RegExp(String.raw`\bCREATE\s+(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY)\s+|UNLOGGED\s+)?TABLE\s+(?!IF\s+NOT\s+EXISTS\b)${TABLE}`, "gi"))].map((match) => qualify(match[1]!))));
  const added = new Map<string, Set<string>>();
  const dropped = new Set<string>();
  const checkedIn = new Set<string>();
  for (const { table, clauses } of statements) {
    for (const clause of table ? clauses : []) {
      const column = new RegExp(String.raw`^\s*ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!(?:${CONSTRAINT_KINDS})\b)(${NAME})`, "i").exec(clause);
      if (column) added.set(table!, (added.get(table!) ?? new Set()).add(unquote(column[1]!)));
      const drop = new RegExp(String.raw`^\s*DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(${NAME})`, "i").exec(clause);
      if (drop) dropped.add(`${table}.${unquote(drop[1]!)}`);
      const check = new RegExp(String.raw`^\s*ADD\s+CONSTRAINT\s+(${NAME})\s+CHECK\s*\(([\s\S]*)\)\s*(?:NOT\s+VALID\s*)?$`, "i").exec(clause);
      if (check && IN_LIST.test(check[2]!.trim())) checkedIn.add(`${table}.${unquote(check[1]!)}`);
    }
  }
  const widened = new Set([...checkedIn].filter((constraint) => dropped.has(constraint)));
  const existing = (table: string | null): boolean => table !== null && !created.has(table);
  const addedOnly = (table: string, columns: string[]): boolean => columns.length > 0 && columns.every((column) => added.get(table)?.has(column));
  const risky = ({ code, table, clauses }: (typeof statements)[number]): boolean => {
    const bare = code.replace(/"[^"]*"/g, "_q");
    if (/\b(?:TRUNCATE|RENAME|MERGE)\b|\bVALIDATE\s+CONSTRAINT\b|\bROW\s+LEVEL\s+SECURITY\b|\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:POLICY|(?:CONSTRAINT\s+)?TRIGGER)\b|\bCREATE\s+OR\s+REPLACE\s+(?:FUNCTION|PROCEDURE)\b/i.test(bare)) return true;
    if (/\bDROP\s+(?!CONSTRAINT\b|NOT\s+NULL\b)\w+/i.test(bare)) return true;
    if ([...code.matchAll(new RegExp(String.raw`\bDELETE\s+FROM\s+${TABLE}`, "gi"))].some((match) => existing(qualify(match[1]!)))) return true;
    for (const update of code.matchAll(new RegExp(String.raw`\bUPDATE\s+${TABLE}(?:\s+(?:AS\s+)?(?!SET\b)${NAME})?\s+SET\b`, "gi"))) {
      const name = qualify(update[1]!);
      if (existing(name) && !addedOnly(name, setTargets(code.slice(update.index + update[0].length)))) return true;
    }
    const insert = new RegExp(String.raw`\bINSERT\s+INTO\s+${TABLE}`, "i").exec(code);
    if (insert && existing(qualify(insert[1]!)) && /\bON\s+CONFLICT\b[\s\S]*?\bDO\s+UPDATE\b/i.test(bare)) return true;
    const index = new RegExp(String.raw`\bCREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:${NAME}\s+)?ON\s+${TABLE}(?:\s+USING\s+\w+)?\s*\(`, "i").exec(code);
    if (index && existing(qualify(index[1]!))) {
      const list = balanced(code, index.index + index[0].length - 1);
      if (!list || !addedOnly(qualify(index[1]!), columnList(list.inner))) return true;
      const rest = identifiers(list.after.replace(/\bINCLUDE\s*\(/gi, "("));
      if (rest.some((column) => !added.get(qualify(index[1]!))?.has(column))) return true;
    }
    if (!existing(table)) return false;
    return clauses.some((clause) => {
      const plain = clause.replace(/"[^"]*"/g, "_q");
      const drop = new RegExp(String.raw`^\s*DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(${NAME})`, "i").exec(clause);
      if (drop && !widened.has(`${table}.${unquote(drop[1]!)}`)) return true;
      if (/^\s*ALTER\s+(?:COLUMN\s+)?\w+\s+(?:SET\s+DATA\s+TYPE|TYPE|SET\s+NOT\s+NULL)\b/i.test(plain)) return true;
      if (new RegExp(String.raw`^\s*ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!(?:${CONSTRAINT_KINDS})\b)`, "i").test(plain))
        return /\bNOT\s+NULL\b/i.test(plain) && !/\b(?:DEFAULT|GENERATED)\b/i.test(plain);
      const constraint = new RegExp(String.raw`^\s*ADD\s+(?:CONSTRAINT\s+(${NAME})\s+)?(CHECK|UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|EXCLUDE)\b`, "i").exec(clause);
      if (!constraint) return false;
      const kind = constraint[2]!.toUpperCase();
      if (kind === "EXCLUDE") return true;
      if (kind === "CHECK") {
        if (constraint[1] && widened.has(`${table}.${unquote(constraint[1])}`)) return false;
        const columns = identifiers(clause.slice(constraint[0].length));
        return !columns.length || columns.some((column) => !added.get(table!)?.has(column));
      }
      const open = clause.slice(constraint[0].length).match(/^\s*\(/);
      const list = open ? balanced(clause, constraint[0].length + open[0].length - 1) : null;
      return !list || !addedOnly(table!, columnList(list.inner));
    });
  };
  return statements.filter(risky).map(({ text }) => text.trim());
}
export const nonAdditiveSql = (sql: string): boolean => nonAdditiveStatements(sql).length > 0;
const CANDIDATE_TRAILER = "Release-Candidate: ";

class ReleaseRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseRefusal";
  }
}
const refuse: (message: string) => never = (message) => { throw new ReleaseRefusal(message); };

const jjRun = (cwd: string, args: string[]): Promise<WorkspaceCommandResult> => run("jj", ["--color=never", "--ignore-working-copy", ...args], { cwd });

async function jjOut(cwd: string, args: string[]): Promise<string> {
  const result = await jjRun(cwd, args);
  if (result.code !== 0) throw new Error(`jj ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

const lines = (text: string): string[] => text.split("\n").filter(Boolean);
const commitIds = async (cwd: string, revset: string): Promise<string[]> => lines(await jjOut(cwd, ["log", "--no-graph", "-r", revset, "-T", 'commit_id ++ "\\n"']));
const symbol = (name: string): string => JSON.stringify(name);

async function commitOf(cwd: string, revset: string): Promise<string | null> {
  const result = await jjRun(cwd, ["log", "--no-graph", "-r", revset, "-T", 'commit_id ++ "\\n"']);
  const ids = result.code === 0 ? lines(result.stdout) : [];
  return ids.length === 1 ? ids[0]! : null;
}

/** Whether `file` is one of `paths` or lies under one. */
const under = (paths: string[], file: string): boolean => paths.some((path) => file === path || file.startsWith(`${path}/`));
const short = (commit: string): string => commit.slice(0, 12);

const fetch = (cwd: string, remote: string, branch: string): Promise<WorkspaceCommandResult> => jjRun(cwd, ["git", "fetch", "--remote", remote, "--branch", branch]);

/**
 * What a release from `cwd`'s repository would publish. `candidate` pins a commit
 * id (or 12+ character prefix) that must already be published on the integration
 * branch; by default the candidate is the integration branch on the remote.
 */
export async function planRelease(cwd = process.cwd(), { candidate: pinned }: { candidate?: string } = {}): Promise<ReleasePlan> {
  const context = await workspaceContext(cwd);
  if (!context) refuse(`Not inside a Jujutsu repository: ${cwd}`);
  const root = context.current.root;
  const integrationBranch = context.integrationBranch;
  const remote = context.configuration.remote;
  if (!remote) refuse("slipjay.json declares no publication remote; a release publishes the release branch to it");

  const fetched = await fetch(root, remote, integrationBranch);
  if (fetched.code !== 0) refuse(`Could not fetch ${integrationBranch} from ${remote}: ${fetched.stderr.trim()}`);
  const published = `${symbol(integrationBranch)}@${symbol(remote)}`;
  if (pinned !== undefined && !COMMIT_PREFIX.test(pinned)) refuse("The release candidate must be a commit id or a prefix of at least 12 hex characters");
  const candidate = await commitOf(root, pinned ?? published);
  if (!candidate) refuse(pinned ? `No single commit matches ${pinned}` : `${integrationBranch}@${remote} does not exist`);
  if (!await commitOf(root, `${candidate} & ::${published}`)) refuse(`${candidate} is not published on ${integrationBranch}@${remote}`);

  // The candidate's own committed policy decides what a release of it requires.
  const { policy } = await readExecutionPolicyAtCommit(root, candidate);
  const releaseBranch = policy?.releaseBranch;
  if (!releaseBranch) refuse(`slipjay.json at ${candidate.slice(0, 12)} declares no releaseBranch`);
  const checks = policy.requiredReleaseVerification;
  if (!checks) refuse(`slipjay.json at ${candidate.slice(0, 12)} declares no requiredReleaseVerification (declare [] to release without checks)`);

  const fetchedRelease = await fetch(root, remote, releaseBranch);
  if (fetchedRelease.code !== 0) refuse(`Could not fetch ${releaseBranch} from ${remote}: ${fetchedRelease.stderr.trim()}`);
  const base = await commitOf(root, `${symbol(releaseBranch)}@${symbol(remote)}`);
  if (!base) refuse(`${releaseBranch}@${remote} does not exist; publish the release branch once before releasing to it`);

  const commits = lines(await jjOut(root, ["log", "--no-graph", "-r", `::${candidate} ~ ::${base}`,
    "-T", 'commit_id ++ "\\t" ++ description.first_line().escape_json() ++ "\\n"'])).map((line) => {
    const [commitId, encoded] = line.split("\t");
    return { commitId: commitId!, subject: JSON.parse(encoded!) as string };
  });
  const artifactPaths = policy.migrationFinalization?.artifactPaths ?? [];
  const changed = commits.length ? lines(await jjOut(root, ["diff", "--from", base, "--to", candidate, "--name-only"])) : [];
  const migrationArtifacts = changed.filter((file) => under(artifactPaths, file));
  const nonAdditiveMigrations: string[] = [];
  // JSON beside a migration is metadata (Drizzle's snapshots and journal), not a migration.
  // Any other file that is not SQL cannot be read for additivity, so it is not known to be additive.
  for (const file of migrationArtifacts.filter((name) => !name.endsWith(".json"))) {
    if (!file.endsWith(".sql")) {
      nonAdditiveMigrations.push(file);
      continue;
    }
    const shown = await jjRun(root, ["file", "show", "-r", candidate, "--", `root-file:${symbol(file)}`]);
    // A migration the release deletes is not additive either.
    if (shown.code !== 0 || nonAdditiveSql(shown.stdout)) nonAdditiveMigrations.push(file);
  }
  const production = policy.deployments?.environments.production;
  return { root, remote, integrationBranch, releaseBranch, base, candidate, commits, migrationArtifacts, migrationPaths: artifactPaths, nonAdditiveMigrations, paths: changed, checks,
    promotes: Boolean(production), appliesMigrations: Boolean(production?.migrations), audits: Boolean(policy.audit) };
}

/** The newest of `approved` the release branch does not hold: approvals it holds shipped. */
async function unshippedApproval(plan: ReleasePlan, approved: string[]): Promise<string | null> {
  const released = `${symbol(plan.releaseBranch)}@${symbol(plan.remote)}`;
  for (const since of approved) if (!await commitOf(plan.root, `${since} & ::${released}`)) return since;
  return null;
}

const descendsFrom = async (plan: ReleasePlan, since: string): Promise<boolean> => Boolean(await commitOf(plan.root, `${since} & ::${plan.candidate}`));

/**
 * The changes since the newest of `approved` that the candidate has moved past and
 * the release branch does not yet hold; null when there is none (a first ask, or a
 * re-ask of the same candidate, shows the whole release).
 */
export async function promotionDelta(plan: ReleasePlan, approved: string[]): Promise<PromotionDelta | null> {
  const since = await unshippedApproval(plan, approved);
  if (!since || since === plan.candidate || !await descendsFrom(plan, since)) return null;
  const delta = new Set(await commitIds(plan.root, `::${plan.candidate} ~ ::${since}`));
  const paths = lines(await jjOut(plan.root, ["diff", "--from", since, "--to", plan.candidate, "--name-only"]));
  return { since, commits: plan.commits.filter((commit) => delta.has(commit.commitId)),
    paths, migrationArtifacts: plan.migrationArtifacts.filter((file) => paths.includes(file)) };
}

/** The work items a commit description names in its `Build:` and `Issue:` trailer lines, as written. */
const workItems = (description: string): string[] =>
  [...description.matchAll(/^(Build|Issue):[ \t]*(\S.*?)[ \t]*$/gm)].map((match) => `${match[1]}: ${match[2]}`);

async function describedCommits(root: string, revset: string): Promise<Array<{ commitId: string; description: string }>> {
  return lines(await jjOut(root, ["log", "--no-graph", "-r", revset, "-T", 'commit_id ++ "\\t" ++ description.escape_json() ++ "\\n"'])).map((line) => {
    const [commitId, encoded] = line.split("\t");
    return { commitId: commitId!, description: JSON.parse(encoded!) as string };
  });
}

/** See `ApprovalCoverage`. A re-ask of exactly the approved candidate is covered. */
export async function approvalCoverage(plan: ReleasePlan, approved: string[]): Promise<ApprovalCoverage> {
  const since = await unshippedApproval(plan, approved);
  if (!since) return { approvedCandidate: null, covered: false, reasons: ["No earlier approval that has not shipped"] };
  const uncovered = (reasons: string[]): ApprovalCoverage => ({ approvedCandidate: since, covered: false, reasons });
  if (since === plan.candidate) return { approvedCandidate: since, covered: true, reasons: [] };
  try {
    if (!await descendsFrom(plan, since)) return uncovered([`${short(plan.candidate)} does not descend from the approved ${short(since)}`]);
    const reasons: string[] = [];
    const approvedItems = new Set((await describedCommits(plan.root, `::${since} ~ ::${plan.base}`)).flatMap((commit) => workItems(commit.description)));
    for (const commit of await describedCommits(plan.root, `::${plan.candidate} ~ ::${since}`)) {
      const named = `${short(commit.commitId)} (${commit.description.split("\n")[0]})`;
      // Each commit's own changes, so a migration a later commit reverts still counts.
      const migrations = lines(await jjOut(plan.root, ["diff", "-r", commit.commitId, "--name-only"])).filter((file) => under(plan.migrationPaths, file));
      if (migrations.length) reasons.push(`${named} adds or changes migration artifacts: ${migrations.join(", ")}`);
      const unapproved = workItems(commit.description).filter((item) => !approvedItems.has(item));
      if (unapproved.length) reasons.push(`${named} names ${unapproved.join(", ")}, which the approved range does not`);
    }
    return { approvedCandidate: since, covered: reasons.length === 0, reasons };
  } catch (error) {
    return uncovered([`Could not compare the candidate with the approved ${short(since)}: ${error instanceof Error ? error.message : String(error)}`]);
  }
}

/** The candidate's newest pre-verification that was not superseded or cancelled. */
const currentVerification = (plan: ReleasePlan, operations: VerificationOperation[]): VerificationOperation | undefined =>
  operations.find((operation) => operation.commitId === plan.candidate && operation.status !== "superseded" && operation.status !== "cancelled");

/** The candidate's current pre-verification, when it passed against the plan's base with the plan's checks: what a confirm may reuse. */
export function passedVerification(plan: ReleasePlan, operations: VerificationOperation[]): VerificationOperation | undefined {
  const current = currentVerification(plan, operations);
  return current?.result?.type === "verified" && current.result.base === plan.base
    && JSON.stringify(current.result.checks) === JSON.stringify(plan.checks) ? current : undefined;
}

/** See `ReleaseVerificationState`. */
export function verificationState(plan: ReleasePlan, operations: VerificationOperation[]): ReleaseVerificationState {
  const current = currentVerification(plan, operations);
  const state = (status: ReleaseVerificationState["status"]): ReleaseVerificationState => ({ status, commit: plan.candidate, operationId: status === "none" ? null : current!.id });
  if (!current) return state("none");
  if (current.status === "queued" || current.status === "running") return state(current.status);
  if (passedVerification(plan, operations)) return state("passed");
  if (current.result?.type === "failed") return { ...state("failed"), ...current.result.command ? { failedCommand: current.result.command } : {} };
  return state("none");
}

/** The release merge on the release branch that first shipped `plan.candidate`, and its candidate. */
async function shippedBy(plan: ReleasePlan): Promise<{ merge: string; releasedBy: string | null }> {
  const released = `${symbol(plan.releaseBranch)}@${symbol(plan.remote)}`;
  const [found] = await commitIds(plan.root,
    `roots(merges() & ${plan.candidate}:: & ::${released} & description(substring:${symbol(CANDIDATE_TRAILER)}))`);
  const merge = found ?? plan.base;
  const description = await jjOut(plan.root, ["log", "--no-graph", "-r", merge, "-T", "description"]);
  return { merge, releasedBy: description.match(/^Release-Candidate: ([a-f0-9]+)$/m)?.[1] ?? null };
}

const releaseMessage = (plan: ReleasePlan): string =>
  `Release ${plan.integrationBranch} to ${plan.releaseBranch}\n\n${CANDIDATE_TRAILER}${plan.candidate}\n`;
const mergeRevset = (plan: ReleasePlan): string =>
  `children(${plan.base}) & children(${plan.candidate}) & description(substring:${symbol(`${CANDIDATE_TRAILER}${plan.candidate}`)})`;

/** Build the release merge; refuse unless it is conflict-free and its tree is the candidate's. */
async function buildMerge(plan: ReleasePlan): Promise<string> {
  // Discard an unpublished merge left by an interrupted attempt.
  for (const stale of await commitIds(plan.root, mergeRevset(plan))) await jjRun(plan.root, ["abandon", stale]);
  await jjOut(plan.root, ["new", "--no-edit", "-m", releaseMessage(plan), plan.base, plan.candidate]);
  const merges = await commitIds(plan.root, mergeRevset(plan));
  if (merges.length !== 1) refuse(`Expected one release merge, found ${merges.length}`);
  const [merge] = merges;
  const conflicted = await jjOut(plan.root, ["log", "--no-graph", "-r", merge!, "-T", 'if(conflict, "conflict", "")']);
  const differs = lines(await jjOut(plan.root, ["diff", "--from", plan.candidate, "--to", merge!, "--name-only"]));
  if (conflicted || differs.length) {
    await jjRun(plan.root, ["abandon", merge!]);
    refuse(`The release merge is not the verified tree (${conflicted ? "it conflicts" : `it also changes ${differs.slice(0, 10).join(", ")}`}): `
      + `${plan.releaseBranch} has changes ${plan.integrationBranch} lacks. Integrate them into ${plan.integrationBranch} first.`);
  }
  return merge!;
}

/** Move the release bookmark to the merge and push it; jj refuses if the remote moved since the fetch. */
async function publish(plan: ReleasePlan, merge: string): Promise<void> {
  const bookmark = symbol(plan.releaseBranch);
  await jjRun(plan.root, ["bookmark", "track", `${bookmark}@${symbol(plan.remote)}`]);
  await jjOut(plan.root, ["bookmark", "set", plan.releaseBranch, "-r", merge]);
  const pushed = await jjRun(plan.root, ["git", "push", "--remote", plan.remote, "--bookmark", plan.releaseBranch]);
  await fetch(plan.root, plan.remote, plan.releaseBranch);
  if (await commitOf(plan.root, `${merge} & ::${bookmark}@${symbol(plan.remote)}`)) return;
  await jjRun(plan.root, ["bookmark", "set", plan.releaseBranch, "--allow-backwards", "-r", `${bookmark}@${symbol(plan.remote)}`]);
  await jjRun(plan.root, ["abandon", merge]);
  refuse(`Push of ${plan.releaseBranch} to ${plan.remote} failed: ${(pushed.stderr || pushed.stdout).trim() || "the remote does not contain the release"}`);
}

/**
 * Undo a published release whose production deploy failed: move the release branch from
 * `merge` back to its first parent, the release branch before it. Refused, moving
 * nothing, when the release branch has moved on since (a later release). `checkout` need
 * not hold the merge, which it fetches: the policy comes from the released `candidate`,
 * whose tree the merge's is.
 */
export async function returnRelease(checkout: string, { merge, candidate }: { merge: string; candidate: string }): Promise<{ returned: true; releaseBranch: string } | { returned: false; reason: string }> {
  try {
    const { policy } = await readExecutionPolicyAtCommit(checkout, candidate);
    const releaseBranch = policy?.releaseBranch;
    const remote = policy?.remote;
    if (!releaseBranch || !remote) refuse(`slipjay.json at ${candidate.slice(0, 12)} declares no release branch and remote`);
    const fetched = await fetch(checkout, remote, releaseBranch);
    if (fetched.code !== 0) refuse(`Could not fetch ${releaseBranch}: ${fetched.stderr.trim()}`);
    const published = `${symbol(releaseBranch)}@${symbol(remote)}`;
    const head = await commitOf(checkout, published);
    if (head !== merge) refuse(`${releaseBranch} has moved on to ${head?.slice(0, 12) ?? "nothing"} since the release merge ${merge.slice(0, 12)}`);
    const [before] = lines(await jjOut(checkout, ["log", "--no-graph", "-r", merge, "-T", 'parents.map(|c| c.commit_id()).join("\\n")']));
    if (!before) refuse(`The release merge ${merge.slice(0, 12)} has no parent`);
    await jjRun(checkout, ["bookmark", "track", published]);
    await jjOut(checkout, ["bookmark", "set", releaseBranch, "--allow-backwards", "-r", before]);
    // jj pushes only if the remote still holds the merge it fetched.
    const pushed = await jjRun(checkout, ["git", "push", "--remote", remote, "--bookmark", releaseBranch]);
    await fetch(checkout, remote, releaseBranch);
    if (await commitOf(checkout, published) !== before) {
      await jjRun(checkout, ["bookmark", "set", releaseBranch, "--allow-backwards", "-r", published]);
      refuse(`Push of ${releaseBranch} failed: ${(pushed.stderr || pushed.stdout).trim()}`);
    }
    return { returned: true, releaseBranch: before };
  } catch (error) {
    return { returned: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The result fields describing `plan`. */
function describePlan(plan: ReleasePlan): ReleaseSummary {
  return { integrationBranch: plan.integrationBranch, releaseBranch: plan.releaseBranch, remote: plan.remote,
    base: plan.base, candidate: plan.candidate, commits: plan.commits.length, migrationArtifacts: plan.migrationArtifacts,
    nonAdditiveMigrations: plan.nonAdditiveMigrations, paths: plan.paths,
    checks: plan.checks.map((check) => [check.executable, ...check.args].join(" ")) };
}

/**
 * Refuse a release carrying migration artifacts that its approver has not marked as
 * applied. A promotion's migrations are the runner's to apply, so it refuses the mark,
 * and refuses migration artifacts its production deployment declares no way to apply.
 */
function requireMigrationsReady(plan: ReleasePlan, migrationsReady: boolean): void {
  if (plan.promotes) {
    if (migrationsReady) refuse(`${plan.candidate.slice(0, 12)} ships by promotion, whose migrations the runner applies before production activates: confirm without --migrations-ready`);
    if (plan.migrationArtifacts.length && !plan.appliesMigrations)
      refuse(`This promotion carries migration artifacts (${plan.migrationArtifacts.join(", ")}), but slipjay.json at ${plan.candidate.slice(0, 12)} declares no deployments production migrations to apply them`);
    return;
  }
  if (plan.migrationArtifacts.length && !migrationsReady) {
    refuse(`This release carries migration artifacts (${plan.migrationArtifacts.join(", ")}). Apply them where ${plan.releaseBranch} deploys, then rerun with --migrations-ready.`);
  }
}

/** Appended to the staging refusals: a human promotion needs staging, a development-mode repository's runner does not. */
const DEVELOPMENT_HINT = ' In `process: "development"` the runner skips staging and promotes by itself.';

/** Every commit staging is green on, newest first. */
const greenCommits = ({ stagingGreen, stagingGreenCommits }: PromotionState): string[] =>
  stagingGreenCommits?.length ? stagingGreenCommits : stagingGreen ? [stagingGreen] : [];

/** The one green commit `requested` (an id or 12+ character prefix) names, or the refusal that staging never deployed it green. */
function requestedGreen(green: string[], requested: string, listed: boolean): string {
  if (!COMMIT_PREFIX.test(requested)) refuse("The release candidate must be a commit id or a prefix of at least 12 hex characters");
  const matches = green.filter((commit) => commit.startsWith(requested));
  if (matches.length > 1) refuse(`${requested} matches more than one commit staging is green on`);
  if (!matches[0] && !listed) refuse(`Staging recorded no green deploy of ${requested.slice(0, 12)} among the commits this runner lists: it is too old to list older green commits, so only the newest (${short(green[0]!)}) can be chosen`);
  if (!matches[0]) refuse(`Staging recorded no green deploy of ${requested.slice(0, 12)}: production promotes only a commit staging deployed.${DEVELOPMENT_HINT}`);
  return matches[0];
}

/**
 * A promoted candidate must be a prefix of integration history that is not behind the release: it contains every
 * integration commit the release branch already holds. (The release branch tip is a release merge, which no integration
 * commit descends from, so "descends from the tip" cannot be asked literally.)
 */
async function requireReleasePrefix(plan: ReleasePlan): Promise<void> {
  const published = `${symbol(plan.integrationBranch)}@${symbol(plan.remote)}`;
  const missing = await commitIds(plan.root, `(::${plan.base} & ::${published}) ~ ::${plan.candidate}`);
  if (missing.length)
    refuse(`${short(plan.candidate)} does not contain everything ${plan.releaseBranch}@${plan.remote} ${short(plan.base)} already holds from ${plan.integrationBranch} (such as ${short(missing[0]!)}): it is older than the release or on another line, so it is not a prefix of the history to release`);
}

const refusalOf = (error: unknown): ReleaseResult => {
  if (error instanceof ReleaseRefusal) return { ok: false, status: "refused", reason: error.message };
  if (error instanceof RequiredVerificationError) return { ok: false, status: "verification_failed", reason: error.message, evidence: error.evidence };
  throw error;
};

/**
 * Plan a release; publishes nothing. The candidate is the integration branch on the
 * remote, unless that commit declares a production deployment: then it is the newest
 * commit staging is green on, read through `readPromotion` (the runner), and the plan
 * carries the delta since an earlier approval the candidate has moved past. `candidate` names an
 * older commit staging is green on instead (a prefix of integration history not behind the release branch); every other rule applies to it as to the newest. Any audited
 * repository's plan is refused while its latest audit failed with no recorded cause.
 */
export async function releaseIntegration(cwd = process.cwd(), { readPromotion, candidate: requested, requestVerification }: {
  readPromotion?: () => Promise<PromotionState>;
  /** A staging-green commit (id or 12+ character prefix) to release instead of the newest one. */
  candidate?: string;
  /** Asks the runner to pre-verify a requested commit that has no pre-verification; the plan then reads the state again. */
  requestVerification?: (commit: string) => Promise<void>;
} = {}): Promise<ReleaseResult> {
  try {
    let plan = await planRelease(cwd);
    let promotion: Pick<ReleaseSummary, "delta"> & PromotionPlan = {};
    if (requested !== undefined && !plan.promotes)
      refuse(`--candidate chooses among the commits staging is green on, and ${plan.releaseBranch} does not ship by promotion (no production deployment in slipjay.json): drop --candidate`);
    if (plan.promotes) {
      if (!readPromotion) refuse(`${plan.candidate.slice(0, 12)} ships by promotion, which reads staging from the runner: set SLIPJAY_RUNNER or "runner" in ~/.slipjay/config.json`);
      let state = await readPromotion();
      const green = greenCommits(state);
      if (!green.length) refuse("Staging is green on no commit yet: production promotes only a commit staging deployed." + DEVELOPMENT_HINT);
      let candidateSource: NonNullable<PromotionPlan["candidateSource"]> = "newest_green";
      if (requested === undefined) {
        if (green[0] !== plan.candidate) plan = await planRelease(cwd, { candidate: green[0] });
      } else {
        plan = await planRelease(cwd, { candidate: requestedGreen(green, requested, Boolean(state.stagingGreenCommits)) });
        await requireReleasePrefix(plan);
        candidateSource = "requested";
        if (plan.commits.length && requestVerification && !state.verifications.some((operation) => operation.commitId === plan.candidate)) {
          await requestVerification(plan.candidate);
          state = await readPromotion();
        }
      }
      const { approved, verifications, auditRefusal } = state;
      if (plan.audits && auditRefusal) refuse(auditRefusal);
      const delta = await promotionDelta(plan, approved);
      requireMigrationsReady(plan, false);
      promotion = { ...delta ? { delta } : {}, candidateSource,
        ...candidateSource === "requested" ? { newerGreen: green.slice(0, green.indexOf(plan.candidate)) } : {},
        ...plan.commits.length ? { verification: verificationState(plan, verifications), approval: await approvalCoverage(plan, approved) } : {} };
    } else if (plan.audits) {
      // The audit ledger lives on the runner, so an audited release plans only against it.
      if (!readPromotion) refuse(`${plan.candidate.slice(0, 12)} is audited on the runner, which a promotion plan reads: set SLIPJAY_RUNNER or "runner" in ~/.slipjay/config.json`);
      const { auditRefusal } = await readPromotion();
      if (auditRefusal) refuse(auditRefusal);
    }
    const summary = { ...describePlan(plan), ...promotion };
    if (!plan.commits.length) return { ok: true, status: "up_to_date", ...summary };
    return { ok: true, status: "planned", ...summary, subjects: (promotion.delta?.commits ?? plan.commits).map((commit) => commit.subject),
      next: (promotion.approval?.covered ? `The approval of ${short(promotion.approval.approvedCandidate!)} covers this candidate: ` : "After explicit human approval: ")
        + `slipjay promote --confirm ${plan.candidate.slice(0, 12)}`
        + (!plan.promotes && plan.migrationArtifacts.length ? " --migrations-ready (once these migrations are applied where the release deploys)" : "")
        + (plan.promotes && plan.migrationArtifacts.length ? `. The runner applies its migrations (${plan.migrationArtifacts.join(", ")}) to production before it activates` : "")
        + (plan.promotes && plan.nonAdditiveMigrations.length ? `. Not additive: ${plan.nonAdditiveMigrations.join(", ")}; if production fails its health check, it is not rolled back automatically` : "") };
  } catch (error) {
    return refusalOf(error);
  }
}

/**
 * On the author's machine, before a confirm goes to the runner: the full id of the
 * approved candidate, or the refusal the runner would return for it.
 */
export async function confirmableCandidate(cwd: string, confirm: string, migrationsReady: boolean, readPromotion?: () => Promise<PromotionState>): Promise<{ ok: true; status: "confirmable"; candidate: string; remote: string } | ReleaseResult> {
  try {
    const plan = await planRelease(cwd, { candidate: confirm });
    if (plan.commits.length && plan.promotes && readPromotion) {
      // Any commit staging is green on may be confirmed, not only the newest; the runner refuses the rest too, but later.
      const state = await readPromotion();
      if (!greenCommits(state).includes(plan.candidate)) refuse(state.stagingGreenCommits ? `Staging recorded no green deploy of ${short(plan.candidate)}: production promotes only a commit staging deployed`
        : `Staging recorded no green deploy of ${short(plan.candidate)} among the commits this runner lists: it is too old to list older green commits, so only the newest can be confirmed`);
      await requireReleasePrefix(plan);
    }
    if (plan.commits.length) requireMigrationsReady(plan, migrationsReady);
    return { ok: true, status: "confirmable", candidate: plan.candidate, remote: plan.remote };
  } catch (error) {
    return refusalOf(error);
  }
}

/**
 * Refuse unless `checkout` still holds exactly the candidate's tree: the release
 * publishes the candidate, so checks that passed against edited source verified
 * something else. The edits are undone so the next confirm starts clean.
 */
async function requireCandidateTree(checkout: string, candidate: string): Promise<void> {
  const drift = await jj(checkout, ["diff", "--from", candidate, "--to", "@", "--summary"]);
  if (!drift) return;
  await jj(checkout, ["restore", "--from", candidate, "--into", "@"]);
  refuse(`Dependency preparation or release verification changed the candidate's source, so the verified tree is not the one a release would publish; nothing was published. Fix what edits it and confirm again:\n${drift}`);
}

/**
 * Check `plan`'s candidate out in `checkout`, prepare its dependencies and run its
 * release checks; refuse if they changed its source.
 */
async function verifyCandidate(checkout: string, plan: ReleasePlan, { onProgress = () => {}, onStage = () => {}, run: runCommand, environment, abortSignal }: VerifyOptions): Promise<unknown> {
  onStage("installing");
  await jj(checkout, ["new", plan.candidate]);
  await prepareWorkspaceDependencies(checkout, { quiet: true, runCommand, ...(environment ? { env: environment() } : {}) });
  onStage("verifying");
  const verification = plan.checks.length
    ? await runRequiredVerification({ checks: plan.checks, root: checkout, onProgress,
      ...(environment ? { environment } : {}), ...(runCommand ? { run: runCommand } : {}), ...(abortSignal ? { abortSignal } : {}) })
    : { passed: [], gaps: [] };
  await requireCandidateTree(checkout, plan.candidate);
  return verification;
}

/**
 * Pre-verify `candidate` in `checkout`, which this call owns for its duration (the
 * runner's release checkout), exactly as a confirm would verify it; publishes nothing.
 * A candidate the release branch already holds is refused: there is nothing to verify.
 */
export async function verifyRelease(checkout: string, options: VerifyOptions & { candidate: string }): Promise<VerifiedRelease | Extract<ReleaseResult, { ok: false }>> {
  try {
    const plan = await planRelease(checkout, { candidate: options.candidate });
    if (!plan.commits.length) refuse(`${short(plan.candidate)} is already on ${plan.releaseBranch}`);
    await verifyCandidate(checkout, plan, options);
    return { ok: true, status: "verified", base: plan.base, candidate: plan.candidate, checks: plan.checks, nonAdditiveMigrations: plan.nonAdditiveMigrations };
  } catch (error) {
    return refusalOf(error) as Extract<ReleaseResult, { ok: false }>;
  }
}

/**
 * Verify and publish the approved `candidate` from `checkout`, which this call owns
 * for its duration (the runner's release checkout: it checks the candidate out there).
 * A candidate the release branch already holds verifies nothing, and nor does one
 * `preverified` names a matching pre-verification of.
 */
export async function confirmRelease(checkout: string, options: ConfirmReleaseOptions): Promise<ReleaseResult> {
  const { candidate, migrationsReady = false, onProgress = () => {}, onStage = () => {}, exclusively = (publication) => publication(), preverified = () => null, publicationRefusal = () => null } = options;
  try {
    const plan = await planRelease(checkout, { candidate });
    if (!plan.commits.length) {
      const { merge, releasedBy } = await shippedBy(plan);
      onProgress(`[release] ${plan.candidate.slice(0, 12)} is already on ${plan.releaseBranch}`
        + (releasedBy ? `, released by ${releasedBy.slice(0, 12)}` : ""));
      onStage("finalizing");
      return { ok: true, status: "released_by", ...describePlan(plan), merge, releasedBy };
    }
    // The runner is the authority on the prefix rule: a promotion publishes only a commit that equals or descends from the release tip.
    if (plan.promotes) await requireReleasePrefix(plan);
    requireMigrationsReady(plan, migrationsReady);
    const summary = describePlan(plan);
    const reused = preverified(plan);
    if (reused) onProgress(`[release] ${short(plan.candidate)} passed pre-verification ${reused} against ${plan.releaseBranch} ${short(plan.base)}; not verifying again`);
    const verification = reused ? { preverified: reused } : await verifyCandidate(checkout, plan, options);
    return await exclusively(async () => {
      onStage("publishing");
      // The base must still be what was planned: a moved release branch needs a new plan.
      await fetch(plan.root, plan.remote, plan.releaseBranch);
      const base = await commitOf(plan.root, `${symbol(plan.releaseBranch)}@${symbol(plan.remote)}`);
      if (base !== plan.base) refuse(`${plan.releaseBranch}@${plan.remote} moved during the release; rerun it`);
      const refusal = publicationRefusal();
      if (refusal) refuse(refusal);
      const merge = await buildMerge(plan);
      await publish(plan, merge);
      onStage("finalizing");
      return { ok: true, status: "released", ...summary, merge, verification, releasedAt: new Date().toISOString() } as const;
    });
  } catch (error) {
    return refusalOf(error);
  }
}
