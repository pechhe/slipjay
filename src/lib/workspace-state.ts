import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { WorkspaceContinuationDisposition } from "./workspace-delivery-lifecycle.ts";
import type { WorkspaceContext, WorkspaceEntry, WorkspaceMetadata } from "./workspace-jj.ts";
import { LANDED_WORKSPACE_REFUSAL, workspaceContinuationDisposition } from "./workspace-delivery-lifecycle.ts";
import { jj, jjWorkspaceRoot, parseWorkspaceList, revisionExists, revisionFacts, workspaceContext, workspaceHasUnintegratedWork, workspaceSlug } from "./workspace-jj.ts";
import { landedHome, lockHome, metadataHome, modePath, stateHome } from "./workspace-paths.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "./workspace-transaction.ts";

export type LandingState = Record<string, unknown> & {
  version: number;
  phase?: "prepared" | "landed" | "recovering";
  workspaceName: string;
  workspacePath: string;
  integrationBranch: string;
  artifactCommitId: string;
  publicationRecovery?: { previousLanding: Record<string, unknown>; publishedBase: string; startedAt: string };
  verificationEvidence?: import("./verification-policy.ts").VerificationEvidence;
  /** Pre-evidence records list only the commands that passed. */
  verificationCommands?: import("./verification-policy.ts").VerificationEvidence["passed"];
};

/**
 * Machine-local workspace state: the checkout mode, per-workspace metadata and
 * owner records, landing-state sidecars, and the workspace list joined with them.
 */

export async function readWorkspaceMode(): Promise<"isolated" | "direct"> {
  // Resolved outside the fallback, so a pending cutover refuses instead of reading as "isolated".
  const path = modePath();
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { mode?: unknown };
    return parsed.mode === "direct" ? "direct" : "isolated";
  } catch {
    return "isolated";
  }
}

export async function writeWorkspaceMode(mode: string): Promise<"isolated" | "direct"> {
  if (mode !== "isolated" && mode !== "direct")
    throw new Error("Workspace mode must be isolated or direct");
  await mkdir(dirname(modePath()), { recursive: true, mode: 0o700 });
  await writeFile(modePath(), JSON.stringify({ version: 1, mode }, null, 2), { mode: 0o600 });
  return mode;
}

/** Legacy per-workspace owner record; a live `pid` in it marks the workspace in use. */
export function lockPath(workspaceName: string): string {
  return join(lockHome(), `${workspaceName}.json`);
}

