import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { WorkspaceEntry } from "../infra/workspace-jj.ts";
import { run, workspaceContext } from "../infra/workspace-jj.ts";
import { trackedManifests } from "./workspace-dependencies.ts";
import { workspaceHolders, describeHolders } from "./workspace-holders.ts";
import type { ProcessWorkingDirectory } from "./workspace-holders.ts";
import { listWorkspaces, metadataPath, workspaceMetadata } from "./workspace-state.ts";

import { withWorkspaceTransaction, writeWorkspaceJson } from "../infra/workspace-transaction.ts";
import { generatedPathMatchers, readIntegrationPolicy } from "../policy/execution-policy.ts";

/**
 * Idle eviction: a checkout nobody is using keeps its commits and its binding but
 * sheds the dependency trees SlipJay installed for it, which are most of its bytes
 * and are reproducible from the lockfile. It is the reversible half of workspace
 * hygiene: nothing a person wrote is touched, and the next claim reinstalls.
 *
 * It differs from retirement on purpose. Retirement needs proof that the work is
 * delivered; eviction needs only that no one is using the checkout now, which is
 * why it may run on a timer.
 *
 * Known limit, and why the durable claim comes next: a start or a resume records
 * its clock and takes no lock this pass holds, so the guard here is a re-read of
 * that clock under the pool lock rather than mutual exclusion. A resume that begins
 * in the instant between the re-read and the removal can still lose its trees; it
 * reinstalls on its next command, and nothing it wrote is touched.
 */
export const EVICTION_IDLE_MS: number = 24 * 60 * 60_000;

export type EvictionPlan = {
  name: string;
  root: string;
  action: "evict" | "keep";
  reason: string;
  /** Dependency trees the checkout would shed, relative to its root. */
  dependencyPaths: string[];
  /** Declared generated output it would shed too, relative to its root. */
  generatedPaths: string[];
  sizeBytes: number | null;
};

export type EvictionResult = {
  name: string;
  root: string;
  evicted: boolean;
  reason: string;
  removedPaths: string[];
  /** Trees the removal could not delete; the checkout is marked evicted regardless. */
  failedPaths: string[];
  freedBytes: number | null;
};

export type EvictionOutcome = {
  results: EvictionResult[];
  skipped: Array<{ name: string; reason: string }>;
};

/** A checkout's dependency trees: `node_modules` beside each tracked manifest, and at its root. */
export async function dependencyTrees(root: string, manifests?: string[] | null): Promise<string[]> {
  const listed = manifests !== undefined ? manifests : await trackedManifests(root);
  const candidates = new Set<string>();
  for (const manifest of listed ?? []) {
    const directory = dirname(manifest);
    candidates.add(directory === "." ? "node_modules" : join(directory, "node_modules"));
  }
  candidates.add("node_modules");
  return [...candidates]
    .filter((path) => existsSync(join(root, path)))
    .sort();
}

/**
 * Directories the repository itself calls generated output: `.svelte-kit`, `dist`,
 * `coverage`, a vitest cache. An idle checkout may shed these too — they are rebuilt
 * from source — but a path it calls evidence is never touched, because that is material
 * a person keeps.
 *
 * The walk is bounded: a repository that nests deeper than this keeps what is below,
 * which is the safe direction for a deletion.
 */
export async function generatedPathsIn(root: string, integrationRoot: string, options: { depth?: number } = {}): Promise<string[]> {
  const { policy } = await readIntegrationPolicy(integrationRoot, { hintRoot: integrationRoot }).catch(() => ({ policy: null }));
  const generated = generatedPathMatchers(policy?.generatedPaths);
  if (!generated.length) return [];
  const evidence = generatedPathMatchers(policy?.evidencePaths, "evidencePaths");
  const limit = options.depth ?? 6;
  const found: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > limit) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === ".jj" || entry.name === ".git") continue;
      const full = join(directory, entry.name);
      const relative = relativeTo(root, full);
      if (evidence.some((matcher) => matcher.test(`${relative}/`))) continue;
      if (generated.some((matcher) => matcher.test(`${relative}/`))) {
        found.push(relative);
        continue;
      }
      await walk(full, depth + 1);
    }
  };
  await walk(root, 1);
  return found.sort();
}

/** Repository-relative path with forward slashes, as the declared matchers expect. */
function relativeTo(root: string, full: string): string {
  return relative(root, full).split("\\").join("/");
}

