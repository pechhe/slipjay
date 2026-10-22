import { execFile } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { jj, revisionExists, workspaceUnintegratedRevset } from "../infra/workspace-jj.ts";
import { jjEnvironment } from "../infra/workspace-command.ts";
import type { WorkspaceContext } from "../infra/workspace-jj.ts";
import { landedHome, metadataHome } from "./workspace-paths.ts";
import { readLandingState } from "./workspace-state.ts";
import type { LandingState } from "./workspace-state.ts";

/** Original helper identities, independent of the lead's rewritten content. */
export type Adoption = { workspaceName: string; base: string; revisions: string[]; adoptedCommit?: string };
export type FrozenAdoption = { source: string; adoptions: Adoption[]; operationId?: string };
const revision = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export function adoptions(value: unknown): Adoption[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Adoption => Boolean(item && typeof item.workspaceName === "string"
    && revision(item.base) && Array.isArray(item.revisions) && item.revisions.length > 0 && item.revisions.every(revision)));
}

export function frozenAdoptions(value: unknown): Record<string, FrozenAdoption> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, FrozenAdoption] => {
    const item = entry[1] as Partial<FrozenAdoption> | null;
    return Boolean(item && revision(item.source) && Array.isArray(item.adoptions)
      && adoptions(item.adoptions).length === item.adoptions.length
      && (item.operationId === undefined || typeof item.operationId === "string"));
  }));
}

/** Publication evidence shared by coverage and later submission freezes. */
export async function publishedLandingArchives(context: WorkspaceContext): Promise<Record<string, unknown>[]> {
  const repository = await realpath(await jj(context.integration.root, ["--ignore-working-copy", "git", "root"]));
  const records: Record<string, unknown>[] = [];
  for (const file of await readdir(landedHome()).catch(() => [])) {
    if (!file.startsWith("artifact-") || !file.endsWith(".json")) continue;
    const record = await readFile(join(landedHome(), file), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>).catch(() => null);
    if (record?.coverageRepository !== repository && record?.adoptionRepository !== repository) continue;
    records.push(record!);
  }
  return records;
}

/** How many changed paths a landing's own record compares before keeping the workspace: past this, keep. */
const LANDING_COVERAGE_PATHS = 96;
/** How many of the checkout's own commits it reads one at a time; past this it cannot vouch for the range. */
const LANDING_COVERAGE_COMMITS = 12;
/** The largest file the comparison reads; a larger one it cannot vouch for, so it keeps the workspace. */
const LANDING_COVERAGE_BYTES = 4 * 1024 * 1024;

/**
 * Whether the checkout's own landing record proves the work it still holds is integrated: the
 * artifact is on the integration branch, and for every path the checkout changed, or the landing
 * delivered and the checkout no longer holds, the checkout holds what that artifact or the branch
 * already holds — bytes and executable bit. A path that differs from both is work the landing
 * never delivered and keeps the workspace.
 *
 * The changed paths are read one commit at a time: an aggregate diff over the range reports what
 * the range did *net*, so a commit that adds a file the checkout later deletes would cancel and
 * hide the deletion. Paths the artifact holds and the checkout does not are added separately for
 * the same reason: a deletion inside one commit cancels in that commit's own diff.
 */