export async function readJsonOptional<T = Record<string, unknown>>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** False when the workspace's metadata exists but cannot be read or parsed: its Issue, spare and delivery facts are unknown. */
export async function metadataReadable(workspaceName: string): Promise<boolean> {
  try {
    JSON.parse(await readFile(metadataPath(workspaceName), "utf8"));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export function metadataPath(workspaceName: string): string {
  return join(metadataHome(), `${workspaceName}.json`);
}

export async function workspaceMetadata(workspaceName: string): Promise<WorkspaceMetadata | null> {
  return await readJsonOptional<WorkspaceMetadata>(metadataPath(workspaceName));
}

/**
 * Every JJ workspace of the repository with its metadata. Metadata whose recorded
 * name or path no longer matches JJ (after a rename or move) is corrected unless
 * `readOnly`; a workspace JJ recorded without a root falls back to its metadata path.
 */
export async function listWorkspaces(cwd: string = process.cwd(), options: { readOnly?: boolean } = {}): Promise<WorkspaceEntry[]> {
  if (!await jjWorkspaceRoot(cwd)) return [];
  const output = await jj(cwd, [
    "--ignore-working-copy",
    "workspace",
    "list",
    "-T",
    'name ++ "\\t" ++ root ++ "\\t" ++ target.change_id() ++ "\\t" ++ target.commit_id() ++ "\\n"',
  ]).catch(() => null);
  if (output === null) return [];
  return await Promise.all(
    parseWorkspaceList(output).map(async (workspace) => {
      let metadata = await workspaceMetadata(workspace.name);
      if (metadata && workspace.root && (metadata.workspaceName !== workspace.name
        || typeof metadata.workspacePath !== "string" || resolve(metadata.workspacePath) !== resolve(workspace.root))) {
        metadata = { ...metadata, workspaceName: workspace.name, workspacePath: workspace.root };
        if (!options.readOnly) {
          await mkdir(metadataHome(), { recursive: true, mode: 0o700 });
          await writeFile(metadataPath(workspace.name), JSON.stringify(metadata, null, 2), { mode: 0o600 });
        }
      }
      const metadataRoot = typeof metadata?.workspacePath === "string"
        && await stat(metadata.workspacePath).then(() => true, () => false) ? metadata.workspacePath : "";
      return { ...workspace, root: workspace.root || metadataRoot, metadata };
    }),
  );
}

/** A workspace with its unlanded-work and landing-record facts. */
export type InspectedWorkspace = WorkspaceEntry & { hasWork: boolean; landed: boolean };

/**
 * Every workspace with its facts. `readOnly` corrects no metadata and snapshots no
 * working copy, so `hasWork` is as of each checkout's last snapshot.
 */
export async function inspectWorkspaces(cwd: string = process.cwd(), { readOnly = false }: { readOnly?: boolean } = {}): Promise<InspectedWorkspace[]> {
  const context = await workspaceContext(cwd);
  if (!context) return [];
  const workspaces = await listWorkspaces(cwd, { readOnly });
  return await Promise.all(
    workspaces.map(async (workspace) => ({
      ...workspace,
      hasWork:
        workspace.name === "default"
          ? false
          : await workspaceHasUnintegratedWork(workspace.root, context.integrationBranch, { ignoreWorkingCopy: readOnly }).catch(() => true),
      landed: Boolean(await readLandingState(workspace.name, { readOnly: true })),
    })),
  );
}

export async function inspectWorkspace(cwd: string = process.cwd()): Promise<InspectedWorkspace | null> {
  const context = await workspaceContext(cwd);
  if (!context) return null;
  const workspaces = await inspectWorkspaces(cwd);
  return (
    workspaces.find((workspace) => workspace.root && resolve(workspace.root) === resolve(context.current.root)) ??
    null
  );
}

export async function findWorkspace(cwd: string, name: string): Promise<WorkspaceEntry> {
  const workspaces = await listWorkspaces(cwd);
  const workspace = workspaces.find((entry) => entry.name === name);
  if (!workspace?.root) throw new Error(`Unknown or unavailable JJ workspace: ${name}`);
  return workspace;
}

async function moveSidecarFile(directory: string, oldName: string, newName: string, transform: (data: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const source = join(directory, `${oldName}.json`);
  try {
    const data = JSON.parse(await readFile(source, "utf8")) as Record<string, unknown>;
    await writeFile(join(directory, `${newName}.json`), JSON.stringify(transform(data), null, 2), {
      mode: 0o600,
    });
    await rm(source, { force: true });
  } catch {
    // No sidecar state for this workspace under this directory.
  }
}

/** Rename the current isolated workspace and keep its lock, metadata and both
 *  landing-state sidecars consistent, recording the rename history. Names are
 *  slugged; collisions get numeric suffixes. */
export async function renameWorkspace(cwd: string, desired: string): Promise<{ oldName: string; name: string }> {
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default")
    throw new Error("Only isolated JJ workspaces can be renamed");
  return renameListedWorkspace(context.current, await listWorkspaces(cwd), desired);
}

/** `renameWorkspace` for an isolated workspace `current` of the repository listing `workspaces`, as a spare claim holds both. */
export async function renameListedWorkspace(current: Pick<WorkspaceEntry, "name" | "root">, workspaces: WorkspaceEntry[], desired: string): Promise<{ oldName: string; name: string }> {
  const base = workspaceSlug(desired, 60);
  if (!base) throw new Error("New workspace name is empty after normalization");
  const taken = new Set(workspaces.map((workspace) => workspace.name));
  taken.delete(current.name);
  let name = base;
  for (let index = 2; taken.has(name); index += 1) name = `${base}-${index}`;

  await jj(current.root, ["workspace", "rename", name]);
  const oldName = current.name;
  const operationId = await jj(current.root, ["op", "log", "-n", "1", "--no-graph", "-T", "self.id()"]);
  const target = await revisionFacts(current.root, "@");
  const renamed = (data: Record<string, unknown>) => ({
    ...data,
    workspaceName: name,
    previousWorkspaceNames: [...new Set([
      ...(Array.isArray(data.previousWorkspaceNames) ? data.previousWorkspaceNames.filter((value: unknown) => typeof value === "string" && value.trim()) : []),
      oldName,
    ])].slice(-16),
  });
  await moveSidecarFile(lockHome(), oldName, name, (data) => ({ ...data, workspaceName: name }));
  await moveSidecarFile(metadataHome(), oldName, name, (data) => ({
    ...renamed(data),
    workspaceRenameEpochs: [
      ...(Array.isArray(data.workspaceRenameEpochs) ? data.workspaceRenameEpochs.filter((value: unknown) => value && typeof value === "object") : []),
      { version: 1, operationId, fromName: oldName, toName: name, workspacePath: current.root, changeId: target.changeId, commitId: target.commitId },
    ].slice(-16),
  }));
  for (const directory of [stateHome(), landedHome()]) await moveSidecarFile(directory, oldName, name, renamed);
  return { oldName, name };
}

export async function workspaceContinuationState(context: WorkspaceContext | null): Promise<WorkspaceContinuationDisposition> {
  if (!context || context.current.name === "default") return { kind: "active" };
  const state = await readLandingState(context.current.name);
  const metadata = await workspaceMetadata(context.current.name);
  const issueNumber = typeof metadata?.issueNumber === "number" ? metadata.issueNumber : null;
  return workspaceContinuationDisposition(state, {
    workspaceName: context.current.name,
    workspacePath: context.current.root,
    integrationRoot: context.integration.root,
    integrationBranch: context.integrationBranch,
    issueNumber,
    hasUnintegratedWork: await workspaceHasUnintegratedWork(context.current.root, context.integrationBranch),
    landedArtifactIntegrated: Boolean(
      state?.artifactCommitId
      && await revisionExists(context.integration.root, `${state.artifactCommitId} & ::${context.integrationBranch}`),
    ),
  });
}

export async function assertWorkspaceMutationAllowed(context: WorkspaceContext): Promise<void> {
  const continuation = await workspaceContinuationState(context);
  if (continuation.kind === "active" || continuation.kind === "resume_unfinished") return;
  if (continuation.kind === "landed_source") throw new Error(LANDED_WORKSPACE_REFUSAL);
  throw new Error(`Historical landing evidence requires explicit recovery before mutation (${continuation.reason})`);
}

/** Refuse to associate an Issue already held by another workspace. */
export async function assertIssueAvailable(cwd: string, issueNumber: number | undefined, intendedWorkspace: string): Promise<void> {
  if (!issueNumber) return;
  for (const workspace of await listWorkspaces(cwd)) {
    if (workspace.name === intendedWorkspace || workspace.metadata?.issueNumber !== issueNumber)
      continue;
    throw new Error(
      `Issue #${issueNumber} is already associated with jj:${workspace.name}; resume that workspace instead`,
    );
  }
}

export async function attachWorkspaceIssue(cwd: string, issueNumber: number): Promise<WorkspaceMetadata & { issueNumber: number }> {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Issue attachment requires a native workspace");
  return withWorkspaceTransaction(`association:${context.integration.root}`, () => attachWorkspaceIssueUnlocked(cwd, issueNumber));
}

async function attachWorkspaceIssueUnlocked(cwd: string, issueNumber: number): Promise<WorkspaceMetadata & { issueNumber: number }> {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0)
    throw new Error("Issue number must be a positive integer");
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default")
    throw new Error("Attach Issues only to isolated JJ workspaces");
  await assertWorkspaceMutationAllowed(context);
  await assertIssueAvailable(cwd, issueNumber, context.current.name);
  const prior = await workspaceMetadata(context.current.name);
  if (prior?.issueNumber && prior.issueNumber !== issueNumber) throw new Error("This workspace already belongs to another Issue; preserve its identity");
  await mkdir(metadataHome(), { recursive: true, mode: 0o700 });
  const metadata = {
    ...(await workspaceMetadata(context.current.name)),
    version: 1,
    workspaceName: context.current.name,
    workspacePath: context.current.root,
    integrationRoot: context.integration.root,
    issueNumber,
    attachedAt: new Date().toISOString(),
  };
  await writeFile(metadataPath(context.current.name), JSON.stringify(metadata, null, 2), {
    mode: 0o600,
  });
  return metadata;
}

/** Top-level landing-state sidecar path for a workspace. */
export function statePath(workspaceName: string): string {
  return join(stateHome(), `${workspaceName}.json`);
}

/** Landing-state sidecar paths: the current top-level file, then the legacy `landed/` file. */
export function landingStatePaths(workspaceName: string): [string, string] {
  return [statePath(workspaceName), join(landedHome(), `${workspaceName}.json`)];
}

function isLandingState(value: Record<string, unknown> | null): value is LandingState & { integrationRoot?: string; issueNumber?: number } {
  return Boolean(value && value.version === 1 && typeof value.workspaceName === "string" && typeof value.workspacePath === "string"
    && typeof value.integrationBranch === "string" && typeof value.artifactCommitId === "string");
}

/** What `slipjay landed <path>` reports: the landing recorded for one workspace path. */
export type LandedRecord = {
  workspaceName: string;
  workspacePath: string;
  artifactCommitId: string;
  operationId?: string;
  issueNumber?: number;
  landedAt?: string;
};

/**
 * The latest landing recorded for the workspace at `workspacePath`: its sidecar while
 * SlipJay keeps one, else the integrated-artifact archive `prune` moves it to, so it
 * outlives the workspace. Matched by exact path, since workspace names are reused.
 * Read-only: an interrupted `prepared` record is not a landing here.
 */
export async function readLandedRecord(workspacePath: string): Promise<LandedRecord | null> {
  const target = resolve(workspacePath);
  const sidecars: string[] = [];
  const archived: string[] = [];
  for (const directory of [stateHome(), landedHome()])
    for (const file of await readdir(directory).catch(() => [])) {
      if (file.endsWith(".json")) (file.startsWith("artifact-") ? archived : sidecars).push(join(directory, file));
    }
  let latest: (LandingState & { operationId?: unknown; issueNumber?: unknown; landedAt?: unknown }) | null = null;
  // Sidecars first, so a sidecar wins a tie with its own archived copy.
  for (const path of [...sidecars, ...archived]) {
    const state = await readJsonOptional(path);
    if (!isLandingState(state) || (state.phase ?? "landed") !== "landed" || resolve(state.workspacePath) !== target) continue;
    if (latest === null || String(state.landedAt ?? "") > String(latest.landedAt ?? "")) latest = state;
  }
  if (latest === null) return null;
  return {
    workspaceName: latest.workspaceName,
    workspacePath: latest.workspacePath,
    artifactCommitId: latest.artifactCommitId,
    ...typeof latest.operationId === "string" ? { operationId: latest.operationId } : {},
    ...typeof latest.issueNumber === "number" ? { issueNumber: latest.issueNumber } : {},
    ...typeof latest.landedAt === "string" ? { landedAt: latest.landedAt } : {},
  };
}

/**
 * A landing record from either sidecar; an interrupted `prepared` record whose
 * artifact is integrated is promoted to `landed` unless `readOnly`. A `prepared` record whose
 * artifact the integration bookmark already contains was interrupted after the
 * bookmark moved; it is promoted to `landed` (unless `readOnly`) so the next land
 * finishes housekeeping instead of verifying again. Otherwise it is not a landing.
 */
export async function readLandingState(workspaceName: string, options: { readOnly?: boolean } = {}): Promise<LandingState | null> {
  for (const path of landingStatePaths(workspaceName)) {
    const state = await readJsonOptional(path);
    if (!isLandingState(state)) continue;
    if (state.phase === "prepared" && !options.readOnly) {
      if (!state.integrationRoot || !await revisionExists(state.integrationRoot, `${state.artifactCommitId} & ::${state.integrationBranch}`)) return null;
      state.phase = "landed";
      await writeWorkspaceJson(path, state);
    }
    return state;
  }
  return null;
}
