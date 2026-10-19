import type { WorkspaceEntry, WorkspaceMetadata } from "../infra/workspace-jj.ts";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { run, STALE_WORKING_COPY, updateStaleWorkingCopy, workspaceContext, workspaceHasUnintegratedWork } from "../infra/workspace-jj.ts";
import { trackerOf, workItemClosed } from "../build/tracker.ts";
import type { BuildReader } from "../build/tracker.ts";
import { inspectWorkspaces, lockOwnerAlive, metadataReadable, readLandingState } from "./workspace-state.ts";
import type { InspectedWorkspace } from "./workspace-state.ts";
import { cleanupLandedWorkspace, describeRetention, forgetMissingCheckout, STALE_EDITS, landedCleanupChecks, missingCheckoutRefusal, removalRefusal, removeWorkspace, retainedWorkspaceMaterial, unsnapshottedEdits } from "./workspace-lifecycle.ts";
import { artifactPublished } from "../landing/landing-steps.ts";
import { describeHolders, processWorkingDirectories, within, workspaceHolders } from "./workspace-holders.ts";
import { pruneWorkspaceState } from "./workspace-state-prune.ts";
import { findOrphanedCheckouts, retireOrphanedCheckouts } from "./workspace-orphans.ts";

/**
 * Disposable-workspace housekeeping shared by every surface that lands or
 * launches. Landed checkouts go through `cleanupLandedWorkspace`'s delivery
 * checks; a source-empty checkout is removed once `EMPTY_IDLE_MS` has passed
 * since it was assigned. Neither is touched while a live process works in it, and
 * unique untracked material always keeps a workspace. Unfinished work is never
 * swept: only `hasWork === false` checkouts qualify. An Issue's checkout is
 * swept once it has landed, or while empty once `gh` reports its Issue CLOSED
 * (never while the Issue is open or its state is unknown) and `ASSIGNMENT_GRACE_MS`
 * has passed since it was assigned, so a checkout just allocated for a closed
 * Issue (`slipjay repair`, a resumed start) survives the sweep its allocation
 * triggers until its agent enters it. The sweep also prunes
 * machine-local state left by workspaces that no longer exist.
 */
/** Minimum assignment age before an unused empty workspace is swept. */
export const EMPTY_IDLE_MS: number = 24 * 60 * 60 * 1000;

/** Minimum assignment age before a closed Issue's empty workspace is swept (never longer than `emptyIdleMs`). */
export const ASSIGNMENT_GRACE_MS: number = 60 * 60 * 1000;

/** Workspaces removed, retained, and machine-local state pruned by housekeeping. */
export interface SweepResult {
  removed: string[];
  /** `landed` marks a delivered checkout the sweep could not release. */
  skipped: Array<{ name: string; landed: boolean; reason: string }>;
  /** State files removed for workspaces that no longer exist (relative to the state home). */
  pruned: string[];
  /** Orphaned directories removed from workspace storage (see `retireOrphanedCheckouts`). */
  orphans: string[];
}

/** Controls assignment age, protected checkouts, state pruning, and Issue lookup. */
export interface SweepOptions {
  emptyIdleMs?: number;
  protectedRoots?: string[];
  now?: number;
  pruneState?: boolean;
  /** Whether a work item is closed (which qualifies its empty workspace), null when unknown; defaults to the repository's tracker. */
  issueClosed?: (repositoryRoot: string, issueNumber: number) => Promise<boolean | null> | boolean | null;
  /** Reads Build for the default `issueClosed` in a Build-tracked repository; without it a Build item's state is unknown. */
  readBuild?: BuildReader;
}

/**
 * When the checkout was last created, assigned or given a task. Any JJ command,
 * including this sweep's own inspection, refreshes `.jj/working_copy`, so that
 * is no measure of idleness; a source-empty checkout's age since assignment is.
 */
async function assignedAt(workspace: WorkspaceEntry) {
  const metadata: WorkspaceMetadata & { updatedAt?: string; claimedAt?: string; createdAt?: string; attachedAt?: string } = workspace.metadata ?? {};
  const created = await stat(workspace.root).then((info) => info.birthtimeMs || info.mtimeMs, () => 0);
  return Math.max(created, ...[metadata.updatedAt, metadata.claimedAt, metadata.createdAt, metadata.attachedAt].map((value) => Date.parse(value ?? "") || 0));
}

/**
 * Remove disposable workspaces in the repository containing `cwd`.
 * `emptyIdleMs` is the minimum time since assignment before an empty checkout
 * is removed (0 for an explicit prune). `protectedRoots` and
 * this process's own cwd are never removed. Fails closed: if process working
 * directories cannot be read, nothing is removed.
 */