async function ownLandingCovers(cwd: string, context: WorkspaceContext, workspaceName: string, unintegrated: string): Promise<boolean> {
  const state: LandingState | null = await readLandingState(workspaceName, { readOnly: true }).catch(() => null);
  if (!state || state.phase !== "landed" || !revision(state.artifactCommitId)) return false;
  // The branch moved on since the landing, so its own commit id is the proof, not membership of the branch tip.
  if (!await revisionExists(context.integration.root, `${state.artifactCommitId} & ::${context.integrationBranch}`)) return false;
  const gitRoot = await jj(context.integration.root, ["--ignore-working-copy", "git", "root"]).catch(() => null);
  const tip = await jj(cwd, ["--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "commit_id"]).catch(() => null);
  if (!gitRoot || !tip) return false;
  const commits = (await jj(cwd, ["--ignore-working-copy", "log", "-r", unintegrated, "--no-graph", "-T", 'commit_id ++ "\\n"'])
    .catch(() => null))?.split("\n").filter(Boolean) ?? [];
  if (commits.length > LANDING_COVERAGE_COMMITS) return false;
  const changed = await changedPaths(cwd, commits, state.artifactCommitId);
  if (changed === null) return false;
  for (const path of changed) {
    const [here, artifact, branch] = await Promise.all([
      entryAt(gitRoot, cwd, tip, path),
      entryAt(gitRoot, cwd, state.artifactCommitId, path),
      entryAt(gitRoot, cwd, context.integrationBranch, path),
    ]);
    if (sameEntry(here, artifact) || sameEntry(here, branch)) continue;
    return false;
  }
  return true;
}

/**
 * Repository-relative paths to judge: each of the checkout's own commits read alone, plus every
 * path the landing's artifact holds and the checkout no longer does. Null when they cannot be read
 * in full, including a rename or copy, whose two sides a summary does not give.
 */
async function changedPaths(cwd: string, commits: string[], artifactCommitId: string): Promise<Set<string> | null> {
  const paths = new Set<string>();
  const collect = async (revision: string) => {
    const summary = await jj(cwd, ["--ignore-working-copy", "diff", "-r", revision, "--summary"]).catch(() => null);
    if (summary === null) return false;
    for (const line of summary.split("\n")) {
      const match = /^([A-Z]) (.*)$/.exec(line);
      if (!match) continue;
      if (match[2]!.includes(" => ") || match[2]!.includes("{")) return false;
      // Only a deletion from the artifact's side matters there; what the checkout holds beyond it is its own commits' business.
      if (revision === artifactCommitId && match[1] !== "D") continue;
      paths.add(match[2]!);
      if (paths.size > LANDING_COVERAGE_PATHS) return false;
    }
    return true;
  };
  for (const commit of commits) if (!await collect(commit)) return null;
  if (!await collect(artifactCommitId)) return null;
  return paths;
}

/** A tracked entry at one revision: its bytes and whether it is executable. */
type Entry = { content: Buffer; executable: boolean };

/** The entry at one revision: null when the path is absent there, undefined when it cannot be read. */
async function entryAt(gitRoot: string, cwd: string, revision: string, path: string): Promise<Entry | null | undefined> {
  const [content, mode] = await Promise.all([contentAt(cwd, revision, path), modeAt(gitRoot, revision, path)]);
  if (content === undefined || mode === undefined) return undefined;
  // The two reads disagree about whether the path is there at all: nothing here can be vouched for.
  if ((content === null) !== (mode === null)) return undefined;
  return content === null ? null : { content, executable: mode === "100755" };
}

/**
 * A file's bytes at one revision: null when it is absent there, undefined when it cannot be read.
 * Never snapshots. Absence and failure are kept apart, so a read that fails can never pass for a
 * file the landing and the branch both lack.
 */
async function contentAt(cwd: string, revision: string, path: string): Promise<Buffer | null | undefined> {
  return await new Promise((done) => {
    execFile("jj", ["--color=never", "--ignore-working-copy", "file", "show", "-r", revision, "--", `root-file:${JSON.stringify(path)}`],
      { cwd, env: jjEnvironment(process.env), encoding: "buffer", maxBuffer: LANDING_COVERAGE_BYTES }, (error, stdout, stderr) =>
        done(!error ? stdout : ABSENT_FILE.test(String(stderr)) ? null : undefined));
  });
}

/**
 * A path's tracked mode at one revision, from the git repository underneath: null when it is absent,
 * undefined when it cannot be read (including a repository git cannot read). The executable bit is
 * part of a change, so bytes that match while the mode does not still count as unlanded work.
 */
async function modeAt(gitRoot: string, revision: string, path: string): Promise<string | null | undefined> {
  return await new Promise((done) => {
    execFile("git", ["-C", gitRoot, "ls-tree", "-z", revision, "--", path], { encoding: "buffer", maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error) return done(undefined);
      const text = stdout.toString();
      if (!text) return done(null);
      const mode = /^(\d{6}) \w+ [0-9a-f]+\t/.exec(text);
      done(mode ? mode[1] : undefined);
    });
  });
}

/** JJ's refusal for a path a revision does not hold. */
const ABSENT_FILE: RegExp = /did not match any files|No such path|No such file|does not exist/i;

const sameEntry = (here: Entry | null | undefined, there: Entry | null | undefined): boolean =>
  here !== undefined && there !== undefined
  && (here === null || there === null ? here === there : here.executable === there.executable && here.content.equals(there.content));

/**
 * Only repository-scoped published archives prove delivery; helpers in a handoff never do.
 * `covered` includes exact adoption evidence; `source-covered` alone grants no Issue exemption.
 */
export async function workspaceCoverage(context: WorkspaceContext, workspaceName: string, tip = "@", cwd = context.current.root): Promise<"covered" | "source-covered" | "pending" | "uncovered" | "integrated"> {
  const unintegrated = workspaceUnintegratedRevset(context.integrationBranch, tip);
  const revisions = (await jj(cwd, ["--ignore-working-copy", "log", "-r", unintegrated, "--no-graph", "-T", 'commit_id ++ "\\n"'])).split("\n").filter(Boolean);
  if (!revisions.length) return "integrated";
  const covered = new Set<string>();
  const sources = new Set<string>();
  for (const record of await publishedLandingArchives(context)) {
    if (revision(record.publishedSource)) sources.add(record.publishedSource);
    for (const adoption of adoptions(record.adoptionCoverage)) {
      if (adoption.workspaceName !== workspaceName) continue;
      for (const commit of adoption.revisions) covered.add(commit);
    }
  }
  const adopted = new Set(covered);
  if (sources.size) {
    // A published source proves its complete ancestry, including review/verify
    // workspaces based on it. Helper branches still require exact adoption coverage.
    const inherited = await jj(cwd, ["--ignore-working-copy", "log", "-r",
      `(${unintegrated}) & ::(${[...sources].join(" | ")})`,
      "--no-graph", "-T", 'commit_id ++ "\\n"']);
    for (const commit of inherited.split("\n").filter(Boolean)) covered.add(commit);
  }
  if (revisions.every((commit) => covered.has(commit))) return revisions.some((commit) => adopted.has(commit)) ? "covered" : "source-covered";
  // A landing that ran on a runner wrote its archive there, so this machine has none; its own record is
  // the only evidence the checkout's work is integrated.
  if (await ownLandingCovers(cwd, context, workspaceName, unintegrated)) return "source-covered";
  for (const file of await readdir(metadataHome()).catch(() => [])) {
    if (!file.endsWith(".json")) continue;
    const record = await readFile(join(metadataHome(), file), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>).catch(() => null);
    if (record?.integrationRoot !== context.integration.root) continue;
    const pending = [...adoptions(record.adoptions), ...Object.values(frozenAdoptions(record.landingAdoptions)).flatMap((item) => item.adoptions)];
    if (pending.some((item) => item.workspaceName === workspaceName && item.revisions.some((commit) => revisions.includes(commit) && !covered.has(commit)))) return "pending";
  }
  return "uncovered";
}
