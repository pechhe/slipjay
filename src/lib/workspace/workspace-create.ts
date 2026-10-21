import type { WorkspaceContext, WorkspaceEntry } from "../infra/workspace-jj.ts";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ensureRepoConfig, integrationTrunkConfig, legacyIssueWorkspaceName, parseWorkspaceList, repositoryProjectCode, revisionFacts, run, taskWorkspaceName, wipDescription, workspaceContext, workspaceHasUnintegratedWork } from "../infra/workspace-jj.ts";
import { metadataHome, startFetchHome, workspaceHome } from "./workspace-paths.ts";
import {
  assertIssueAvailable,
  assertWorkspaceMutationAllowed,
  attachWorkspaceIssue,
  listWorkspaces,
  metadataPath,
  workspaceMetadata,
} from "./workspace-state.ts";
import { readIntegrationPolicy, UNDECLARED_POLICY } from "../policy/execution-policy.ts";
import { fetchIntegration, publicationRemote } from "../landing/landing-steps.ts";
import { forgetMissingCheckout, missingCheckoutRefusal } from "./workspace-lifecycle.ts";
import { startHousekeeping } from "./workspace-housekeeping.ts";
import { beginAttempt, updateAttempt } from "./workspace-attempts.ts";
import { claimSpare, refreshDependencies } from "./workspace-pool.ts";
import { timed } from "./start-steps.ts";
import type { StartSteps } from "./start-steps.ts";
import { linkSharedPaths } from "./workspace-shared-paths.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "../infra/workspace-transaction.ts";

/** Host seams for assigning a workspace; each defaults to plain JJ or package-manager installation. */
export interface WorkspaceCreationHooks<Readiness = unknown> {
  addWorkspace?: (integrationRoot: string, workspacePath: string, baseSha: string, workspaceName: string) => Promise<unknown>;
  prepare?: (integrationRoot: string, workspacePath: string) => Promise<Readiness>;
  onAcquired?: (acquisition: { workspaceName: string; projectRoot: string; issueNumber: number | null }) => void;
  forget?: (integrationRoot: string, workspaceName: string, workspacePath: string) => Promise<void>;
}

/** An assigned workspace together with its creation outcome and host readiness. */
export type CreatedWorkspace<Readiness = unknown> = WorkspaceContext & {
  context: WorkspaceContext;
  created: boolean;
  reused: boolean;
  pooled: boolean;
  workspacePath: string;
  readiness: Readiness;
  /** Where this start spent its time (see start-steps.ts). */
  steps: StartSteps;
};

/** `base` is the commit a new workspace starts from instead of the integration head (see `resolveStartBase`). */
/** `attemptId` makes the start durable and recoverable as that allocation attempt (see workspace-attempts). */
type WorkspaceCreationOptions<Readiness = unknown> = { issueNumber?: number; base?: string; attemptId?: string; hooks?: WorkspaceCreationHooks<Readiness>; steps?: StartSteps };
type RecoveryIdentity = { changeId?: string; commitId?: string };
type AssignmentOptions = {
  issueNumber?: number;
  attach?: boolean;
  workspacePath?: string;
  prepared?: unknown;
  installInputs?: string | null;
  created: boolean;
  reused: boolean;
  pooled?: boolean;
  steps?: StartSteps;
};
type AssignedWorkspace = {
  hooks: WorkspaceCreationHooks;
  context: WorkspaceContext;
  issueNumber: number | undefined;
  prepared: unknown;
  installInputs: string | null | undefined;
  workspace: Omit<CreatedWorkspace, "readiness" | "steps">;
  steps: StartSteps;
};

/**
 * The one implementation of assigning an isolated JJ workspace: bind the current
 * one, resume or recover an Issue's workspace, claim a prepared spare, or add a
 * fresh one at the integration head. A host (Peach) supplies its native add,
 * readiness, ownership event and guarded forget through `hooks`; the defaults
 * use plain JJ and package-manager installation.
 */
const WORKSPACE_LIST_TEMPLATE = 'name ++ "\\t" ++ root ++ "\\t" ++ target.change_id() ++ "\\t" ++ target.commit_id() ++ "\\n"';

const exists = (path: string) => existsSync(path);

