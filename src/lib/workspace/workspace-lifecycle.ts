import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { artifactPublished, finishLandedWorkspace } from "../landing/landing-steps.ts";
import type { WorkspaceContext, WorkspaceEntry, WorkspaceMetadata } from "../infra/workspace-jj.ts";
import { repositoryProjectCode, revisionExists, revisionFacts, run, STALE_WORKING_COPY, updateStaleWorkingCopy, workingCopyCommit, workspaceContext } from "../infra/workspace-jj.ts";
import { evidenceHome, workspaceHome, workspaceStorageHomes } from "./workspace-paths.ts";
import { landingStatePaths, listWorkspaces, lockOwnerAlive, lockPath, metadataPath, readLandingState, workspaceMetadata } from "./workspace-state.ts";
import type { LandingState } from "./workspace-state.ts";
import { generatedPathMatchers, readIntegrationPolicy } from "../policy/execution-policy.ts";
import { cleanupRetentionReason, hasPendingRunnerFacts } from "./workspace-delivery-lifecycle.ts";
import { callerPids, describeHolders, processAlive, workspaceHolders } from "./workspace-holders.ts";
import { archiveIntegratedWorkspaceEvidence, conflictingArchive } from "./workspace-finalization.ts";
import { runWorkspaceTeardown } from "./workspace-teardown.ts";
import { jjEnvironment } from "../infra/workspace-command.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "../infra/workspace-transaction.ts";
import { appendPoolRefillLog } from "./workspace-background.ts";
import { discardCheckout } from "./workspace-trash.ts";
import { releaseSpareHandover, reserveSpareForHandover } from "./workspace-spares.ts";
import { moveNodeModules } from "./workspace-dependencies.ts";
import { workspaceCoverage } from "./workspace-coverage.ts";

/** Host seams for retiring a checkout: its guarded forget and lifecycle event. */
export interface RetirementHooks {
  forget?: (integrationRoot: string, workspaceName: string, workspacePath: string) => Promise<void>;
  onReleased?: (release: { workspaceName: string; projectRoot: string; issueNumber: number | null }) => void;
  /** Overrides the `workspaceTeardown` timeout (tests). */
  teardownTimeoutMs?: number;
  /** Called after cleanup's delivery checks and just before it retires the checkout (tests, hosts). */
  afterChecks?: () => void | Promise<void>;
  /** Called after retirement copies a checkout's evidence and before its last look (tests). */
  afterEvidence?: () => void | Promise<void>;
}

type CleanupResult = {
  cleaned: boolean;
  reason?: string;
  paths?: string[];
  /** `archived-elsewhere`: the workspace whose landing already archived the artifact this checkout's record names. */
  archivedAs?: string;
};

async function jj(cwd: string, args: string[]): Promise<string> {
  const result = await run("jj", ["--color=never", ...args], { cwd });
  if (result.code !== 0) throw new Error(`jj ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

const REPRODUCIBLE = new Set([
  ".jj", ".git", "node_modules", ".svelte-check", ".svelte-kit", ".wrangler", ".turbo", ".vite", ".cache",
  ".next", "dist", "build", "out", "coverage", "target", "DerivedData", ".DS_Store",
  ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", ".vercel", ".astro", ".swc",
]);

/**
 * The shared cleanup check for a landed checkout: material neither tracked nor
 * reproducible under the integration checkout's declared `generatedPaths`.
 * Every cleanup surface (Pi launcher, CLI, Peach host) must pass this first.
 */
export async function retainedWorkspaceMaterial(root: string, integrationRoot: string, limit: number = 5): Promise<string[]> {
  return uniqueUntrackedMaterial(root, limit, await disposablePaths(integrationRoot), integrationRoot);
}

/** Paths edited since the checkout's last snapshot, for a reader that must not snapshot (see `editedSinceSnapshot`). */
export async function unsnapshottedEdits(root: string, integrationRoot: string, limit: number = 5): Promise<string[]> {
  return editedSinceSnapshot(root, await disposablePaths(integrationRoot), integrationRoot, limit);
}

/** Why a checkout whose stale working copy held edits is kept (see `updateStaleWorkingCopy`). */
export const STALE_EDITS = "its stale working copy held edits, now restored as its working-copy change on the commit they were made on";

/** One human explanation of why cleanup kept a landed workspace. */
export function describeRetention(result: { reason?: string; paths?: string[]; archivedAs?: string } | null | undefined): string {
  if (result?.reason === "archived-elsewhere") {
    return `its landing record names an artifact already archived as workspace ${result.archivedAs}'s landing, so it proves nothing about this checkout: `
      + "if the checkout holds nothing you need, remove it with `slipjay remove <its path>`";
  }
  if (result?.reason !== "unique-files") return String(result?.reason ?? "cleanup did not complete");
  return `holds files cleanup will not delete: ${(result.paths ?? []).join(", ")}`
    + " (remove them, declare generated output in slipjay.json generatedPaths, or evidence to preserve in evidencePaths)";
}

/** How long one reading of a repository's declared paths serves the checks of a single judgement. */
const DECLARED_PATHS_TTL_MS = 5_000;
const declaredPathsRead = new Map<string, { at: number; paths: Promise<{ generated: RegExp[]; evidence: RegExp[] }> }>();