const HOUR_MS = 60 * 60_000;

export type EvictionDecision = { evict: boolean; reason: string };

/**
 * Whether a checkout may shed its dependency trees now. Every unknown keeps the
 * material: unreadable process boundaries, missing activity, and any live holder.
 * `lastActivityAt === null` is not "idle for ever" — it means nothing has been
 * observed yet, and the caller starts its clock instead of guessing from a date.
 */
export function evictionDecision(input: {
  integration: boolean;
  exists: boolean;
  holders: ProcessWorkingDirectory[] | null;
  dependencyPaths: string[];
  lastActivityAt: number | null;
  now: number;
  idleMs?: number;
}): EvictionDecision {
  const idleMs = input.idleMs ?? EVICTION_IDLE_MS;
  if (input.integration) return { evict: false, reason: "integration checkout" };
  if (!input.exists) return { evict: false, reason: "checkout missing on disk" };
  if (input.holders === null) return { evict: false, reason: "cannot read the processes using it" };
  if (input.holders.length) return { evict: false, reason: `in use by a live process: ${describeHolders(input.holders)}` };
  if (!input.dependencyPaths.length) return { evict: false, reason: "no dependency trees installed" };
  if (input.lastActivityAt === null) return { evict: false, reason: "no activity recorded yet; its idle clock starts now" };
  const idleFor = input.now - input.lastActivityAt;
  if (idleFor < idleMs) {
    return { evict: false, reason: `used within ${Math.max(1, Math.round(idleMs / HOUR_MS))}h (${Math.max(0, Math.round(idleFor / HOUR_MS))}h ago)` };
  }
  return { evict: true, reason: `idle ${Math.round(idleFor / HOUR_MS)}h` };
}

async function metadata(name: string) {
  return await workspaceMetadata(name);
}

async function writeMetadata(name: string, fields: Record<string, unknown>): Promise<void> {
  const existing = await metadata(name);
  if (!existing) return;
  await writeWorkspaceJson(metadataPath(name), { ...existing, ...fields });
}

/** Record that a checkout was used, which is what its idle clock measures from. */
export async function recordWorkspaceActivity(name: string, at: number = Date.now()): Promise<void> {
  await writeMetadata(name, { lastActivityAt: new Date(at).toISOString() });
}

async function diskBytes(root: string): Promise<number | null> {
  const result = await run("du", ["-sk", root], { cwd: root });
  const kilobytes = Number.parseInt(result.stdout, 10);
  return result.code === 0 && Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
}

/**
 * Evict every idle checkout of the repository containing `cwd`, or plan it without
 * touching anything. Activity that has never been recorded starts now, so the first
 * pass over an established machine evicts nothing and only begins the clocks.
 */