async function jj(cwd: string, args: string[]) {
  const result = await run("jj", ["--color=never", ...args], { cwd });
  if (result.code !== 0) throw new Error(`jj ${args.slice(0, 3).join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

/** A JJ command whose failure the caller interprets. */
const tryJj = (cwd: string, args: string[]) => run("jj", ["--color=never", ...args], { cwd });

async function addWorkspace(hooks: WorkspaceCreationHooks, integrationRoot: string, workspacePath: string, baseSha: string, name: string) {
  if (hooks.addWorkspace) return hooks.addWorkspace(integrationRoot, workspacePath, baseSha, name);
  await jj(integrationRoot, ["workspace", "add", "--name", name, "--revision", baseSha, workspacePath]);
}

// Default preparation records the install inputs it made ready, so this checkout can seed others (see
// refreshDependencies); a claimed spare's stale dependencies are installed over in place.
const prepare = (hooks: WorkspaceCreationHooks, integrationRoot: string, workspacePath: string, installInputs?: string | null, steps?: StartSteps) => hooks.prepare
  ? hooks.prepare(integrationRoot, workspacePath)
  : refreshDependencies(integrationRoot, workspacePath, { installInputs, steps });

function acquired(hooks: WorkspaceCreationHooks, context: WorkspaceContext, issueNumber: number | undefined) {
  hooks.onAcquired?.({ workspaceName: context.current.name, projectRoot: context.integration.root, issueNumber: issueNumber ?? null });
}

/**
 * Record which allocation attempt holds the checkout: the attempt that created or claimed it
 * (`owned`), or none once a later start binds or resumes it, so an earlier attempt's release
 * can never remove a checkout someone resumed. Then the attempt, if any, learns its checkout.
 */
async function assignAttempt(attemptId: string | undefined, workspaceName: string, workspacePath: string, owned: boolean) {
  const existing = await workspaceMetadata(workspaceName);
  const allocationAttempt = owned ? attemptId ?? null : null;
  // Always recorded, null included: only a checkout no start has finished assigning lacks the marker.
  if (existing?.allocationAttempt !== allocationAttempt) {
    await mkdir(metadataHome(), { recursive: true, mode: 0o700 });
    await writeWorkspaceJson(metadataPath(workspaceName), { ...existing, allocationAttempt });
  }
  if (attemptId) await updateAttempt(attemptId, { workspaceName, workspacePath, owned });
}

async function writeWorkspaceTaskMetadata(context: WorkspaceContext, task: string) {
  const normalized = task.trim().slice(0, 500);
  if (context.current.name === "default") return;
  const existing = await workspaceMetadata(context.current.name);
  if (!normalized) {
    // Without a task, a resumed workspace still records its assignment time, which the sweep's idle wait measures.
    if (existing) await writeFile(metadataPath(context.current.name), JSON.stringify({ ...existing, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    return;
  }
  await mkdir(dirname(metadataPath(context.current.name)), { recursive: true, mode: 0o700 });
  const creationOperationId = typeof existing?.workspaceCreationOperationId === "string"
    ? existing.workspaceCreationOperationId
    : await jj(context.current.root, ["op", "log", "-n", "1", "--no-graph", "-T", "self.id()"]);
  await writeFile(metadataPath(context.current.name), JSON.stringify({
    ...existing,
    version: 1,
    workspaceName: context.current.name,
    workspacePath: context.current.root,
    integrationRoot: context.integration.root,
    task: normalized,
    implementationChangeId: existing ? existing.implementationChangeId : context.current.changeId,
    workspaceCreationOperationId: creationOperationId,
    workspaceCreationName: typeof existing?.workspaceCreationName === "string" ? existing.workspaceCreationName : context.current.name,
    workspaceCreationPath: typeof existing?.workspaceCreationPath === "string" ? existing.workspaceCreationPath : context.current.root,
    updatedAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });
}

/** JJ records commits with the repository's Git author identity. */
async function applyWorkspaceAuthorIdentity(sourceRoot: string, workspacePath: string) {
  const gitConfig = async (key: string) => {
    const result = await run("git", ["config", key], { cwd: sourceRoot, timeoutMs: 10_000 });
    return result.code === 0 ? result.stdout.trim() : null;
  };
  const [name, email] = await Promise.all([gitConfig("user.name"), gitConfig("user.email")]);
  if (!name || !email) return;
  await jj(workspacePath, ["config", "set", "--repo", "user.name", name]).catch(() => undefined);
  await jj(workspacePath, ["config", "set", "--repo", "user.email", email]).catch(() => undefined);
}

/**
 * The Issue's one healthy workspace, or null. A registered workspace missing on
 * disk is forgotten when that loses nothing and fails closed otherwise.
 */
export async function findIssueWorkspace(cwd: string, issueNumber: number, hooks: Pick<WorkspaceCreationHooks, "forget"> = {}): Promise<WorkspaceEntry | null> {
  const matches = (await listWorkspaces(cwd)).filter((entry) => entry.metadata?.issueNumber === issueNumber);
  const healthy: WorkspaceEntry[] = [];
  for (const workspace of matches) {
    if (workspace.root && exists(workspace.root)) healthy.push(workspace);
    else {
      const refusal = await missingCheckoutRefusal(cwd, workspace);
      if (refusal) throw new Error(`Issue #${issueNumber} workspace jj:${workspace.name} ${refusal}`);
      await forgetMissingCheckout(cwd, workspace, hooks);
    }
  }
  if (healthy.length > 1) throw new Error(`Issue #${issueNumber} is associated with multiple JJ workspaces; reconcile them explicitly`);
  return healthy[0] ?? null;
}