/**
 * The repository's `generatedPaths` and `evidencePaths`, from the policy committed on its
 * integration bookmark (strictly), as the spare allowance reads it: never the primary checkout's
 * working files, which move only when that host lands, so every host judges by the same policy.
 */
function declaredPaths(integrationRoot: string): Promise<{ generated: RegExp[]; evidence: RegExp[] }> {
  const cached = declaredPathsRead.get(integrationRoot);
  if (cached && Date.now() - cached.at < DECLARED_PATHS_TTL_MS) return cached.paths;
  const paths = readIntegrationPolicy(integrationRoot, { hintRoot: integrationRoot }).then(({ policy }) => ({
    generated: generatedPathMatchers(policy?.generatedPaths), evidence: generatedPathMatchers(policy?.evidencePaths, "evidencePaths"),
  }));
  declaredPathsRead.set(integrationRoot, { at: Date.now(), paths });
  paths.catch(() => declaredPathsRead.delete(integrationRoot));
  return paths;
}

/** Paths that cannot keep a checkout: generated output it discards and evidence retirement preserves first. */
async function disposablePaths(integrationRoot: string): Promise<RegExp[]> {
  const { generated, evidence } = await declaredPaths(integrationRoot);
  return [...generated, ...evidence];
}

/**
 * Visit every entry of a checkout that is not reproducible (a built-in tool cache or
 * a path the repository declares as generated), depth first, until `visit` returns
 * true (stop). Directories are visited before their contents; one matching `skip` is
 * visited but not entered.
 */
async function walkMaterial(root: string, generated: RegExp[], visit: (entry: Dirent, directory: string, path: string) => Promise<boolean | void>,
  { skip = [] }: { skip?: RegExp[] } = {}): Promise<void> {
  async function walk(directory: string, relative: string): Promise<boolean> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (REPRODUCIBLE.has(entry.name) || entry.name.endsWith(".tsbuildinfo")) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (generated.some((matcher) => matcher.test(`${path}/`))) continue;
      if (await visit(entry, directory, path)) return true;
      if (skip.some((matcher) => matcher.test(`${path}/`))) continue;
      if (entry.isDirectory() && await walk(join(directory, entry.name), path)) return true;
    }
    return false;
  }
  await walk(root, "");
}

/**
 * Files in a checkout that are neither tracked nor reproducible (a built-in tool
 * cache or a path the repository declares as generated): ignored or unexplained
 * material that cleanup must not destroy. "Tracked" is the last snapshot of the
 * working copy; this never takes a snapshot itself. Symlinks are reported, never followed,
 * except one pointing into `primaryRoot` (the primary checkout), whose target
 * outlives the checkout. Returns at most `limit` repository-relative paths.
 */
export async function uniqueUntrackedMaterial(root: string, limit: number = 5, generated: RegExp[] = [], primaryRoot: string | null = null): Promise<string[]> {
  const linksIntoPrimary = primaryLinks(primaryRoot);
  const tracked = await snapshotFiles(root);
  const found: string[] = [];
  await walkMaterial(root, generated, async (entry, directory, path) => {
    if (entry.isDirectory() || tracked.has(path) || await linksIntoPrimary(entry, directory)) return false;
    found.push(path);
    return found.length >= limit;
  });
  return found;
}

/**
 * Files in a directory that are not reproducible (a built-in tool cache or JJ/Git state), for a
 * directory with no JJ identity to compare against, such as an orphan in workspace storage.
 * Returns at most `limit` relative paths.
 */
export async function nonReproducibleFiles(root: string, limit: number = 5): Promise<string[]> {
  const found: string[] = [];
  // A Git repository or a JJ store holds history of its own: only a `.jj/repo` pointer file is a checkout's.
  if (existsSync(join(root, ".git"))) found.push(".git");
  if (await stat(join(root, ".jj", "repo")).then((info) => info.isDirectory(), () => false)) found.push(".jj/repo");
  await walkMaterial(root, [], async (entry, directory, path) => {
    if (entry.isDirectory()) {
      // A nested repository's history (`vendor/.git`) is skipped by the walk itself.
      if (existsSync(join(directory, entry.name, ".git"))) found.push(`${path}/.git`);
      return found.length >= limit;
    }
    found.push(path);
    return found.length >= limit;
  });
  return found;
}

/** Whether a tracked file on disk holds exactly its bytes in the checkout's last snapshot. */
function matchesSnapshot(root: string, path: string, size: number): Promise<boolean> {
  return new Promise((done) => {
    execFile("jj", ["--color=never", "--ignore-working-copy", "file", "show", "-r", "@", "--", `root-file:${JSON.stringify(path)}`],
      { cwd: root, env: jjEnvironment(process.env), encoding: "buffer", maxBuffer: size + 1 }, async (error, stdout) => {
        if (error || stdout.length !== size) return done(false);
        done(await readFile(join(root, path)).then((disk) => disk.equals(stdout), () => false));
      });
  });
}

/** Files in the checkout's last snapshot. Never snapshots: a snapshot here would turn an on-disk edit into a commit no caller has judged. */
async function snapshotFiles(root: string): Promise<Set<string>> {
  return new Set((await jj(root, ["--ignore-working-copy", "file", "list"])).split("\n").filter(Boolean));
}