export async function sweepDisposableWorkspaces(cwd: string = process.cwd(), options: SweepOptions = {}): Promise<SweepResult> {
  const removed: string[] = [];
  const skipped: SweepResult["skipped"] = [];
  const judge = await sweepJudge(cwd, options, { readOnly: false });
  if (!judge) return { removed, skipped, pruned: [], orphans: [] };
  for (const workspace of judge.workspaces) {
    const skip = (reason: string) => skipped.push({ name: workspace.name, landed: workspace.landed, reason });
    try {
      const decision = await judge.decide(workspace);
      if (!decision.remove) {
        if (decision.report) skip(decision.reason);
        continue;
      }
      if (decision.missing) {
        await forgetMissingCheckout(judge.context.integration.root, workspace);
        removed.push(workspace.name);
        continue;
      }
      if (workspace.landed) {
        // Cleanup runs the landed checks again, with the snapshot, housekeeping and fetch a plan skips.
        const cleaned = await cleanupLandedWorkspace(workspace.root);
        if (cleaned.cleaned) removed.push(workspace.name);
        else skip(describeRetention(cleaned));
        continue;
      }
      await removeWorkspace(judge.context.integration.root, workspace.name, { retainMaterial: true, ...decision.issueBound ? { allowIssue: true } : {} });
      removed.push(workspace.name);
    } catch (error) {
      skip(error instanceof Error ? error.message : String(error));
    }
  }
  // Machine-wide state and storage housekeeping, which `pruneState: false` leaves alone.
  if (options.pruneState === false) return { removed, skipped, pruned: [], orphans: [] };
  return { removed, skipped, pruned: await pruneWorkspaceState(), orphans: await retireOrphanedCheckouts({ now: options.now }).catch(() => []) };
}

/** Why the sweep keeps a workspace (`report`: a sweep names it as skipped), or that it removes it. */
type SweepDecision =
  | { remove: false; reason: string; report: boolean }
  | { remove: true; issueBound: boolean; missing?: boolean };

/**
 * The sweep's decision for each workspace of the repository containing `cwd`,
 * shared by the sweep and the read-only plan so they cannot disagree. `readOnly`
 * snapshots no working copy, fetches nothing and finishes no landing: facts it
 * cannot read without doing so keep the workspace, with the reason.
 */