/**
 * Why `start --integration --issue <n>` run from `cwd` must not allocate, or null. A host such as
 * T3 Code gives each session its workspace when the session starts, so a caller standing in its own
 * isolated workspace that has no Issue and holds no work attaches the Issue there
 * (`slipjay attach-issue`) instead of taking a second checkout. Resuming the Issue's existing
 * or recovering workspace (registered, or a surviving checkout at its path), and any start from a
 * spare, an Issue's workspace or one with work, proceeds.
 */
export async function unusedWorkspaceStartRefusal(cwd: string, issueNumber: number): Promise<string | null> {
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default") return null;
  const metadata = await workspaceMetadata(context.current.name);
  if (metadata?.spare || metadata?.issueNumber) return null;
  // Only looks: the start itself resumes or recovers the Issue's checkout under the allocation lock.
  const issueName = await newWorkspaceName(cwd, context.integration.root, issueNumber, "");
  if (exists(join(workspaceHome(), issueName))) return null;
  if ((await listWorkspaces(cwd, { readOnly: true })).some((entry) => entry.metadata?.issueNumber === issueNumber)) return null;
  if (await workspaceHasUnintegratedWork(context.current.root, context.integrationBranch)) return null;
  return `jj:${context.current.name} is this session's workspace and holds no work: run \`slipjay attach-issue ${issueNumber}\` in it instead of starting another`;
}

/** The repository context from its default workspace record, for a cwd JJ no longer lists. */
async function contextFromDefaultRecord(cwd: string) {
  const listed = await tryJj(cwd, ["--ignore-working-copy", "workspace", "list", "-T", WORKSPACE_LIST_TEMPLATE]);
  const integration = listed.code === 0 ? parseWorkspaceList(listed.stdout).find((entry) => entry.name === "default" && entry.root) : null;
  if (!integration) return null;
  const root = await realpath(integration.root);
  const { integrationBranch, policy } = await readIntegrationPolicy(root, { hintRoot: root });
  const entry = { ...integration, root };
  return { current: entry, integration: entry, integrationBranch, configuration: policy ?? UNDECLARED_POLICY };
}