/** Whether an entry is a symlink into the primary checkout, whose target outlives the checkout. */
function primaryLinks(primaryRoot: string | null): (entry: Dirent, directory: string) => Promise<boolean> {
  const primary = primaryRoot && resolve(primaryRoot);
  return async (entry, directory) => {
    if (!primary || !entry.isSymbolicLink()) return false;
    const target = resolve(directory, await readlink(join(directory, entry.name)));
    return target === primary || target.startsWith(primary + sep);
  };
}

/** How many tracked files newer than the snapshot a read-only judgement compares with it before assuming the rest changed. */
const SNAPSHOT_COMPARISONS = 32;
/** The largest tracked file it compares; a larger one newer than the snapshot is assumed changed. */
const SNAPSHOT_COMPARISON_BYTES = 16 * 1024 * 1024;

/**
 * Paths changed on disk since JJ last snapshotted the checkout, which a reader that
 * must not snapshot cannot judge, since they may be unlanded work: a tracked file
 * edited or deleted since, or a new file other than a link into the primary checkout.
 * A tracked file written after the snapshot with the snapshot's exact bytes (as setting
 * up a checkout does) is not an edit. Returns at most `limit` repository-relative paths.
 */
async function editedSinceSnapshot(root: string, generated: RegExp[] = [], primaryRoot: string | null = null, limit: number = 5): Promise<string[]> {
  const snapshot = (await stat(join(root, ".jj", "working_copy", "tree_state"))).mtimeMs;
  const linksIntoPrimary = primaryLinks(primaryRoot);
  const tracked = await snapshotFiles(root);
  const found: string[] = [];
  let comparisons = 0;
  for (const path of tracked) {
    if (found.length >= limit) return found;
    const info = await lstat(join(root, path)).catch(() => null);
    if (info && info.mtimeMs <= snapshot) continue;
    if (info?.isFile() && info.size <= SNAPSHOT_COMPARISON_BYTES && comparisons++ < SNAPSHOT_COMPARISONS && await matchesSnapshot(root, path, info.size)) continue;
    found.push(path);
  }
  await walkMaterial(root, generated, async (entry, directory, path) => {
    if (entry.isDirectory() || tracked.has(path) || await linksIntoPrimary(entry, directory)) return false;
    if ((await lstat(join(directory, entry.name))).mtimeMs > snapshot) found.push(path);
    return found.length >= limit;
  });
  return found;
}

/**
 * Release a delivered checkout: integrated, published, no new or unique material.
 * Serialized with removal and host writes on the workspace's `writer:` key, which
 * is not reentrant: never call this while holding that key. `hooks` lets a host
 * supply its guarded forget and lifecycle event.
 */
export async function cleanupLandedWorkspace(cwd: string = process.cwd(), hooks: RetirementHooks = {}): Promise<CleanupResult> {
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default") return { cleaned: false, reason: "not-isolated" };
  return withWorkspaceTransaction(`writer:${context.current.name}`, () => cleanupLandedWorkspaceUnlocked(cwd, hooks));
}

/**
 * Remove the workspace a landing delivered, as `slipjay cleanup` would. Anything
 * else working inside it keeps it, and is named so its owner can stop it.
 */
export async function releaseLandedWorkspace(context: WorkspaceContext, { ignore = [] }: { ignore?: Iterable<number> } = {}) {
  const holders = await workspaceHolders(context.current.root, { ignore: new Set([...await callerPids(), ...ignore]) });
  if (!holders) return { cleaned: false, reason: "process working directories unavailable" };
  if (holders.length) return { cleaned: false, reason: `in use by a live process: ${describeHolders(holders)}`, holders };
  const result = await cleanupLandedWorkspace(context.current.root);
  return result.cleaned ? { cleaned: true } : { cleaned: false, reason: describeRetention(result) };
}

/** Thrown when a checkout's working copy changed between cleanup's judgement and its retirement. */
export class WorkingCopyChangedError extends Error {
  /** Stable code for hosts handling a changed working copy. */
  declare code: "WORKING_COPY_CHANGED";

  constructor(workspaceName: string) {
    super(`jj:${workspaceName} changed while it was being retired; kept`);
    this.code = "WORKING_COPY_CHANGED";
  }
}

/**
 * Judge a checkout once: snapshot its working copy, then read everything else
 * from that snapshot (`--ignore-working-copy`). Returns the judged working-copy
 * commit and why the checkout must be kept, if it must. `readOnly` never
 * snapshots: an edit since the last snapshot keeps the checkout instead.
 */