export async function evictIdleWorkspaces(cwd: string = process.cwd(), options: {
  idleMs?: number; now?: number; plan?: boolean; processes?: ProcessWorkingDirectory[] | null;
} = {}): Promise<{ plans: EvictionPlan[]; outcome: EvictionOutcome }> {
  const context = await workspaceContext(cwd);
  if (!context) return { plans: [], outcome: { results: [], skipped: [] } };
  const now = options.now ?? Date.now();
  const integrationRoot = resolve(context.integration.root);
  const workspaces = await listWorkspaces(cwd, { readOnly: Boolean(options.plan) });
  const plans: EvictionPlan[] = [];
  const outcome: EvictionOutcome = { results: [], skipped: [] };
  for (const workspace of workspaces) {
    const root = workspace.root ? resolve(workspace.root) : "";
    if (!root) { outcome.skipped.push({ name: workspace.name, reason: "no checkout on disk" }); continue; }
    // A spare is the pool's cached readiness and a dependency seed for other checkouts.
    if (workspace.metadata?.spare) { outcome.skipped.push({ name: workspace.name, reason: "a pool spare" }); continue; }
    const decision = await decide(workspace, root, integrationRoot, now, options);
    const dependencyPaths = decision.evict || decision.reason === "no dependency trees installed"
      ? await dependencyTrees(root) : [];
    const generatedPaths = decision.evict ? await generatedPathsIn(root, integrationRoot).catch(() => []) : [];
    plans.push({
      name: workspace.name, root, action: decision.evict ? "evict" : "keep", reason: decision.reason,
      dependencyPaths, generatedPaths, sizeBytes: await diskBytes(root),
    });
    if (!decision.evict) { outcome.skipped.push({ name: workspace.name, reason: decision.reason }); continue; }
    if (options.plan) continue;
    // Serialise with claims and refills: they hold the pool key, so an eviction cannot
    // race a spare being claimed, and a claim cannot race a tree being removed.
    let result: EvictionResult | null;
    try {
      result = await withWorkspaceTransaction(`pool:${integrationRoot}`, async (): Promise<EvictionResult | null> => {
        // A claim or a resume may have landed while this pass decided, so judge again inside the lock.
        const holders = await workspaceHolders(root, { processes: options.processes ?? null }).catch(() => null);
        if (holders === null || holders.length) return null;
        const current = await metadata(workspace.name);
        const recordedAt = (value: unknown) => typeof value === "string" ? Date.parse(value) : null;
        const recorded = recordedAt(current?.lastActivityAt);
        if (recorded && Number.isFinite(recorded) && now - recorded < (options.idleMs ?? EVICTION_IDLE_MS)) return null;
        const before = await diskBytes(root);
        // Invalidate the readiness record first: an interrupted removal must never leave a
        // claim reusing an install that is partly gone.
        await writeMetadata(workspace.name, {
          evictedAt: new Date(now).toISOString(), evictedPaths: dependencyPaths,
          preparedDependencies: { state: "stale", packageManager: null, installInputs: null },
        });
        // A start or a resume writes its clock before it does anything with the checkout and
        // takes no lock this pass holds, so read it again: if it moved, someone began using
        // the checkout while this pass was preparing to remove its trees, and they stay.
        const resumed = recordedAt((await metadata(workspace.name))?.lastActivityAt);
        if (resumed && recorded && resumed > recorded) {
          await writeMetadata(workspace.name, {
            evictedAt: current?.evictedAt, evictedPaths: current?.evictedPaths, preparedDependencies: current?.preparedDependencies,
          });
          return null;
        }
        const removed: string[] = [];
        const failed: string[] = [];
        const generated = await generatedPathsIn(root, integrationRoot).catch(() => [] as string[]);
        for (const path of [...dependencyPaths, ...generated]) {
          await rm(join(root, path), { recursive: true, force: true }).then(() => removed.push(path), () => failed.push(path));
        }
        if (removed.length !== dependencyPaths.length) {
          await writeMetadata(workspace.name, { evictedPaths: removed });
        }
        const after = await diskBytes(root);
        return {
          name: workspace.name, root, evicted: removed.length > 0, reason: decision.reason,
          removedPaths: removed, failedPaths: failed,
          freedBytes: before !== null && after !== null ? Math.max(0, before - after) : null,
        };
      }, { waitMs: 60_000 });
    } catch (error) {
      // Only a busy pool is a skip: anything else is a failure the caller must see.
      if ((error as { code?: string } | null | undefined)?.code === "ELOCKED") {
        outcome.skipped.push({ name: workspace.name, reason: "the pool is busy; it will be judged again next pass" });
        continue;
      }
      throw error;
    }
    if (!result) { outcome.skipped.push({ name: workspace.name, reason: "in use while evicting" }); continue; }
    outcome.results.push(result);
  }
  return { plans, outcome };
}

async function decide(
  workspace: WorkspaceEntry, root: string, integrationRoot: string, now: number,
  options: { idleMs?: number; processes?: ProcessWorkingDirectory[] | null; plan?: boolean },
): Promise<EvictionDecision> {
  const holders = await workspaceHolders(root, { processes: options.processes ?? null }).catch(() => null);
  const activity = workspace.metadata?.lastActivityAt;
  const lastActivityAt = typeof activity === "string" ? Date.parse(activity) : null;
  const decision = evictionDecision({
    integration: root === integrationRoot,
    exists: await stat(root).then(() => true, () => false),
    holders,
    dependencyPaths: await dependencyTrees(root).catch(() => []),
    lastActivityAt: Number.isFinite(lastActivityAt) ? lastActivityAt! : null,
    now,
    idleMs: options.idleMs,
  });
  // A checkout with no clock yet starts one, so the next pass can judge it.
  if (options.plan) return decision;
  if (!decision.evict && decision.reason.startsWith("no activity recorded")) {
    await recordWorkspaceActivity(workspace.name, now);
  } else if (holders?.length) {
    // A checkout someone is working in is in use now, whatever its clock said.
    await recordWorkspaceActivity(workspace.name, now);
  }
  return decision;
}