/** The surviving working-copy commit whose JJ history proves it is `workspaceName`. */
async function historicalIdentity(workspacePath: string, workspaceName: string, operationIds: string[], identity: RecoveryIdentity | undefined, issueNumber: number) {
  if (identity) {
    if (!identity.changeId && !identity.commitId) throw new Error(`Issue #${issueNumber} explicit recovery requires a JJ change or commit identity`);
    for (const operationId of operationIds) {
      const historical = await tryJj(workspacePath, ["--at-op", operationId, "log", "-r", "@", "--no-graph", "-T",
        'change_id ++ "\\t" ++ commit_id ++ "\\t" ++ conflict ++ "\\n"']);
      if (historical.code !== 0) continue;
      const [changeId = "", commitId = "", conflict = ""] = historical.stdout.trim().split("\t");
      if (!/^[0-9a-f]{40,64}$/i.test(commitId) || conflict === "true") continue;
      if (identity.changeId && changeId !== identity.changeId) continue;
      if (identity.commitId && commitId.toLowerCase() !== identity.commitId.toLowerCase()) continue;
      return commitId.toLowerCase();
    }
    throw new Error(`Issue #${issueNumber} explicit recovery identity does not match the surviving working-copy history`);
  }
  for (const operationId of operationIds) {
    const historical = await tryJj(workspacePath, ["--at-op", operationId, "log", "-r", "@", "--no-graph", "-T", 'commit_id ++ "\\n"']);
    const commitId = historical.code === 0 ? historical.stdout.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{40,64}$/.test(commitId)) continue;
    const workspaces = await tryJj(workspacePath, ["--at-op", operationId, "workspace", "list", "--template",
      'self.name() ++ "\\t" ++ self.root() ++ "\\t" ++ self.target().commit_id() ++ "\\n"']);
    if (workspaces.code !== 0) continue;
    if (workspaces.stdout.split(/\r?\n/).some((line) => {
      const [name, , target] = line.split("\t");
      return name === workspaceName && target?.toLowerCase() === commitId;
    })) return commitId;
  }
  return "";
}

/**
 * Re-register an Issue workspace whose checkout survives at its deterministic
 * path: verify it belongs to this repository and restore its working copy from
 * its own JJ history. Anything ambiguous is preserved for explicit recovery.
 */
async function recoverExistingIssueWorkspace(cwd: string, workspacePath: string, workspaceName: string, issueNumber: number, identity?: RecoveryIdentity) {
  const normalizedPath = resolve(workspacePath);
  const context = await workspaceContext(cwd) ?? (identity ? await contextFromDefaultRecord(cwd) : null);
  if (!context) throw new Error(`Issue #${issueNumber} recovery requires a Jujutsu repository`);
  const listed = await jj(context.integration.root, ["--ignore-working-copy", "workspace", "list", "-T", WORKSPACE_LIST_TEMPLATE]);
  const registered = parseWorkspaceList(listed).find((entry) => entry.name === workspaceName);
  if (registered?.root) {
    if (resolve(registered.root) !== normalizedPath) {
      throw new Error(`Issue #${issueNumber} workspace jj:${workspaceName} is registered at another path; reconcile it explicitly`);
    }
    const resumed = await workspaceContext(normalizedPath);
    if (!resumed || resumed.current.name !== workspaceName) {
      throw new Error(`Issue #${issueNumber} workspace jj:${workspaceName} could not be verified at its deterministic path`);
    }
    return resumed;
  }
  if (registered) {
    const resumed = await workspaceContext(normalizedPath).catch(() => null);
    if (resumed?.current.name === workspaceName && resolve(resumed.current.root) === normalizedPath) return resumed;
    throw new Error(`Issue #${issueNumber} workspace jj:${workspaceName} has stale native registration without a checkout path; preserve it for explicit recovery`);
  }
  if (!exists(join(normalizedPath, ".jj"))) {
    throw new Error(`Issue #${issueNumber} destination already exists but is not a recoverable JJ working copy; preserve it for explicit recovery`);
  }
  const integrationRepository = await jj(context.integration.root, ["--ignore-working-copy", "git", "root"]);
  const orphanRepository = await tryJj(normalizedPath, ["--ignore-working-copy", "git", "root"]);
  if (orphanRepository.code !== 0) {
    throw new Error(`Issue #${issueNumber} destination is not a readable JJ working copy; preserve it for explicit recovery`);
  }
  const [expected, actual] = await Promise.all([
    realpath(integrationRepository).catch(() => ""),
    realpath(orphanRepository.stdout.trim()).catch(() => ""),
  ]);
  if (!expected || !actual || expected !== actual) {
    throw new Error(`Issue #${issueNumber} destination belongs to another Jujutsu repository; preserve it for explicit recovery`);
  }
  const operations = await jj(normalizedPath, ["op", "log", "--no-graph", "-T", 'self.id() ++ "\\n"']);
  const operationIds = operations.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 64);
  const preservedCommit = await historicalIdentity(normalizedPath, workspaceName, operationIds, identity, issueNumber);
  if (!preservedCommit) {
    throw new Error(`Issue #${issueNumber} destination has no unambiguous historical jj:${workspaceName} identity; preserve it for explicit recovery`);
  }
  const facts = await revisionFacts(context.integration.root, preservedCommit).catch(() => null);
  if (!facts || facts.conflict) {
    throw new Error(`Issue #${issueNumber} orphaned workspace has unreadable or conflicted JJ state; preserve it for explicit recovery`);
  }
  await jj(normalizedPath, ["edit", preservedCommit]);
  const recovered = await workspaceContext(normalizedPath);
  if (!recovered || recovered.current.name !== workspaceName || resolve(recovered.current.root) !== normalizedPath) {
    throw new Error(`Issue #${issueNumber} orphaned workspace recovery could not verify the restored identity`);
  }
  return recovered;
}

