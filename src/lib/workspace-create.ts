import type { WorkspaceContext, WorkspaceEntry } from "./workspace-jj.ts";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { legacyIssueWorkspaceName, parseWorkspaceList, repositoryProjectCode, revisionExists, revisionFacts, run, taskWorkspaceName, wipDescription, workspaceContext } from "./workspace-jj.ts";
import { startFetchHome, workspaceHome, workspaceStorageHomes } from "./workspace-paths.ts";
import {
  assertIssueAvailable,
  assertWorkspaceMutationAllowed,
  attachWorkspaceIssue,
  landingStatePaths,
  listWorkspaces,
  metadataPath,
  readLandingState,
  workspaceMetadata,
} from "./workspace-state.ts";
import { readIntegrationPolicy, UNDECLARED_POLICY } from "./execution-policy.ts";
import { fetchIntegration, publicationRemote } from "./landing-steps.ts";
import { forgetWorkspace } from "./workspace-lifecycle.ts";
import { claimSpare, refreshDependencies } from "./workspace-pool.ts";
import { linkSharedPaths } from "./workspace-shared-paths.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "./workspace-transaction.ts";

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
};

type WorkspaceCreationOptions<Readiness = unknown> = { issueNumber?: number; hooks?: WorkspaceCreationHooks<Readiness> };
type RecoveryIdentity = { changeId?: string; commitId?: string };
type AssignmentOptions = {
  issueNumber?: number;
  attach?: boolean;
  workspacePath?: string;
  prepared?: unknown;
  created: boolean;
  reused: boolean;
  pooled?: boolean;
};
type AssignedWorkspace = {
  hooks: WorkspaceCreationHooks;
  context: WorkspaceContext;
  issueNumber: number | undefined;
  prepared: unknown;
  workspace: Omit<CreatedWorkspace, "readiness">;
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
// refreshDependencies); a claimed spare's stale dependencies are replaced by a clone when another checkout has current ones.
const prepare = (hooks: WorkspaceCreationHooks, integrationRoot: string, workspacePath: string, pooled = false) => hooks.prepare
  ? hooks.prepare(integrationRoot, workspacePath)
  : refreshDependencies(integrationRoot, workspacePath, { replace: pooled });

function acquired(hooks: WorkspaceCreationHooks, context: WorkspaceContext, issueNumber: number | undefined) {
  hooks.onAcquired?.({ workspaceName: context.current.name, projectRoot: context.integration.root, issueNumber: issueNumber ?? null });
}

async function writeWorkspaceTaskMetadata(context: WorkspaceContext, task: string) {
  const normalized = task.trim().slice(0, 500);
  if (!normalized || context.current.name === "default") return;
  await mkdir(dirname(metadataPath(context.current.name)), { recursive: true, mode: 0o700 });
  const existing = await workspaceMetadata(context.current.name);
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

/** Forget an Issue workspace whose checkout is gone, only when nothing in it could be lost. */
async function forgetSafeMissingIssueWorkspace(cwd: string, workspace: WorkspaceEntry, issueNumber: number, hooks: Pick<WorkspaceCreationHooks, "forget">) {
  if (workspace.root && exists(workspace.root)) return;
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Missing Issue workspace recovery requires a Jujutsu repository");
  const label = `Issue #${issueNumber} workspace jj:${workspace.name}`;
  const facts = await revisionFacts(cwd, workspace.commitId).catch(() => null);
  if (!facts) throw new Error(`${label} points at an unreadable JJ revision; preserve it for explicit recovery`);
  if (facts.conflict) throw new Error(`${label} has conflicted JJ state; preserve it for explicit recovery`);
  const unintegrated = await jj(cwd, ["log", "-r", `(${context.integrationBranch}..${workspace.commitId}) & ~empty()`, "--no-graph", "-T", 'commit_id.short() ++ "\\n"']);
  if (unintegrated) throw new Error(`${label} is missing on disk but still contains unintegrated work; preserve it for explicit recovery`);
  const landed = await readLandingState(workspace.name);
  if (landed && !await revisionExists(cwd, `${landed.artifactCommitId} & ::${landed.integrationBranch}`)) {
    throw new Error(`${label} has landing evidence that is not integrated; preserve it for explicit recovery`);
  }
  const recordedPath = typeof workspace.metadata?.workspacePath === "string"
    ? workspace.metadata.workspacePath
    : workspace.root || join(workspaceHome(), workspace.name);
  // The checkout is gone, so storage containment is checked lexically, not through realpath.
  const normalizedPath = resolve(recordedPath);
  if (!workspaceStorageHomes().some((home) => normalizedPath.startsWith(`${resolve(home)}${sep}`))) {
    throw new Error(`${label} has an unsafe stale path; preserve it for explicit recovery`);
  }
  await forgetWorkspace(context.integration.root, workspace.name, normalizedPath, hooks);
  if (exists(normalizedPath)) throw new Error(`${label} stale checkout could not be removed safely`);
  await rm(metadataPath(workspace.name), { force: true });
  for (const candidate of landingStatePaths(workspace.name)) await rm(candidate, { force: true });
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
    else await forgetSafeMissingIssueWorkspace(cwd, workspace, issueNumber, hooks);
  }
  if (healthy.length > 1) throw new Error(`Issue #${issueNumber} is associated with multiple JJ workspaces; reconcile them explicitly`);
  return healthy[0] ?? null;
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
  const recovered = await recoverExistingIssueWorkspace(cwd, workspacePath, workspaceName, issueNumber, {
    ...(options.changeId ? { changeId: options.changeId } : {}), ...(options.commitId ? { commitId: options.commitId } : {}),
  });
  await attachWorkspaceIssue(workspacePath, issueNumber);
  await prepare(hooks, recovered.integration.root, recovered.current.root);
  return recovered;
}

/**
 * Assign an isolated workspace for `task`. From an isolated workspace, that
 * workspace is bound (unless it has landed). With `issueNumber`, the Issue's
 * workspace is resumed, or its surviving checkout recovered, before a new one is
 * made. Allocation is serialized per repository; dependency installation runs
 * after that lock is released, serialized only per checkout, so concurrent starts
 * of different workspaces install in parallel.
 */
export async function createWorkspace<Readiness = unknown>(task: string, cwd: string = process.cwd(), options: WorkspaceCreationOptions<Readiness> = {}): Promise<CreatedWorkspace<Readiness>> {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Workspace isolation requires a Jujutsu repository");
  const allocation: AssignedWorkspace = await withWorkspaceTransaction(`allocate:${context.integration.root}`, () => createWorkspaceUnlocked(task, cwd, options));
  // Concurrent starts that resolve to one checkout (the same Issue, or a bind) prepare it in turn.
  return withWorkspaceTransaction(`prepare:${allocation.context.current.root}`, () => ready(allocation)) as Promise<CreatedWorkspace<Readiness>>;
}

/**
 * Record the task (and Issue) on the allocated workspace, under the allocation lock.
 * `prepared` is a claimed spare's still-exact provisioned readiness, used instead
 * of reinstalling. Resumed and bound workspaces always reinstall: commands run in
 * them may have changed `node_modules` without changing the install inputs.
 */
async function assigned(hooks: WorkspaceCreationHooks, context: WorkspaceContext, task: string, { issueNumber, attach = true, workspacePath = context.current.root, prepared, ...result }: AssignmentOptions): Promise<AssignedWorkspace> {
  await writeWorkspaceTaskMetadata(context, task);
  if (issueNumber && attach) await attachWorkspaceIssue(context.current.root, issueNumber);
  await describeAssignedWorkspace(context, task, issueNumber);
  if (context.current.name !== "default") await linkSharedPaths(context.integration.root, context.current.root);
  return { hooks, context, issueNumber, prepared, workspace: { ...context, context, pooled: false, ...result, workspacePath } };
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
async function ready({ hooks, context, issueNumber, prepared, workspace }: AssignedWorkspace): Promise<CreatedWorkspace> {
  if (prepared) console.error(`[deps] ${basename(context.current.root)}: install inputs unchanged since the spare was prepared; reusing its dependencies`);
  const readiness = prepared ?? await prepare(hooks, context.integration.root, context.current.root, workspace.pooled);
  const { state, packageManager, installInputs } = (hooks.prepare ? {} : readiness) as { state?: string; packageManager?: string | null; installInputs?: string | null };
  if (installInputs) {
    await writeWorkspaceJson(metadataPath(context.current.name), { ...await workspaceMetadata(context.current.name), preparedDependencies: { state, packageManager, installInputs } });
  }
  acquired(hooks, context, issueNumber);
  return { ...workspace, readiness };
}

const START_FETCH_TIMEOUT_MS = 30_000;
const START_FETCH_REUSE_MS = 30_000;

/**
 * Bring the integration branch up to its declared remote before a new workspace
 * is based on it, so work started on one machine sees what another has landed.
 * A start within `START_FETCH_REUSE_MS` of the last successful one reuses that
 * fetch, so a burst of starts fetches once. Best effort: offline or failing, the
 * workspace starts from the local branch and landing still fetches and rebases.
 * Runs under the allocation lock, so the marker needs no locking of its own.
 */
async function refreshIntegration(context: WorkspaceContext) {
  const remote = publicationRemote(context);
  if (!remote) return;
  const key = `${resolve(context.integration.root)}\0${remote}\0${context.integrationBranch}`;
  const marker = join(startFetchHome(), `${createHash("sha256").update(key).digest("hex")}.stamp`);
  const fetchedAt = await stat(marker).then((info) => info.mtimeMs, () => 0);
  // A marker from the future (the clock moved back) proves nothing.
  const age = Date.now() - fetchedAt;
  if (age >= 0 && age < START_FETCH_REUSE_MS) return;
  const fetched = await fetchIntegration(context.integration.root, remote, context.integrationBranch, { timeoutMs: START_FETCH_TIMEOUT_MS });
  if (fetched.code === 0) {
    await mkdir(startFetchHome(), { recursive: true, mode: 0o700 });
    await writeFile(marker, "");
    return;
  }
  const detail = (fetched.stderr || fetched.stdout).trim().split(/\r?\n/).at(-1);
  console.error(`[fetch] could not refresh ${context.integrationBranch} from ${remote}${detail ? `: ${detail}` : ""}; starting from the local branch`);
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
  const { issueNumber, hooks = {} } = options;
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Workspace isolation requires a Jujutsu repository");
  if (context.current.name !== "default") {
    await assertWorkspaceMutationAllowed(context);
    return assigned(hooks, context, task, { issueNumber, created: false, reused: false });
  }
  if (issueNumber) {
    const existing = await findIssueWorkspace(cwd, issueNumber, hooks);
    if (existing?.root) {
      const resumed = await workspaceContext(existing.root);
      if (!resumed) throw new Error(`Issue #${issueNumber} workspace disappeared during resume`);
      await assertWorkspaceMutationAllowed(resumed);
      return assigned(hooks, resumed, task, { issueNumber, attach: false, created: false, reused: true, workspacePath: existing.root });
    }
  }
  let name = await newWorkspaceName(cwd, context.integration.root, issueNumber, task);
  await assertIssueAvailable(cwd, issueNumber, name);
  // A surviving Issue checkout at its deterministic path is recovered, never replaced by a spare.
  const survivor = Boolean(issueNumber) && exists(join(workspaceHome(), name));
  if (!survivor) await refreshIntegration(context);
  const spare = survivor ? null : await claimSpare(cwd, name);
  if (spare) name = spare.name;
  const workspacePath = spare?.root ?? join(workspaceHome(), name);
  await mkdir(workspaceHome(), { recursive: true, mode: 0o700 });
  if (survivor) {
    const recovered = await recoverExistingIssueWorkspace(cwd, workspacePath, name, issueNumber!);
    return assigned(hooks, recovered, task, { issueNumber, created: false, reused: true, workspacePath });
  }
  if (!spare) {
    const baseSha = await jj(cwd, ["log", "-r", context.integrationBranch, "--no-graph", "-T", "commit_id"]);
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
  return assigned(hooks, created, task, { issueNumber, created: true, reused: false, pooled: Boolean(spare), workspacePath, prepared });
}
