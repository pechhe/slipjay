import { existsSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describeHolders, processAlive, processWorkingDirectories, workspaceHolders } from "./workspace-holders.ts";
import { nonReproducibleFiles } from "./workspace-lifecycle.ts";
import { workspaceStorageHomes } from "./workspace-paths.ts";
import { run } from "../infra/workspace-jj.ts";
import { workspaceMetadata } from "./workspace-state.ts";
import { withWorkspaceTransaction } from "../infra/workspace-transaction.ts";
import { discardCheckout } from "./workspace-trash.ts";

/**
 * Directories in workspace storage that no repository lists as a workspace: a checkout JJ
 * forgot, one whose repository is gone, or a directory with no JJ identity at all (a leftover
 * a tool recreated, an interrupted add). Each gets a named disposition. Only one that holds
 * nothing but reproducible output (dependencies, caches, JJ or Git state), is older than
 * `ORPHAN_MIN_AGE_MS`, and no live process uses converges; anything else is kept and reported
 * with what to do, since its files cannot be checked against any history.
 */

/** Minimum age before an orphan may be removed: a checkout being added has no JJ identity for a moment. */
export const ORPHAN_MIN_AGE_MS: number = 60 * 60_000;

export interface OrphanedCheckout {
  name: string;
  root: string;
  /** The repository the checkout names (which may be gone), or null without a JJ identity. */
  repository: string | null;
  kind: "no-identity" | "repository-missing" | "unregistered";
  /** Live processes working in it, null when process working directories are unreadable. */
  holders: string[] | null;
  /** Files that are not reproducible output, null when unreadable. */
  files: string[] | null;
  action: "remove" | "keep";
  reason: string;
}

/** The repository a checkout's `.jj/repo` pointer names, or null when it has no JJ identity. */
async function namedRepository(root: string): Promise<string | null> {
  // A repository's own checkout keeps its store at `.jj/repo`: it names itself.
  if (await stat(join(root, ".jj", "repo")).then((info) => info.isDirectory(), () => false)) return root;
  const pointer = await readFile(join(root, ".jj", "repo"), "utf8").catch(() => null);
  if (pointer === null) return null;
  // `.jj/repo` points at the repository's store, `<root>/.jj/repo`.
  return dirname(dirname(resolve(join(root, ".jj"), pointer.trim())));
}

/** Real paths of the checkouts a repository lists, or null when it cannot be listed (its checkouts are then unknown, never orphans). */
async function listedCheckouts(repository: string): Promise<Set<string> | null> {
  const listed = await run("jj", ["--color=never", "--ignore-working-copy", "workspace", "list", "-T", 'self.root() ++ "\\n"'], { cwd: repository, timeoutMs: 30_000 }).catch(() => null);
  if (!listed || listed.code !== 0) return null;
  const roots = listed.stdout.split("\n").filter(Boolean);
  return new Set(await Promise.all(roots.map((root) => realpath(root).catch(() => resolve(root)))));
}

type Listings = Map<string, Promise<Set<string> | null>>;

/** One directory of workspace storage as an orphan with its disposition, or null when a repository lists it. */
async function inspectOrphan(path: string, name: string, listings: Listings, processes: Awaited<ReturnType<typeof processWorkingDirectories>> | undefined, now: number): Promise<OrphanedCheckout | null> {
  const root = await realpath(path).catch(() => path);
  const repository = await namedRepository(root);
  const kind: OrphanedCheckout["kind"] = repository === null ? "no-identity" : !existsSync(join(repository, ".jj", "repo")) ? "repository-missing" : "unregistered";
  let listing: Set<string> | null | undefined;
  if (kind === "unregistered") {
    if (!listings.has(repository!)) listings.set(repository!, listedCheckouts(repository!));
    listing = await listings.get(repository!)!;
    if (listing?.has(root)) return null;
  }
  // Unreadable process working directories (null) leave every holder unknown.
  const holders = processes === null ? null : await workspaceHolders(root, processes ? { processes } : {});
  const files = await nonReproducibleFiles(root).catch(() => null);
  const orphan = { name, root, repository, kind, holders: holders && holders.map(({ pid, command }) => `pid ${pid}${command ? ` (${command})` : ""}`), files };
  if (listing === null) return { ...orphan, action: "keep", reason: `${repository}'s workspaces cannot be listed, so whether it is one is unknown` };
  return { ...orphan, ...await disposition(orphan, holders, now) };
}

/** Every orphan in workspace storage, with what housekeeping does with it now. Reads only. */
export async function findOrphanedCheckouts({ now = Date.now() }: { now?: number } = {}): Promise<OrphanedCheckout[]> {
  const listings: Listings = new Map();
  const processes = await processWorkingDirectories();
  const orphans: OrphanedCheckout[] = [];
  for (const home of workspaceStorageHomes()) {
    for (const entry of await readdir(home, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const orphan = await inspectOrphan(join(home, entry.name), entry.name, listings, processes, now);
      if (orphan) orphans.push(orphan);
    }
  }
  return orphans;
}

async function disposition(orphan: Omit<OrphanedCheckout, "action" | "reason">, holders: Awaited<ReturnType<typeof workspaceHolders>>, now: number): Promise<Pick<OrphanedCheckout, "action" | "reason">> {
  const keep = (reason: string) => ({ action: "keep" as const, reason });
  if (!holders) return keep("process working directories unavailable");
  if (holders.length) return keep(`in use by a live process: ${describeHolders(holders)}`);
  if (processAlive((await workspaceMetadata(orphan.name))?.preparingPid)) return keep("a spare is being prepared here");
  const what = orphan.kind === "no-identity" ? "not a JJ checkout"
    : orphan.kind === "repository-missing" ? `its repository ${orphan.repository} is gone`
    : `${orphan.repository} no longer lists it as a workspace`;
  if (orphan.files === null) return keep(`${what}; its files are unreadable`);
  if (orphan.files.length) return keep(`${what}, and it holds files no history can vouch for (${orphan.files.join(", ")}): copy out anything needed, then delete the directory`);
  const created = await stat(orphan.root).then((info) => Math.max(info.birthtimeMs || 0, info.mtimeMs), () => now);
  if (now - created < ORPHAN_MIN_AGE_MS) return keep(`${what}; created recently, so it may be a checkout being added`);
  return { action: "remove", reason: `${what}, and it holds only reproducible output` };
}

/**
 * Remove the orphans `findOrphanedCheckouts` would, checking each again for a live process just
 * before. One sweep runs on the machine at a time; another finding it running does nothing.
 * Returns the directories removed.
 */
export async function retireOrphanedCheckouts(options: { now?: number } = {}): Promise<string[]> {
  try {
    return await withWorkspaceTransaction("orphans", async () => {
      const removed: string[] = [];
      for (const orphan of await findOrphanedCheckouts(options)) {
        if (orphan.action !== "remove") continue;
        // Judged again just before removal, with fresh process working directories.
        const again = await inspectOrphan(orphan.root, orphan.name, new Map(), undefined, options.now ?? Date.now());
        if (again?.action !== "remove") continue;
        // Not `retireWorkspace`: an orphan has no registration to forget and no policy whose teardown applies.
        await discardCheckout(orphan.root);
        removed.push(orphan.root);
      }
      return removed;
    }, { wait: false });
  } catch (error) {
    if ((error as { code?: string } | null | undefined)?.code === "ELOCKED") return [];
    throw error;
  }
}