/** Explicitly re-register an Issue's surviving checkout, proven by its JJ change or commit identity. */
export async function recoverIssueWorkspace(cwd: string, options: { issueNumber: number; workspaceName: string; changeId?: string; commitId?: string }, hooks: WorkspaceCreationHooks = {}): Promise<WorkspaceContext> {
  const { issueNumber, workspaceName } = options;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error("Issue number must be a positive integer");
  const root = await realpath(cwd);
  const folder = basename(root);
  const expectedName = taskWorkspaceName(await repositoryProjectCode(root), issueNumber);
  if (workspaceName !== expectedName && workspaceName !== legacyIssueWorkspaceName(folder, issueNumber)) {
    throw new Error(`Issue #${issueNumber} explicit recovery workspace must be jj:${expectedName}`);
  }
  const prior = await workspaceMetadata(workspaceName);
  if (typeof prior?.issueNumber === "number" && prior.issueNumber !== issueNumber) {
    throw new Error(`Issue #${issueNumber} explicit recovery conflicts with existing workspace Issue metadata`);
  }
  await assertIssueAvailable(cwd, issueNumber, workspaceName);
  const workspacePath = join(workspaceHome(), workspaceName);
  try {
    const recovered = await recoverExistingIssueWorkspace(cwd, workspacePath, workspaceName, issueNumber, {
      ...(options.changeId ? { changeId: options.changeId } : {}), ...(options.commitId ? { commitId: options.commitId } : {}),
    });
    await attachWorkspaceIssue(workspacePath, issueNumber);
    await prepare(hooks, recovered.integration.root, recovered.current.root);
    return recovered;
  } finally {
    // Like `createWorkspace`, recovery schedules the repository's bounded background sweep.
    await startHousekeeping(root).catch(() => undefined);
  }
}

/**
 * The commit `revision` names in the checkout at `cwd`, as a start base: a lead's
 * revision for a helper that must see its unlanded work. The caller's own
 * working-copy commit is refused, since every snapshot rewrites it and jj would
 * rebase the helper's checkout under it; commit first (`jj new`) and pass `@-`.
 */