async function sweepJudge(cwd: string, options: SweepOptions, { readOnly }: { readOnly: boolean }) {
  const { emptyIdleMs = EMPTY_IDLE_MS, protectedRoots = [], now = Date.now(), issueClosed, readBuild } = options;
  const context = await workspaceContext(cwd);
  if (!context) return null;
  const readIssueClosed = issueClosed ?? ((root: string, issueNumber: number) => workItemClosed(root, trackerOf(context.configuration), issueNumber, readBuild));
  const workspaces = await inspectWorkspaces(context.integration.root, { readOnly });
  // Read once, and only when a workspace needs it.
  let processList: Promise<Awaited<ReturnType<typeof processWorkingDirectories>>> | undefined;
  const processes = () => processList ??= processWorkingDirectories();
  const guarded = [...protectedRoots, process.cwd()];
  const issueStates = new Map<number, boolean | null>();
  const issueState = async (issueNumber: number) => {
    if (!issueStates.has(issueNumber)) issueStates.set(issueNumber, await Promise.resolve().then(() => readIssueClosed(context.integration.root, issueNumber)).catch(() => null));
    return issueStates.get(issueNumber)!;
  };
  const keep = (reason: string, report = true): SweepDecision => ({ remove: false, reason, report });
  /**
   * A stale checkout no live process uses, updated so it can be judged like any other, or why it
   * is kept: one whose stale files held edits keeps them as a divergent commit to reconcile.
   */
  const updateStale = async (workspace: InspectedWorkspace): Promise<InspectedWorkspace | SweepDecision> => {
    const running = await processes();
    if (!running) return keep("process working directories unavailable");
    if (guarded.some((root) => within(root, workspace.root))) return keep("protected", false);
    const holders = await workspaceHolders(workspace.root, { processes: running });
    if (holders!.length) return keep(`in use by a live process: ${describeHolders(holders!)}`);
    if (await lockOwnerAlive(workspace.name)) return keep("in use by a live process");
    if ((await updateStaleWorkingCopy(workspace.root)).recordedEdits) return keep(STALE_EDITS);
    return { ...workspace, unreadable: undefined, hasWork: await workspaceHasUnintegratedWork(workspace.root, context.integrationBranch) };
  };
  const decide = async (workspace: InspectedWorkspace): Promise<SweepDecision> => {
    if (workspace.name === "default") return keep("integration checkout", false);
    // Without its metadata, whether it is a spare, an Issue's or owes the runner facts is unknown.
    if (!await metadataReadable(workspace.name)) return keep("metadata unreadable");
    if (!workspace.root || !existsSync(workspace.root)) {
      // Forgetting a checkout already gone loses nothing once it owes nothing and its revision holds no unlanded work.
      const refusal = await missingCheckoutRefusal(context.integration.root, workspace);
      return refusal ? keep(`checkout missing on disk; it ${refusal}`) : { remove: true, issueBound: false, missing: true };
    }
    // Read-only inspection never snapshots, so only the sweep finds a working copy stale.
    if (workspace.unreadable && STALE_WORKING_COPY.test(workspace.unreadable)) {
      const updated = await updateStale(workspace);
      if ("remove" in updated) return updated;
      workspace = updated;
    }
    if (workspace.unreadable) {
      return keep(`working copy unreadable (${workspace.unreadable}): run \`jj workspace update-stale\` in it; if JJ cannot recover it, copy out anything needed, `
        + `run \`jj workspace forget ${workspace.name}\` in the integration checkout and delete the directory`);
    }
    if (workspace.metadata?.spare) return keep("prepared spare", false);
    if (workspace.hasWork) return keep("unlanded work", false);
    // An Issue's checkout that has not landed qualifies only when its Issue is closed, after the short
    // assignment grace instead of the idle wait; a live process or owner still protects it below.
    const issueBound = !workspace.landed && Boolean(workspace.metadata?.issueNumber);
    const running = await processes();
    if (!running) return keep("process working directories unavailable", !issueBound);
    if (guarded.some((root) => within(root, workspace.root))) return keep("protected", false);
    if (issueBound) {
      const closed = await issueState(workspace.metadata!.issueNumber!);
      if (closed !== true) return keep(closed === false ? `issue #${workspace.metadata!.issueNumber} open` : `issue #${workspace.metadata!.issueNumber} state unknown`, false);
    }
    const holders = await workspaceHolders(workspace.root, { processes: running });
    if (holders!.length) return keep(`in use by a live process: ${describeHolders(holders!)}`);
    if (await lockOwnerAlive(workspace.name)) return keep("in use by a live process");
    if (workspace.landed) {
      if (!readOnly) return { remove: true, issueBound: false };
      const checks = await landedCleanupChecks(workspace.root, { readOnly: true });
      return checks.ready ? { remove: true, issueBound: false } : keep(describeRetention(checks.result));
    }
    const idleMs = issueBound ? Math.min(emptyIdleMs, ASSIGNMENT_GRACE_MS) : emptyIdleMs;
    if (idleMs > 0 && now - await assignedAt(workspace) < idleMs) return keep(issueBound ? "assigned within the grace period" : "assigned within the idle period", false);
    if (readOnly) {
      const edited = await unsnapshottedEdits(workspace.root, context.integration.root);
      if (edited.length) return keep(`edited since its last snapshot: ${edited.join(", ")}`);
    }
    const unique = await retainedWorkspaceMaterial(workspace.root, context.integration.root);
    if (unique.length) return keep(`holds unique files: ${unique.join(", ")}`);
    const refusal = await removalRefusal(workspace, workspace.metadata);
    if (refusal) return keep(refusal);
    return { remove: true, issueBound };
  };
  return { context, workspaces, decide, processes };
}

/** One workspace in a retention plan: its facts and what the sweep would do with it. */
export interface PlannedWorkspace {
  name: string;
  root: string;
  /** The repository's integration checkout; for an orphan, the one it names (null without a JJ identity). */
  repository: string | null;
  /** `missing`: registered, but the checkout is gone from disk; `broken`: JJ cannot read its working copy. */
  state: "integration" | "missing" | "broken" | "spare" | "unlanded" | "landed" | "empty" | "orphan";
  issueNumber: number | null;
  task: string | null;
  /** The workspace's landing, if it has one: its phase and whether its artifact is on the remote as of the last fetch (null when unknown). */
  landing: { phase: string; published: boolean | null } | null;
  /** Latest creation or assignment, null when unknown. */
  assignedAt: string | null;
  /** Live processes working in the checkout, null when process working directories are unreadable. */
  holders: string[] | null;
  /** Untracked material cleanup would keep, null when unreadable or not judged. */
  uniqueFiles: string[] | null;
  sizeBytes: number | null;
  action: "remove" | "keep";
  reason: string;
}