async function judgeCheckout(context: WorkspaceContext, { readOnly = false }: { readOnly?: boolean } = {}): Promise<{ commit: string; retained: CleanupResult | null }> {
  const generated = await disposablePaths(context.integration.root);
  const commit = readOnly
    ? await jj(context.current.root, ["--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "commit_id"])
    : await workingCopyCommit(context.current.root).catch(async (error: unknown) => {
      // A stale checkout is updated first; one whose stale files held edits keeps them.
      if (!STALE_WORKING_COPY.test(String(error))) throw error;
      return (await updateStaleWorkingCopy(context.current.root)).recordedEdits ? null : workingCopyCommit(context.current.root);
    });
  if (commit === null) return { commit: "", retained: { cleaned: false, reason: STALE_EDITS } };
  if (readOnly) {
    const edited = await editedSinceSnapshot(context.current.root, generated, context.integration.root);
    if (edited.length) return { commit, retained: { cleaned: false, reason: "unsnapshotted-edits", paths: edited } };
  }
  // Follow-up work on top of the landed artifact is never deleted.
  const coverage = await workspaceCoverage(context, context.current.name);
  if (coverage === "pending" || coverage === "uncovered") {
    return { commit, retained: { cleaned: false, reason: coverage === "pending" ? "adopted, landing not published" : "new-unlanded-work" } };
  }
  const unique = await uniqueUntrackedMaterial(context.current.root, 5, generated, context.integration.root);
  return { commit, retained: unique.length ? { cleaned: false, reason: "unique-files", paths: unique } : null };
}

type LandedChecks =
  | { ready: false; result: CleanupResult }
  | { ready: true; context: WorkspaceContext; state: LandingState | null; commit: string; gitDirectory: string };

/**
 * Every check cleanup makes before it retires a landed checkout, in its order.
 * Cleanup snapshots the working copy, finishes a landing's pending housekeeping
 * and fetches to prove publication. `readOnly` (the retention plan) changes
 * nothing: it reads the last snapshot, reports pending housekeeping as a reason
 * to keep, and judges publication as of the last fetch.
 */
export async function landedCleanupChecks(cwd: string, { readOnly = false }: { readOnly?: boolean } = {}): Promise<LandedChecks> {
  const keep = (reason: string, paths?: string[]): LandedChecks => ({ ready: false, result: { cleaned: false, reason, ...paths ? { paths } : {} } });
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default") return keep("not-isolated");
  let state = await readLandingState(context.current.name, { readOnly });
  // A read-only read never promotes a queued landing, so judge it as cleanup's promotion would.
  if (readOnly && state?.phase === "prepared") {
    const integrated = typeof state.integrationRoot === "string"
      && await revisionExists(state.integrationRoot, `${state.artifactCommitId} & ::${state.integrationBranch}`);
    if (!integrated) return keep("landing-queued");
    state = { ...state, phase: "landed" };
  }
  if (!state) {
    const coverage = await workspaceCoverage(context, context.current.name);
    if (coverage === "pending") return keep("adopted, landing not published");
    const metadata = await workspaceMetadata(context.current.name);
    if (coverage !== "covered" && (coverage !== "source-covered" || metadata?.issueNumber)) return keep("not-landed");
    const refusal = await removalRefusal(context.current, metadata);
    if (refusal) return keep(refusal);
    const holders = await workspaceHolders(context.current.root, { ignore: await callerPids() });
    if (!holders) return keep("process working directories unavailable");
    if (holders.length || await lockOwnerAlive(context.current.name)) return keep("in use by a live process");
    const judged = await judgeCheckout(context, { readOnly });
    if (judged.retained) return { ready: false, result: judged.retained };
    return { ready: true, context, state: null, commit: judged.commit, gitDirectory: "" };
  }
  if (resolve(state.workspacePath) !== resolve(context.current.root) || state.workspaceName !== context.current.name) {
    throw new Error("Landing state does not match the current workspace");
  }
  // Recover frozen provenance before judging a shared source's old commit IDs.
  // The archiver independently requires publication before adding coverage.
  if (!readOnly && await revisionExists(context.integration.root, `${state.artifactCommitId} & ::${state.integrationBranch}`)) {
    const directory = await jj(context.integration.root, ["--ignore-working-copy", "git", "root"]);
    if (!await conflictingArchive(directory, state)) await archiveIntegratedWorkspaceEvidence(directory, state);
  }
  let judged = await judgeCheckout(context, { readOnly });
  if (judged.retained) return { ready: false, result: judged.retained };
  // Pending housekeeping is retried below; every other retention reason holds.
  const retention = cleanupRetentionReason({ ...state, cleanupPending: false }, context, await workspaceMetadata(context.current.name));
  if (retention) return keep(retention);
  if (!await revisionExists(context.integration.root, `${state.artifactCommitId} & ::${state.integrationBranch}`))
    throw new Error("Cannot prove the landed artifact is integrated; workspace retained");
  const gitDirectory = await jj(context.integration.root, ["--ignore-working-copy", "git", "root"]);
  // A record naming another delivery's artifact cannot be archived, so nothing proves this checkout's own landing.
  const archived = await conflictingArchive(gitDirectory, state);
  if (archived) return { ready: false, result: { cleaned: false, reason: "archived-elsewhere", archivedAs: archived.workspaceName } };
  if (state.cleanupPending) {
    if (readOnly) return keep("housekeeping-pending");
    if ((await finishLandedWorkspace(context, state)).cleanupPending) return keep("housekeeping-pending");
    // Housekeeping moves the working copy off the artifact: judge the new state.
    judged = await judgeCheckout(context);
    if (judged.retained) return { ready: false, result: judged.retained };
  }
  // The runner finalizes before it publishes, so a published artifact has no pending step.
  if (!await artifactPublished(cwd, context, state, { fetch: !readOnly })) return keep("not-published");
  // Cleanup deletes only checkouts beneath slipjay workspace storage.
  if (!await withinWorkspaceStorage(context.current.root)) return keep("outside-workspace-storage");
  return { ready: true, context, state, commit: judged.commit, gitDirectory };
}

async function cleanupLandedWorkspaceUnlocked(cwd: string, hooks: RetirementHooks): Promise<CleanupResult> {
  const checks = await landedCleanupChecks(cwd);
  if (!checks.ready) return checks.result;
  const { context, state, commit, gitDirectory } = checks;
  if (state) await archiveIntegratedWorkspaceEvidence(gitDirectory, state);
  await hooks.afterChecks?.();
  try {
    await retireWorkspace(context.integration.root, context.current, hooks, { expectedCommitId: commit, retainMaterial: true });
  } catch (error) {
    if (error instanceof WorkingCopyChangedError) return { cleaned: false, reason: "working-copy-changed" };
    throw error;
  }
  return { cleaned: true };
}

/** Remove an isolated workspace after checking its work and Issue attachment; `retainMaterial` keeps one holding files retirement would delete, before or during retirement. */
export async function removeWorkspace(cwd: string, workspaceName: string, options: { allowWork?: boolean; allowIssue?: boolean; retainMaterial?: boolean } = {}): Promise<{ workspaceName: string; hasWork: boolean; issueNumber: number | null }> {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Not inside a Jujutsu repository");
  if (workspaceName === "default")
    throw new Error("The canonical default workspace cannot be removed");
  if (workspaceName === context.current.name)
    throw new Error("Cannot remove the workspace hosting this Pi process");
  return withWorkspaceTransaction(`writer:${workspaceName}`, async () => {
    const target = (await listWorkspaces(cwd)).find((workspace) => workspace.name === workspaceName);
    if (!target?.root) throw new Error(`Unknown or unavailable JJ workspace: ${workspaceName}`);
    const metadata = await workspaceMetadata(workspaceName);
    const refusal = await removalRefusal({ name: workspaceName, root: target.root }, metadata);
    if (refusal) throw new Error(refusal);
    // Snapshot once; retirement then refuses a working copy that moved since.
    const judged = await workingCopyCommit(target.root).catch(() => null);
    const coverage = judged === null ? "uncovered" : await workspaceCoverage(context, workspaceName, judged, target.root).catch(() => "uncovered" as const);
    const hasWork = coverage === "uncovered" || coverage === "pending";
    if (coverage === "pending") {
      const unique = await retainedWorkspaceMaterial(target.root, context.integration.root);
      throw new Error(unique.length ? describeRetention({ reason: "unique-files", paths: unique }) : "adopted, landing not published");
    }
    if (hasWork && options.allowWork !== true)
      throw new Error(
        `jj:${workspaceName} contains unlanded work; explicit deletion confirmation is required`,
      );
    if (metadata?.issueNumber && options.allowIssue !== true && coverage !== "covered")
      throw new Error(
        `jj:${workspaceName} is attached to Issue #${metadata.issueNumber}; explicit deletion confirmation is required`,
      );
    const retainMaterial = options.retainMaterial;
    if (retainMaterial) {
      const unique = await retainedWorkspaceMaterial(target.root, context.integration.root);
      if (unique.length) throw new Error(describeRetention({ reason: "unique-files", paths: unique }));
    }
    await retireWorkspace(context.integration.root, { name: workspaceName, root: target.root }, {},
      { ...judged === null ? {} : { expectedCommitId: judged }, retainMaterial });
    return { workspaceName, hasWork, issueNumber: metadata?.issueNumber ?? null };
  });
}

/**
 * Whether a checkout lives beneath slipjay workspace storage (`~/.slipjay/workspaces`,
 * or the preserved `~/.slipway/workspaces` and `~/.pi/workspaces` roots), the only places cleanup deletes.
 */
export async function withinWorkspaceStorage(root: string): Promise<boolean> {
  const canonical = (path: string): Promise<string> => realpath(path).catch(() => resolve(path));
  const [target, ...storage] = await Promise.all([root, ...workspaceStorageHomes()].map(canonical));
  return storage.some((home) => target!.startsWith(home + "/"));
}

/**
 * Why a workspace whose checkout is gone from disk must stay registered, or null when forgetting
 * it loses nothing: it owes the runner no facts, no live process prepares or owns it, its JJ
 * revision is readable and unconflicted, holds no work outside the integration branch, any
 * landing it recorded is integrated, and its recorded path lies in workspace storage. Reads
 * only, so the retention plan reports the same reason.
 */
export async function missingCheckoutRefusal(cwd: string, workspace: WorkspaceEntry): Promise<string | null> {
  const context = await workspaceContext(cwd);
  if (!context) return "cannot be checked outside a Jujutsu repository";
  // The obligations retirement keeps for a present checkout hold for a missing one too.
  const metadata = workspace.metadata ?? await workspaceMetadata(workspace.name);
  if (hasPendingRunnerFacts(metadata)) return "has pending runner facts; reconnect from that workspace to deliver them before removal";
  if (metadata?.preparingPid !== process.pid && processAlive(metadata?.preparingPid)) return "is being prepared by a live process";
  if (await lockOwnerAlive(workspace.name)) return "is owned by a live process";
  const facts = await revisionFacts(cwd, workspace.commitId, { ignoreWorkingCopy: true }).catch(() => null);
  if (!facts) return "points at an unreadable JJ revision; preserve it for explicit recovery";
  if (facts.conflict) return "has conflicted JJ state; preserve it for explicit recovery";
  const unintegrated = await run("jj", ["--color=never", "--ignore-working-copy", "log", "-r", `(${context.integrationBranch}..${workspace.commitId}) & ~empty()`, "--no-graph", "-T", 'commit_id.short() ++ "\\n"'], { cwd });
  if (unintegrated.code !== 0) return "points at an unreadable JJ revision; preserve it for explicit recovery";
  const coverage = await workspaceCoverage(context, workspace.name, workspace.commitId, cwd);
  if (coverage === "pending") return "adopted, landing not published";
  if (unintegrated.stdout.trim() && coverage !== "covered" && coverage !== "source-covered") return "is missing on disk but still contains unintegrated work; preserve it for explicit recovery";
  const landed = await readLandingState(workspace.name, { readOnly: true });
  if (landed && !await revisionExists(cwd, `${landed.artifactCommitId} & ::${landed.integrationBranch}`)) {
    return "has landing evidence that is not integrated; preserve it for explicit recovery";
  }
  if (!missingCheckoutPath(workspace)) return "has an unsafe stale path; preserve it for explicit recovery";
  return null;
}

/** The recorded path of a missing checkout, when it lies in workspace storage (checked lexically: the checkout is gone). */
function missingCheckoutPath(workspace: WorkspaceEntry): string | null {
  const recorded = typeof workspace.metadata?.workspacePath === "string"
    ? workspace.metadata.workspacePath
    : workspace.root || join(workspaceHome(), workspace.name);
  const path = resolve(recorded);
  return workspaceStorageHomes().some((home) => path.startsWith(`${resolve(home)}${sep}`)) ? path : null;
}

/**
 * Forget a workspace whose checkout is gone, once `missingCheckoutRefusal` finds nothing to keep,
 * with its state. Serialized on the workspace's `writer:` key, which is not reentrant: never call
 * this while holding that key.
 */
export async function forgetMissingCheckout(cwd: string, workspace: WorkspaceEntry, hooks: Pick<RetirementHooks, "forget"> = {}): Promise<void> {
  // Serialized with removal and host writes, judged again under the writer key.
  await withWorkspaceTransaction(`writer:${workspace.name}`, async () => {
    const context = await workspaceContext(cwd);
    const path = missingCheckoutPath(workspace);
    if (!context || !path) throw new Error(`jj:${workspace.name} cannot be forgotten safely`);
    if (existsSync(path)) throw new Error(`jj:${workspace.name} checkout reappeared; kept`);
    // Its metadata read again under the key: a host may have recorded facts since the caller listed it.
    const refusal = await missingCheckoutRefusal(cwd, { ...workspace, metadata: await workspaceMetadata(workspace.name) });
    if (refusal) throw new Error(`jj:${workspace.name} ${refusal}`);
    await forgetWorkspace(context.integration.root, workspace.name, path, hooks);
    if (existsSync(path)) throw new Error(`jj:${workspace.name} stale checkout could not be removed safely`);
    await rm(metadataPath(workspace.name), { force: true });
    for (const candidate of landingStatePaths(workspace.name)) await rm(candidate, { force: true });
    await rm(lockPath(workspace.name), { force: true });
  });
}

/** The most evidence one retirement preserves; more keeps the workspace, since evidence must not be silently dropped. */
export const MAX_EVIDENCE_BYTES: number = 64 * 1024 * 1024;

/** The time suffix of a preserved evidence directory: an ISO timestamp with `:` and `.` replaced by `-`. */
const EVIDENCE_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** What lies under a checkout's declared `evidencePaths`, untracked. */
interface EvidenceInventory {
  files: Array<{ path: string; bytes: number; mtimeMs: number }>;
  /** Symbolic links, recorded with their target and never followed. */
  links: Array<{ path: string; target: string }>;
  /** Sockets, FIFOs and devices: runtime endpoints, not evidence. */
  skipped: string[];
}

async function evidenceInventory(root: string, generated: RegExp[], evidence: RegExp[]): Promise<EvidenceInventory> {
  const tracked = await snapshotFiles(root).catch(() => new Set<string>());
  const inventory: EvidenceInventory = { files: [], links: [], skipped: [] };
  // Everything at or below a declared evidence path; the walk does not descend into one itself.
  const collect = async (entry: Dirent, absolute: string, path: string): Promise<void> => {
    if (entry.isDirectory()) {
      for (const child of await readdir(absolute, { withFileTypes: true })) await collect(child, join(absolute, child.name), `${path}/${child.name}`);
    } else if (entry.isSymbolicLink()) inventory.links.push({ path, target: await readlink(absolute) });
    else if (!entry.isFile()) inventory.skipped.push(path);
    else if (!tracked.has(path)) {
      const { size, mtimeMs } = await lstat(absolute);
      inventory.files.push({ path, bytes: size, mtimeMs });
    }
  };
  await walkMaterial(root, generated, async (entry, directory, path) => {
    if (evidence.some((matcher) => matcher.test(`${path}/`))) await collect(entry, join(directory, entry.name), path);
    return false;
  }, { skip: evidence });
  return inventory;
}

/**
 * Copy the untracked files under the repository's declared `evidencePaths` out of a checkout
 * about to be retired, into its own directory of the evidence home with a `provenance.json`
 * naming the workspace, repository, Issue, task, working-copy commit, landing (if any) and each
 * file's size and SHA-256; symbolic links are recorded with their target and sockets or FIFOs
 * as skipped. Written as `<name>.partial` and renamed once complete; a retirement removes its
 * workspace's interrupted copies first. Returns the directory and the inventory it copied (for
 * `retireWorkspace` to compare just before forgetting), or null when there was nothing. Throws,
 * keeping the checkout, when the evidence exceeds `MAX_EVIDENCE_BYTES` or cannot be copied.
 */
export async function preserveWorkspaceEvidence(integrationRoot: string, workspace: { name: string; root: string }): Promise<{ directory: string; inventory: string } | null> {
  const { generated, evidence } = await declaredPaths(integrationRoot);
  if (!evidence.length) return null;
  const inventory = await evidenceInventory(workspace.root, generated, evidence);
  if (!inventory.files.length && !inventory.links.length) return null;
  const total = inventory.files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > MAX_EVIDENCE_BYTES) {
    throw new Error(`jj:${workspace.name} holds ${Math.ceil(total / 1024 / 1024)} MiB of evidence under evidencePaths, more than the ${MAX_EVIDENCE_BYTES / 1024 / 1024} MiB retirement preserves; move what is needed elsewhere, then retire it`);
  }
  // Only this workspace's own copies: `fix-x-2-<stamp>.partial` belongs to another workspace than `fix-x`.
  for (const entry of await readdir(evidenceHome()).catch(() => [])) {
    if (entry.startsWith(`${workspace.name}-`) && EVIDENCE_STAMP.test(entry.slice(workspace.name.length + 1).replace(/\.partial$/, "")) && entry.endsWith(".partial")) {
      await rm(join(evidenceHome(), entry), { recursive: true, force: true });
    }
  }
  const directory = join(evidenceHome(), `${workspace.name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const partial = `${directory}.partial`;
  const recorded: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const file of inventory.files) {
    const destination = join(partial, "files", file.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(join(workspace.root, file.path), destination);
    recorded.push({ path: file.path, bytes: file.bytes, sha256: createHash("sha256").update(await readFile(destination)).digest("hex") });
  }
  const metadata = await workspaceMetadata(workspace.name);
  const landing = await readLandingState(workspace.name, { readOnly: true });
  const commit = await jj(workspace.root, ["--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "commit_id"]).catch(() => null);
  await mkdir(partial, { recursive: true, mode: 0o700 });
  await writeFile(join(partial, "provenance.json"), `${JSON.stringify({
    version: 1,
    workspaceName: workspace.name,
    workspacePath: workspace.root,
    repository: integrationRoot,
    issueNumber: metadata?.issueNumber ?? null,
    task: typeof metadata?.task === "string" ? metadata.task : null,
    workingCopyCommitId: commit,
    landing: landing ? { artifactCommitId: landing.artifactCommitId, artifactChangeId: landing.artifactChangeId, integrationBranch: landing.integrationBranch } : null,
    preservedAt: new Date().toISOString(),
    files: recorded,
    links: inventory.links,
    skipped: inventory.skipped,
  }, null, 2)}\n`, { mode: 0o600 });
  for (const file of recorded) {
    if (!existsSync(join(partial, "files", file.path))) throw new Error(`jj:${workspace.name} evidence copy is incomplete (${file.path}); kept`);
  }
  await rename(partial, directory);
  return { directory, inventory: JSON.stringify(inventory) };
}

/** Whether a checkout's evidence still matches what `preserveWorkspaceEvidence` copied. */
async function evidenceUnchanged(integrationRoot: string, root: string, inventory: string): Promise<boolean> {
  const { generated, evidence } = await declaredPaths(integrationRoot);
  return JSON.stringify(await evidenceInventory(root, generated, evidence)) === inventory;
}

/** Unregister a workspace from JJ and discard its checkout (`discardCheckout`), through the host's guarded forget when given. */
export async function forgetWorkspace(integrationRoot: string, workspaceName: string, workspacePath: string, hooks: Pick<RetirementHooks, "forget"> = {}): Promise<void> {
  if (hooks.forget) return hooks.forget(integrationRoot, workspaceName, workspacePath);
  await jj(integrationRoot, ["--ignore-working-copy", "workspace", "forget", workspaceName]);
  await discardCheckout(workspacePath);
  // JJ 0.46+ backs a colocated workspace with a Git worktree and leaves its registration behind
  // when the checkout was already gone, which blocks a new workspace at the same path. Not a
  // worktree (older JJ, non-colocated repository) is the usual case and fails harmlessly.
  await run("git", ["worktree", "remove", "--force", workspacePath], { cwd: integrationRoot, timeoutMs: 10_000 });
}

/**
 * Why removing an unused checkout must be refused whatever its work: outside workspace
 * storage, or holding runner facts not yet delivered. Reads only, so the retention plan
 * judges removal by the same rules.
 */
export async function removalRefusal(workspace: { name: string; root: string }, metadata: WorkspaceMetadata | null | undefined): Promise<string | null> {
  if (!await withinWorkspaceStorage(workspace.root))
    return "Refusing to remove a workspace outside ~/.slipjay/workspaces, ~/.slipway/workspaces and ~/.pi/workspaces";
  if (hasPendingRunnerFacts(metadata ?? null)) return `jj:${workspace.name} has pending runner facts; reconnect from that workspace to deliver them before removal`;
  return null;
}

/**
 * The one retirement step for an isolated checkout, behind cleanup, remove and every sweep: run
 * the repository's `workspaceTeardown` (best effort), preserve its evidence, then forget it,
 * delete it and its sidecars, and report the release. A host supplies its guarded forget and its
 * lifecycle event; the default forgets through JJ and removes the directory. `expectedCommitId` refuses a working copy that moved since it was
 * judged; `retainMaterial` also refuses one that gained files retirement would delete; a change
 * to its evidence during the copy is refused too (each throws `WorkingCopyChangedError`).
 */
export async function retireWorkspace(integrationRoot: string, workspace: { name: string; root: string }, hooks: RetirementHooks = {}, options: { expectedCommitId?: string; retainMaterial?: boolean } = {}): Promise<void> {
  const metadata = await workspaceMetadata(workspace.name);
  if (hasPendingRunnerFacts(metadata)) throw new Error(`jj:${workspace.name} has pending runner facts; reconnect from that workspace to deliver them before removal`);
  await runWorkspaceTeardown(integrationRoot, workspace, { timeoutMs: hooks.teardownTimeoutMs });
  const present = Boolean(workspace.root) && existsSync(workspace.root);
  // A spare is retired only when the pool has too many; any other checkout's dependencies may become
  // the next spare. It is made now, before the last checks, so they stay next to the forget.
  const handover = present && metadata?.spare !== true ? await reserveSpareForHandover(integrationRoot, workspace.root).catch(() => null) : null;
  try {
    const preserved = present ? await preserveWorkspaceEvidence(integrationRoot, workspace) : null;
    try {
      await hooks.afterEvidence?.();
      // The last look before the point of no return, after the teardown and the evidence copy: a working
      // copy that moved since it was judged (an edit snapshots into a new commit) is never forgotten, or its
      // commit would be orphaned, and neither is one that gained a file no history holds or whose evidence
      // changed since it was copied.
      if (options.expectedCommitId && present) {
        const current = await workingCopyCommit(workspace.root).catch(() => null);
        if (current !== options.expectedCommitId) throw new WorkingCopyChangedError(workspace.name);
      }
      if (options.retainMaterial && present && (await retainedWorkspaceMaterial(workspace.root, integrationRoot, 1)).length) {
        throw new WorkingCopyChangedError(workspace.name);
      }
      if (preserved && !await evidenceUnchanged(integrationRoot, workspace.root, preserved.inventory)) throw new WorkingCopyChangedError(workspace.name);
    } catch (error) {
      // The checkout is kept, evidence and all: a later retirement copies it afresh.
      if (preserved) await rm(preserved.directory, { recursive: true, force: true });
      throw error;
    }
    const moveStarted = performance.now();
    const moved = handover ? await moveNodeModules(workspace.root, handover.path, handover.manifests) : [];
    const moveMs = Math.round(performance.now() - moveStarted);
    try {
      await forgetWorkspace(integrationRoot, workspace.name, workspace.root, hooks);
      // Recorded once the checkout is gone, before the refill that adopts the spare starts: it names
      // the spare's source `handover`, and the log shows the move itself.
      if (handover && moved.length) {
        const metadata = await workspaceMetadata(handover.name);
        if (metadata) await writeWorkspaceJson(metadataPath(handover.name), { ...metadata, dependencyHandover: { from: workspace.name, trees: moved.length } }).catch(() => undefined);
        await appendPoolRefillLog({ handover: true, project: await repositoryProjectCode(integrationRoot), integrationRoot, from: workspace.name,
          workspacePath: handover.path, name: handover.name, trees: moved.length, moveMs });
      }
    } catch (error) {
      // A checkout that stays keeps its dependencies.
      if (handover) await moveNodeModules(handover.path, workspace.root, moved);
      throw error;
    }
  } finally {
    if (handover) await releaseSpareHandover(handover);
  }
  await rm(metadataPath(workspace.name), { force: true });
  for (const path of landingStatePaths(workspace.name)) await rm(path, { force: true });
  await rm(lockPath(workspace.name), { force: true });
  const issueNumber = Number.isInteger(metadata?.issueNumber) && metadata!.issueNumber! > 0 ? metadata!.issueNumber! : null;
  hooks.onReleased?.({ workspaceName: workspace.name, projectRoot: integrationRoot, issueNumber });
}