export async function resolveStartBase(cwd: string, revision: string): Promise<string> {
  const [resolved, ...more] = (await jj(cwd, ["log", "-r", revision, "--no-graph", "-T", 'commit_id ++ "\\n"'])).split("\n").filter(Boolean);
  if (!resolved || more.length) throw new Error(`Start base '${revision}' must name exactly one commit`);
  const workingCopy = await jj(cwd, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
  if (resolved === workingCopy) throw new Error(`Start base '${revision}' is this checkout's working copy, which jj rewrites on every snapshot: run \`jj new\` and pass @-`);
  return resolved;
}

/**
 * Assign an isolated workspace for `task`. From an isolated workspace, that
 * workspace is bound (unless it has landed). With `issueNumber`, the Issue's
 * workspace is resumed, or its surviving checkout recovered, before a new one is
 * made. Allocation is serialized per repository; dependency installation runs
 * after that lock is released, serialized per checkout. Built-in dependency installs
 * also serialize per repository so later starts can clone the earlier install.
 */
export async function createWorkspace<Readiness = unknown>(task: string, cwd: string = process.cwd(), options: WorkspaceCreationOptions<Readiness> = {}): Promise<CreatedWorkspace<Readiness>> {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Workspace isolation requires a Jujutsu repository");
  // Before the allocation lock, so concurrent starts never queue behind each other's fetch.
  const { attemptId } = options;
  if (attemptId) await beginAttempt(attemptId, context.integration.root, options.issueNumber ?? null);
  const steps: StartSteps = {};
  try {
    if (await mayStartFromIntegrationHead(cwd, context, options)) await timed(steps, "fetch", () => refreshIntegration(context));
    const allocation: AssignedWorkspace = await withWorkspaceTransaction(`allocate:${context.integration.root}`, () => createWorkspaceUnlocked(task, cwd, { ...options, steps }));
    if (attemptId) await updateAttempt(attemptId, { status: "preparing" });
    // Concurrent starts that resolve to one checkout (the same Issue, or a bind) prepare it in turn.
    const created = await withWorkspaceTransaction(`prepare:${allocation.context.current.root}`, () => ready(allocation)) as CreatedWorkspace<Readiness>;
    if (attemptId) await updateAttempt(attemptId, { status: "ready", finishedAt: new Date().toISOString() });
    return created;
  } catch (error) {
    if (attemptId) await updateAttempt(attemptId, { status: "failed", finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    throw error;
  } finally {
    // Every allocation, including a failed one, schedules the repository's bounded background sweep.
    await startHousekeeping(context.integration.root).catch(() => undefined);
  }
}

/**
 * Record the task (and Issue) on the allocated workspace, under the allocation lock.
 * `prepared` is a claimed spare's still-exact provisioned readiness, used instead
 * of reinstalling; otherwise `installInputs` is its fingerprint, which the install reuses. Resumed and bound workspaces always reinstall: commands run in
 * them may have changed `node_modules` without changing the install inputs.
 */
async function assigned(hooks: WorkspaceCreationHooks, context: WorkspaceContext, task: string, { issueNumber, attach = true, workspacePath = context.current.root, prepared, installInputs, steps = {}, ...result }: AssignmentOptions): Promise<AssignedWorkspace> {
  await writeWorkspaceTaskMetadata(context, task);
  // Repository-wide, so every workspace's trunk() (and the briefs pinned from it) names this repository's integration.
  await ensureRepoConfig(context.current.root, integrationTrunkConfig(context.integrationBranch, context.configuration.remote ?? "origin"));
  if (issueNumber && attach) await attachWorkspaceIssue(context.current.root, issueNumber);
  await timed(steps, "describe", () => describeAssignedWorkspace(context, task, issueNumber));
  if (context.current.name !== "default") await linkSharedPaths(context.integration.root, context.current.root);
  return { hooks, context, issueNumber, prepared, installInputs, steps, workspace: { ...context, context, pooled: false, ...result, workspacePath } };
}

/**
 * Describe-first: an empty, undescribed working-copy change gets `wip: <task> (#<n>)`,
 * so a change someone abandons mid-task is never anonymous. Work already in the
 * change (a resumed workspace) and any description already there are left alone;
 * landing treats exactly that generated text (recorded in the workspace metadata) as no description.
 */
async function describeAssignedWorkspace(context: WorkspaceContext, task: string, issueNumber: number | undefined) {
  if (context.current.name === "default" || !task?.trim()) return;
  try {
    const facts = await revisionFacts(context.current.root, "@");
    if (facts.empty && !facts.description.trim()) {
      const generated = wipDescription(task, issueNumber);
      await jj(context.current.root, ["describe", "-r", "@", "-m", generated]);
      // Only this exact text is a placeholder; a description a person writes, `wip:` or not, is theirs.
      await writeWorkspaceJson(metadataPath(context.current.name), { ...await workspaceMetadata(context.current.name), generatedDescription: generated });
    }
  } catch (error) {
    console.error(`[describe] could not describe jj:${context.current.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Make an allocated workspace's checkout ready and report its acquisition. */
async function ready({ hooks, context, issueNumber, prepared, installInputs: claimedInputs, steps, workspace }: AssignedWorkspace): Promise<CreatedWorkspace> {
  if (prepared) console.error(`[deps] ${basename(context.current.root)}: install inputs unchanged since the spare was prepared; reusing its dependencies`);
  const readiness = prepared ?? await timed(steps, "install", () => prepare(hooks, context.integration.root, context.current.root, claimedInputs, steps));
  // Fresh installs publish readiness under their install lock; reused spares need their record restored after assignment.
  const { state, packageManager, installInputs } = (hooks.prepare ? {} : prepared ?? {}) as { state?: string; packageManager?: string | null; installInputs?: string | null };
  if (installInputs) {
    await writeWorkspaceJson(metadataPath(context.current.name), { ...await workspaceMetadata(context.current.name), preparedDependencies: { state, packageManager, installInputs } });
  }
  acquired(hooks, context, issueNumber);
  return { ...workspace, readiness, steps };
}

const START_FETCH_TIMEOUT_MS = 30_000;
const START_FETCH_REUSE_MS = 30_000;

/**
 * Whether this start may base a new workspace on the integration head, so it should fetch
 * first: not on a pinned base, not binding the current workspace and not resuming an Issue's.
 * Read without the allocation lock, so a race only costs a needless fetch or skips a best-effort one.
 */
async function mayStartFromIntegrationHead(cwd: string, context: WorkspaceContext, { issueNumber, base }: WorkspaceCreationOptions) {
  if (base || context.current.name !== "default") return false;
  return !issueNumber || !(await listWorkspaces(cwd, { readOnly: true })).some((entry) => entry.metadata?.issueNumber === issueNumber);
}

/**
 * Bring the integration branch up to its declared remote before a new workspace
 * is based on it, so work started on one machine sees what another has landed.
 * A start within `START_FETCH_REUSE_MS` of the last successful one reuses that
 * fetch, and a start arriving while another fetches waits for it and reuses it, so
 * a burst of starts fetches once. Best effort: offline or failing, the workspace
 * starts from the local branch and landing still fetches and rebases.
 */
async function refreshIntegration(context: WorkspaceContext) {
  const remote = publicationRemote(context);
  if (!remote) return;
  const key = `${resolve(context.integration.root)}\0${remote}\0${context.integrationBranch}`;
  const marker = join(startFetchHome(), `${createHash("sha256").update(key).digest("hex")}.stamp`);
  const fresh = async () => {
    const fetchedAt = await stat(marker).then((info) => info.mtimeMs, () => 0);
    // A marker from the future (the clock moved back) proves nothing.
    const age = Date.now() - fetchedAt;
    return age >= 0 && age < START_FETCH_REUSE_MS;
  };
  if (await fresh()) return;
  // Held for one bounded fetch, and only by starts of this repository and branch.
  await withWorkspaceTransaction(`fetch:${key}`, async () => {
    if (await fresh()) return;
    const fetched = await fetchIntegration(context.integration.root, remote, context.integrationBranch, { timeoutMs: START_FETCH_TIMEOUT_MS });
    if (fetched.code === 0) {
      await mkdir(startFetchHome(), { recursive: true, mode: 0o700 });
      await writeFile(marker, "");
      return;
    }
    const detail = (fetched.stderr || fetched.stdout).trim().split(/\r?\n/).at(-1);
    console.error(`[fetch] could not refresh ${context.integrationBranch} from ${remote}${detail ? `: ${detail}` : ""}; starting from the local branch`);
  });
}

/**
 * The new workspace's name. An Issue's is deterministic so a surviving checkout is
 * found again (under its pre-project-code name too); a task's gains `-2`, `-3`…
 * while another workspace or checkout already holds it.
 */
async function newWorkspaceName(cwd: string, root: string, issueNumber: number | undefined, task: string) {
  const base = taskWorkspaceName(await repositoryProjectCode(root), issueNumber, task);
  if (issueNumber) {
    const legacy = legacyIssueWorkspaceName(basename(root), issueNumber);
    return !exists(join(workspaceHome(), base)) && exists(join(workspaceHome(), legacy)) ? legacy : base;
  }
  const taken = new Set((await listWorkspaces(cwd)).map((workspace) => workspace.name));
  let name = base;
  for (let index = 2; taken.has(name) || exists(join(workspaceHome(), name)); index += 1) name = `${base}-${index}`;
  return name;
}

async function createWorkspaceUnlocked(task: string, cwd: string, options: WorkspaceCreationOptions): Promise<AssignedWorkspace> {
  const { issueNumber, base, hooks = {}, steps } = options;
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Workspace isolation requires a Jujutsu repository");
  // A base only shapes a new workspace: binding the current one or resuming an Issue's would ignore it.
  if (base && (issueNumber || context.current.name !== "default")) {
    throw new Error("A start base needs a new workspace: start from the integration checkout and without an Issue");
  }
  if (context.current.name !== "default") {
    await assertWorkspaceMutationAllowed(context);
    await assignAttempt(options.attemptId, context.current.name, context.current.root, false);
    return assigned(hooks, context, task, { steps,  issueNumber, created: false, reused: false });
  }
  if (issueNumber) {
    const existing = await findIssueWorkspace(cwd, issueNumber, hooks);
    if (existing?.root) {
      const resumed = await workspaceContext(existing.root);
      if (!resumed) throw new Error(`Issue #${issueNumber} workspace disappeared during resume`);
      await assertWorkspaceMutationAllowed(resumed);
      await assignAttempt(options.attemptId, resumed.current.name, existing.root, false);
      return assigned(hooks, resumed, task, { steps,  issueNumber, attach: false, created: false, reused: true, workspacePath: existing.root });
    }
  }
  let name = await newWorkspaceName(cwd, context.integration.root, issueNumber, task);
  await assertIssueAvailable(cwd, issueNumber, name);
  // A surviving Issue checkout at its deterministic path is recovered, never replaced by a spare.
  const survivor = Boolean(issueNumber) && exists(join(workspaceHome(), name));
  // Named before the checkout is claimed or added, so an interrupted start can still be traced to it.
  if (!survivor && options.attemptId) await updateAttempt(options.attemptId, { workspaceName: name, owned: true });
  const spare = survivor ? null : await timed(steps, "claim", () => claimSpare(context, name, base, steps));
  if (spare) name = spare.name;
  const workspacePath = spare?.root ?? join(workspaceHome(), name);
  await mkdir(workspaceHome(), { recursive: true, mode: 0o700 });
  if (survivor) {
    const recovered = await recoverExistingIssueWorkspace(cwd, workspacePath, name, issueNumber!);
    await assignAttempt(options.attemptId, recovered.current.name, workspacePath, false);
    return assigned(hooks, recovered, task, { steps,  issueNumber, created: false, reused: true, workspacePath });
  }
  if (!spare) {
    const baseSha = base ?? await jj(cwd, ["log", "-r", context.integrationBranch, "--no-graph", "-T", "commit_id"]);
    await addWorkspace(hooks, context.integration.root, workspacePath, baseSha, name);
  }
  // A fresh or claimed workspace is a new generation even under a reused Issue name
  // and path: never carry an older one's implementation binding or creation proof.
  await rm(metadataPath(name), { force: true });
  await applyWorkspaceAuthorIdentity(context.integration.root, workspacePath);
  const created = await workspaceContext(workspacePath);
  if (!created || created.current.name !== name) throw new Error("Created workspace could not be verified");
  // A host with its own readiness authority (Peach's `prepare` hook) always decides itself.
  const prepared = hooks.prepare ? undefined : spare?.dependencies ?? undefined;
  const assignment = await assigned(hooks, created, task, { steps, issueNumber, created: true, reused: false, pooled: Boolean(spare), workspacePath, prepared, installInputs: spare?.installInputs });
  await writeWorkspaceJson(metadataPath(name), {
    ...await workspaceMetadata(name),
    adoptionBase: await jj(workspacePath, ["--ignore-working-copy", "log", "-r", "@-", "--no-graph", "-T", "commit_id"]),
  });
  // After the new generation's metadata: until then an interrupted attempt still owns the unmarked checkout.
  await assignAttempt(options.attemptId, name, workspacePath, true);
  return assignment;
}
