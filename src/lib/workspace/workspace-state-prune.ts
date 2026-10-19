import { createHash } from "node:crypto";
import { readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { revisionExists, run } from "../infra/workspace-jj.ts";
import { processAlive } from "./workspace-holders.ts";
import { attemptHome, landedHome, lockHome, metadataHome, stateHome, transactionHome } from "./workspace-paths.ts";
import { archiveIntegratedWorkspaceEvidence } from "./workspace-finalization.ts";
import { readJsonOptional } from "./workspace-state.ts";

/**
 * Housekeeping for machine-local state that outlives its workspace: per-workspace
 * metadata, landing sidecars, owner records and allocation attempts under the state home whose
 * workspace no longer exists in its repository, and what local landings left behind.
 * Conservative by construction: a file is removed only when its repository can be
 * listed and does not contain the workspace, the checkout is gone, and nothing in
 * flight could still use it. Integrated-artifact evidence (`landed/artifact-*.json`) is kept,
 * except a vanished test fixture's; transaction locks and the post-integration records are
 * never touched.
 */

/** Fields read from machine-local housekeeping records. */
type PruneRecordData = Record<string, unknown> & {
  version: number;
  workspaceName: string;
  workspacePath: string;
  integrationBranch: string;
  artifactCommitId: string;
  integrationRoot?: string;
};
type PruneRecord = { kind: string; name: string; path: string; data: PruneRecordData | null };

const names = (directory: string) => readdir(directory).catch(() => []);

const isLandingState = (value: PruneRecordData | null): value is PruneRecordData => Boolean(value && value.version === 1 && typeof value.workspaceName === "string"
  && typeof value.workspacePath === "string" && typeof value.integrationBranch === "string" && typeof value.artifactCommitId === "string");

/** Whether a `writer:<name>` transaction is held right now (landing, cleanup or a host write). */
async function writerHeld(workspaceName: string) {
  const target = join(transactionHome(), createHash("sha256").update(`writer:${workspaceName}`).digest("hex"));
  return lockfile.check(target, { realpath: false, stale: 120000 }).catch(() => true);
}

/**
 * Registered workspace names of the repository at `root`, or null when it cannot be listed. A
 * repository deleted from a directory that still exists registers none, so its records converge
 * once their checkouts are gone too.
 */
async function registeredNames(root: string | undefined, cache: Map<string, Set<string> | null>) {
  if (typeof root !== "string" || !root) return null;
  if (!cache.has(root)) {
    if (await repositoryGone(root)) cache.set(root, new Set());
    else {
      const listed = await run("jj", ["--color=never", "--ignore-working-copy", "workspace", "list", "-T", 'name ++ "\\n"'], { cwd: root, timeoutMs: 30_000 }).catch(() => null);
      cache.set(root, listed && listed.code === 0 ? new Set(listed.stdout.split("\n").map((line) => line.replace(/^"|"$/g, "")).filter(Boolean)) : null);
    }
  }
  return cache.get(root);
}

const gone = (path: string) => stat(path).then(() => false, (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT");
/** A repository deleted from a directory that still exists: one on an unmounted volume is unknown, not gone. */
const repositoryGone = async (root: string) => await gone(root) && !await gone(dirname(root));

/** Remove state for vanished workspaces; returns the removed file names. Never throws. */
export async function pruneWorkspaceState(): Promise<string[]> {
  const removed: string[] = [];
  try {
    const cache = new Map<string, Set<string> | null>();
    // Every per-workspace record: `<name>.json` files of the metadata, landing-sidecar and lock homes.
    const records: PruneRecord[] = [];
    const collect = async (directory: string, kind: string, accept: (data: PruneRecordData | null, name: string) => boolean = () => true) => {
      for (const file of await names(directory)) {
        if (!file.endsWith(".json") || file.startsWith("artifact-")) continue;
        const path = join(directory, file);
        const data = await readJsonOptional(path) as PruneRecordData | null;
        if (accept(data, file.slice(0, -5))) records.push({ kind, name: file.slice(0, -5), path, data });
      }
    };
    const landing = (data: PruneRecordData | null, name: string) => isLandingState(data) && data.workspaceName === name;
    await collect(metadataHome(), "metadata");
    await collect(stateHome(), "landing", landing);
    await collect(landedHome(), "landing", landing);
    await collect(lockHome(), "lock");
    // An allocation attempt is kept while its start runs or its checkout exists.
    await collect(attemptHome(), "attempt");
    // A lock records no repository; borrow the one a metadata or landing record of the same name names.
    const rootOf = (record: PruneRecord) => record.data?.integrationRoot
      ?? records.find((other) => other.name === record.name && other.kind !== "lock" && other.data?.integrationRoot)?.data!.integrationRoot;
    for (const record of records) {
      try {
        const { data, name, path } = record;
        if (!data || typeof data !== "object") continue;
        if (record.kind === "lock" && processAlive(data.pid)) continue;
        if (record.kind === "attempt" && (data.status === "allocating" || data.status === "preparing") && processAlive(data.pid)) continue;
        if (record.kind === "metadata" && data.spare === true && processAlive(data.preparingPid)) continue;
        if (record.kind === "landing" && data.phase !== undefined && data.phase !== "landed") continue;
        const root = rootOf(record);
        const registered = await registeredNames(root, cache);
        if (!registered || registered.has(data.workspaceName ?? name) || registered.has(name)) continue;
        const recordedPath = data.workspacePath ?? records.find((other) => other.name === name && other.data?.workspacePath)?.data!.workspacePath;
        if (typeof recordedPath === "string" && !await gone(recordedPath)) continue;
        if (await writerHeld(name)) continue;
        if (record.kind === "landing") {
          // Keep the delivery evidence of anything not provably integrated, and archive the rest first.
          if (!await revisionExists(root!, `${data.artifactCommitId} & ::${data.integrationBranch}`)) continue;
          const git = await run("jj", ["--color=never", "--ignore-working-copy", "git", "root"], { cwd: root, timeoutMs: 30_000 });
          if (git.code !== 0) continue;
          const archived = { ...data, phase: "landed" };
          await archiveIntegratedWorkspaceEvidence(git.stdout.trim(), archived);
        }
        await rm(path, { force: true });
        removed.push(path.slice(stateHome().length + 1));
      } catch { /* undeterminable: keep */ }
    }
    removed.push(...await pruneRetiredLandingState());
    removed.push(...await pruneFixtureEvidence());
  } catch { /* housekeeping never fails its caller */ }
  return removed;
}

/**
 * Integrated-artifact evidence recorded for a test fixture's repository, written before tests had
 * their own home: one in a `peach-*` directory of the system temporary directory that no longer
 * exists. Nothing can refer to it again. Evidence for any other repository is kept, including a
 * real one that once lived in the temporary directory.
 */
async function pruneFixtureEvidence() {
  const removed: string[] = [];
  const temporary = await realpath(tmpdir()).catch(() => tmpdir());
  for (const file of await names(landedHome())) {
    if (!file.startsWith("artifact-") || !file.endsWith(".json")) continue;
    try {
      const path = join(landedHome(), file);
      const root = (await readJsonOptional(path))?.integrationRoot;
      if (typeof root !== "string" || ![temporary, tmpdir()].some((home) => root.startsWith(`${home}/peach-`)) || !await gone(root)) continue;
      await rm(path, { force: true });
      removed.push(path.slice(stateHome().length + 1));
    } catch { /* keep */ }
  }
  return removed;
}

/**
 * State only local landings wrote: verification-slot locks and records, and post-land
 * runs. Landings verify on the runner now, so nothing here is in flight.
 */
async function pruneRetiredLandingState() {
  const removed: string[] = [];
  for (const entry of await names(stateHome())) {
    if (!entry.startsWith("verification-slot") && entry !== "post-land") continue;
    try { await rm(join(stateHome(), entry), { recursive: true, force: true }); removed.push(entry); }
    catch { /* keep */ }
  }
  return removed;
}
