import { existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { lstat, readdir, readlink, realpath, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { artifactPublished, finishLandedWorkspace } from "./landing-steps.ts";
import type { WorkspaceContext, WorkspaceMetadata } from "./workspace-jj.ts";
import { revisionExists, run, workingCopyCommit, workspaceContext, workspaceHasUnintegratedWork } from "./workspace-jj.ts";
import { workspaceStorageHomes } from "./workspace-paths.ts";
import { landingStatePaths, listWorkspaces, lockPath, metadataPath, readLandingState, workspaceMetadata } from "./workspace-state.ts";
import type { LandingState } from "./workspace-state.ts";
import { generatedPathMatchers, readExecutionPolicy } from "./execution-policy.ts";
import { cleanupRetentionReason, hasPendingRunnerFacts } from "./workspace-delivery-lifecycle.ts";
import { callerPids, describeHolders, workspaceHolders } from "./workspace-holders.ts";
import { archiveIntegratedWorkspaceEvidence } from "./workspace-finalization.ts";
import { runWorkspaceTeardown } from "./workspace-teardown.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";

/** Host seams for retiring a checkout: its guarded forget and lifecycle event. */
export interface RetirementHooks {
  forget?: (integrationRoot: string, workspaceName: string, workspacePath: string) => Promise<void>;
  onReleased?: (release: { workspaceName: string; projectRoot: string; issueNumber: number | null }) => void;
  /** Overrides the `workspaceTeardown` timeout (tests). */
  teardownTimeoutMs?: number;
  /** Called after cleanup's delivery checks and just before it retires the checkout (tests, hosts). */
  afterChecks?: () => void | Promise<void>;
}

type CleanupResult = {
  cleaned: boolean;
  reason?: string;
  paths?: string[];
  /** A failed post-integration record a later published landing superseded. */
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
  return uniqueUntrackedMaterial(root, limit, await declaredGeneratedPaths(integrationRoot), integrationRoot);
}

/** Paths edited since the checkout's last snapshot, for a reader that must not snapshot (see `editedSinceSnapshot`). */
export async function unsnapshottedEdits(root: string, integrationRoot: string, limit: number = 5): Promise<string[]> {
  return editedSinceSnapshot(root, await declaredGeneratedPaths(integrationRoot), integrationRoot, limit);
}

/** One human explanation of why cleanup kept a landed workspace. */
export function describeRetention(result: { reason?: string; paths?: string[] } | null | undefined): string {
  if (result?.reason !== "unique-files") return String(result?.reason ?? "cleanup did not complete");
  return `holds files cleanup will not delete: ${(result.paths ?? []).join(", ")}`
    + " (remove them, or declare generated output in slipjay.json generatedPaths)";
}

/** Cleanup judges files on disk, so it reads the primary checkout's working policy (strictly). */
async function declaredGeneratedPaths(integrationRoot: string): Promise<RegExp[]> {
  return generatedPathMatchers((await readExecutionPolicy(integrationRoot))?.generatedPaths);
}

/**
 * Visit every entry of a checkout that is not reproducible (a built-in tool cache or
 * a path the repository declares as generated), depth first, until `visit` returns
 * true (stop). Directories are visited before their contents.
 */
async function walkMaterial(root: string, generated: RegExp[], visit: (entry: Dirent, directory: string, path: string) => Promise<boolean | void>): Promise<void> {
  async function walk(directory: string, relative: string): Promise<boolean> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (REPRODUCIBLE.has(entry.name) || entry.name.endsWith(".tsbuildinfo")) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (generated.some((matcher) => matcher.test(`${path}/`))) continue;
      if (await visit(entry, directory, path)) return true;
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

/**
 * Paths changed on disk since JJ last snapshotted the checkout, which a reader that
 * must not snapshot cannot judge, since they may be unlanded work: a tracked file
 * edited or deleted since, or a new file other than a link into the primary checkout.
 * Returns at most `limit` repository-relative paths.
 */
async function editedSinceSnapshot(root: string, generated: RegExp[] = [], primaryRoot: string | null = null, limit: number = 5): Promise<string[]> {
  const snapshot = (await stat(join(root, ".jj", "working_copy", "tree_state"))).mtimeMs;
  const linksIntoPrimary = primaryLinks(primaryRoot);
  const tracked = await snapshotFiles(root);
  const found: string[] = [];
  for (const path of tracked) {
    if (found.length >= limit) return found;
    const changed = await lstat(join(root, path)).then((info) => info.mtimeMs > snapshot, () => true);
    if (changed) found.push(path);
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

/** Thrown when a checkout's working copy changed between cleanup's judgement and its retirement. */
/**
 * Remove the workspace a landing delivered, as `slipjay cleanup` would. Anything
 * else working inside it keeps it, and is named so its owner can stop it.
 */
export async function releaseLandedWorkspace(context: WorkspaceContext) {
  const holders = await workspaceHolders(context.current.root, { ignore: await callerPids() });
  if (!holders) return { cleaned: false, reason: "process working directories unavailable" };
  if (holders.length) return { cleaned: false, reason: `in use by a live process: ${describeHolders(holders)}`, holders };
  const result = await cleanupLandedWorkspace(context.current.root);
  return result.cleaned ? { cleaned: true } : { cleaned: false, reason: describeRetention(result) };
}

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
  const generated = await declaredGeneratedPaths(context.integration.root);
  const commit = readOnly
    ? await jj(context.current.root, ["--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "commit_id"])
    : await workingCopyCommit(context.current.root);
  if (readOnly) {
    const edited = await editedSinceSnapshot(context.current.root, generated, context.integration.root);
    if (edited.length) return { commit, retained: { cleaned: false, reason: "unsnapshotted-edits", paths: edited } };
  }
  // Follow-up work on top of the landed artifact is never deleted.
  if (await workspaceHasUnintegratedWork(context.current.root, context.integrationBranch, { ignoreWorkingCopy: true })) {
    return { commit, retained: { cleaned: false, reason: "new-unlanded-work" } };
  }
  const unique = await uniqueUntrackedMaterial(context.current.root, 5, generated, context.integration.root);
  return { commit, retained: unique.length ? { cleaned: false, reason: "unique-files", paths: unique } : null };
}

type LandedChecks =
  | { ready: false; result: CleanupResult }
  | { ready: true; context: WorkspaceContext; state: LandingState; commit: string };

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
  if (!state) return keep("not-landed");
  if (resolve(state.workspacePath) !== resolve(context.current.root) || state.workspaceName !== context.current.name) {
    throw new Error("Landing state does not match the current workspace");
  }
  let judged = await judgeCheckout(context, { readOnly });
  if (judged.retained) return { ready: false, result: judged.retained };
  // Pending housekeeping is retried below; every other retention reason holds.
  const retention = cleanupRetentionReason({ ...state, cleanupPending: false }, context, await workspaceMetadata(context.current.name));
  if (retention) return keep(retention);
  if (!await revisionExists(context.integration.root, `${state.artifactCommitId} & ::${state.integrationBranch}`))
    throw new Error("Cannot prove the landed artifact is integrated; workspace retained");
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
  return { ready: true, context, state, commit: judged.commit };
}

async function cleanupLandedWorkspaceUnlocked(cwd: string, hooks: RetirementHooks): Promise<CleanupResult> {
  const checks = await landedCleanupChecks(cwd);
  if (!checks.ready) return checks.result;
  const { context, state, commit } = checks;
  const gitDirectory = await jj(context.integration.root, ["--ignore-working-copy", "git", "root"]);
  await archiveIntegratedWorkspaceEvidence(gitDirectory, state);
  await hooks.afterChecks?.();
  try {
    await retireWorkspace(context.integration.root, context.current, hooks, { expectedCommitId: commit });
  } catch (error) {
    if (error instanceof WorkingCopyChangedError) return { cleaned: false, reason: "working-copy-changed" };
    throw error;
  }
  return { cleaned: true };
}

/** Remove an isolated workspace after checking its work and Issue attachment. */
export async function removeWorkspace(cwd: string, workspaceName: string, options: { allowWork?: boolean; allowIssue?: boolean } = {}): Promise<{ workspaceName: string; hasWork: boolean; issueNumber: number | null }> {
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
    const hasWork = judged === null || await workspaceHasUnintegratedWork(target.root, context.integrationBranch, { ignoreWorkingCopy: true }).catch(
      () => true,
    );
    if (hasWork && options.allowWork !== true)
      throw new Error(
        `jj:${workspaceName} contains unlanded work; explicit deletion confirmation is required`,
      );
    if (metadata?.issueNumber && options.allowIssue !== true)
      throw new Error(
        `jj:${workspaceName} is attached to Issue #${metadata.issueNumber}; explicit deletion confirmation is required`,
      );
    await retireWorkspace(context.integration.root, { name: workspaceName, root: target.root }, {},
      judged === null ? {} : { expectedCommitId: judged });
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

/** Unregister a workspace from JJ and delete its checkout, through the host's guarded forget when given. */
export async function forgetWorkspace(integrationRoot: string, workspaceName: string, workspacePath: string, hooks: Pick<RetirementHooks, "forget"> = {}): Promise<void> {
  if (hooks.forget) return hooks.forget(integrationRoot, workspaceName, workspacePath);
  await jj(integrationRoot, ["--ignore-working-copy", "workspace", "forget", workspaceName]);
  await rm(workspacePath, { recursive: true, force: true });
  // JJ 0.46+ backs a colocated workspace with a Git worktree and leaves its registration behind
  // when the checkout was already gone, which blocks a new workspace at the same path. Not a
  // worktree (older JJ, non-colocated repository) is the usual case and fails harmlessly.
  await run("git", ["worktree", "remove", "--force", workspacePath], { cwd: integrationRoot, timeoutMs: 10_000 });
}

/**
 * The one retirement step for an isolated checkout: forget it, delete it and its
 * sidecars, then report the release. The repository's `workspaceTeardown` runs
 * first, best effort, so it also covers cleanup, remove and every sweep. A host supplies its guarded forget and its
 * lifecycle event; the default forgets through JJ and removes the directory.
 * With `options.expectedCommitId`, a working copy that no longer matches it is
 * kept and `WorkingCopyChangedError` thrown.
 */
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

export async function retireWorkspace(integrationRoot: string, workspace: { name: string; root: string }, hooks: RetirementHooks = {}, options: { expectedCommitId?: string } = {}): Promise<void> {
  const metadata = await workspaceMetadata(workspace.name);
  if (hasPendingRunnerFacts(metadata)) throw new Error(`jj:${workspace.name} has pending runner facts; reconnect from that workspace to deliver them before removal`);
  await runWorkspaceTeardown(integrationRoot, workspace, { timeoutMs: hooks.teardownTimeoutMs });
  // The last look before the point of no return, after the teardown: a working copy that moved
  // since it was judged (an edit snapshots into a new commit) is never forgotten, or its commit would be orphaned.
  if (options.expectedCommitId && workspace.root && existsSync(workspace.root)) {
    const current = await workingCopyCommit(workspace.root).catch(() => null);
    if (current !== options.expectedCommitId) throw new WorkingCopyChangedError(workspace.name);
  }
  await forgetWorkspace(integrationRoot, workspace.name, workspace.root, hooks);
  await rm(metadataPath(workspace.name), { force: true });
  for (const path of landingStatePaths(workspace.name)) await rm(path, { force: true });
  await rm(lockPath(workspace.name), { force: true });
  const issueNumber = Number.isInteger(metadata?.issueNumber) && metadata!.issueNumber! > 0 ? metadata!.issueNumber! : null;
  hooks.onReleased?.({ workspaceName: workspace.name, projectRoot: integrationRoot, issueNumber });
}