/**
 * What the sweep would do now with every workspace of the repository containing
 * `cwd`, and why, without changing anything: no filesystem, working-copy or
 * state mutation. Facts it cannot read are unknown and keep the workspace.
 */
export async function planDisposableWorkspaces(cwd: string = process.cwd(), options: SweepOptions = {}): Promise<PlannedWorkspace[]> {
  const judge = await sweepJudge(cwd, options, { readOnly: true });
  if (!judge) return [];
  const processes = await judge.processes();
  const planned = await Promise.all(judge.workspaces.map(async (workspace): Promise<PlannedWorkspace> => {
    const decision = await judge.decide(workspace).catch((error: unknown): SweepDecision =>
      ({ remove: false, reason: `unknown: ${error instanceof Error ? error.message : String(error)}`, report: true }));
    const isolated = workspace.name !== "default" && Boolean(workspace.root) && existsSync(workspace.root);
    const holders = isolated && processes ? (await workspaceHolders(workspace.root, { processes }))!.map(({ pid, command }) => `pid ${pid}${command ? ` (${command})` : ""}`) : null;
    const assigned = isolated ? await assignedAt(workspace) : 0;
    return {
      name: workspace.name,
      root: workspace.root,
      repository: judge.context.integration.root,
      state: workspace.name === "default" ? "integration" : !workspace.root || !existsSync(workspace.root) ? "missing"
        : workspace.unreadable ? "broken" : workspace.metadata?.spare ? "spare"
        : workspace.hasWork ? "unlanded" : workspace.landed ? "landed" : "empty",
      issueNumber: workspace.metadata?.issueNumber ?? null,
      task: typeof workspace.metadata?.task === "string" ? workspace.metadata.task : null,
      landing: isolated ? await landingFacts(workspace.name) : null,
      assignedAt: assigned ? new Date(assigned).toISOString() : null,
      holders,
      uniqueFiles: isolated ? await retainedWorkspaceMaterial(workspace.root, judge.context.integration.root).catch(() => null) : null,
      sizeBytes: workspace.root ? await diskBytes(workspace.root) : null,
      action: decision.remove ? "remove" : "keep",
      reason: decision.remove ? (decision.missing ? "checkout missing on disk; nothing to keep" : workspace.landed ? "landed and published" : "unused and empty") : decision.reason,
    };
  }));
  // Orphans in workspace storage that name this repository, or none that still exists.
  const repository = await realpath(judge.context.integration.root).catch(() => judge.context.integration.root);
  const orphans = (await findOrphanedCheckouts({ now: options.now })).filter((orphan) => orphan.kind !== "unregistered" || orphan.repository === repository);
  return [...planned, ...await Promise.all(orphans.map(async (orphan): Promise<PlannedWorkspace> => ({
    name: orphan.name, root: orphan.root, repository: orphan.repository, state: "orphan", issueNumber: null, task: null, landing: null,
    assignedAt: null, holders: orphan.holders, uniqueFiles: orphan.files, sizeBytes: await diskBytes(orphan.root), action: orphan.action, reason: orphan.reason,
  })))];
}

/** A landing's phase and publication as of the last fetch, read without promoting or fetching. */
async function landingFacts(workspaceName: string): Promise<PlannedWorkspace["landing"]> {
  const state = await readLandingState(workspaceName, { readOnly: true }).catch(() => null);
  if (!state) return null;
  const context = typeof state.integrationRoot === "string" ? await workspaceContext(state.integrationRoot).catch(() => null) : null;
  const published = context ? await artifactPublished(context.integration.root, context, state, { fetch: false }).catch(() => null) : null;
  return { phase: state.phase ?? "landed", published };
}

/** The checkout's size on disk, null when `du` cannot read it. */
async function diskBytes(root: string): Promise<number | null> {
  const result = await run("du", ["-sk", root], { cwd: root });
  const kilobytes = Number.parseInt(result.stdout, 10);
  return result.code === 0 && Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
}

/** Explicit `prune --empty`: every unused empty or delivered workspace now, with the same safety checks. */
export async function pruneEmptyWorkspaces(cwd: string = process.cwd(), { readBuild }: Pick<SweepOptions, "readBuild"> = {}): Promise<SweepResult> {
  return sweepDisposableWorkspaces(cwd, { emptyIdleMs: 0, readBuild });
}
