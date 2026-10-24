import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync } from "node:fs";
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { run, workspaceContext } from "../infra/workspace-jj.ts";
import { jj } from "../infra/workspace-jj.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "../infra/workspace-transaction.ts";
import { stateHome, workspaceHome } from "./workspace-paths.ts";
import { readIntegrationPolicy } from "../policy/execution-policy.ts";
import { generatedPathMatchers } from "../policy/execution-policy.ts";
import { uniqueUntrackedMaterial } from "./workspace-lifecycle.ts";
import { listWorkspaces } from "./workspace-state.ts";

/**
 * Archive and restore: the half of workspace hygiene that eviction cannot do.
 *
 * Eviction keeps the checkout because a thread may still resume it. An archive keeps
 * what a person wrote — the commits, the tracked source and the files no history
 * vouches for — and lets the checkout itself go. Nothing is removed here: archiving
 * is preservation, and the caller decides whether the checkout follows.
 *
 * The commits survive in the repository's own store; the archive holds a bookmark
 * naming them, so collection cannot take them, and every file outside history goes
 * into a payload tarball beside a manifest that names it. A restore recreates a
 * workspace at the archived commit and unpacks the payload.
 */
export const ARCHIVE_VERSION: number = 1;
/** An archive larger than this is refused, so a stray build tree cannot become a "backup". */
export const ARCHIVE_LIMIT_BYTES: number = 512 * 1024 * 1024;
export const ARCHIVE_LIMIT_FILES: number = 20_000;

export type WorkspaceArchive = {
  version: number;
  id: string;
  workspaceName: string;
  workspacePath: string;
  repository: string;
  commitId: string;
  changeId: string;
  baseCommitId: string;
  createdAt: string;
  reason: string;
  /** Files outside history, repository-relative. */
  inventory: string[];
  /** What each of those files was: bytes, mode and link target, hashed. */
  inventoryDigests: Record<string, string>;
  payload: { file: string; sha256: string; bytes: number } | null;
  bookmark: string;
};

export type ArchiveRefusal = { refusal: string } | null;

const archivesHome = () => join(stateHome(), "archives");

/**
 * Flush a file or directory entry to disk. A host that cannot sync gets a refusal
 * rather than an "archived" that a crash could take back.
 */
export function syncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
export const archivePath = (id: string) => join(archivesHome(), `${id}.json`);
export const archivePayloadPath = (id: string) => join(archivesHome(), `${id}.tar.gz`);

/**
 * Why this checkout cannot be archived, or null when it can. Every unknown refuses:
 * a checkout SlipJay cannot describe completely is never called preserved.
 */
export async function archiveRefusal(root: string, integrationRoot: string, options: {
  limitBytes?: number; limitFiles?: number;
} = {}): Promise<ArchiveRefusal> {
  const absolute = resolve(root);
  if (!existsSync(absolute)) return { refusal: "the checkout is not on disk" };
  if (absolute === resolve(integrationRoot)) return { refusal: "the integration checkout is not a workspace to archive" };
  const context = await workspaceContext(absolute).catch(() => null);
  if (!context) return { refusal: "not a SlipJay workspace (no Jujutsu identity)" };
  if (resolve(context.integration.root) !== resolve(integrationRoot)) {
    return { refusal: "the checkout belongs to a different repository" };
  }
  // `jj resolve --list` exits non-zero when there is nothing to list: that is clean, not an error.
  const conflicts = await run("jj", ["--color=never", "resolve", "--list"], { cwd: absolute });
  const conflictsText = `${conflicts.stdout}\n${conflicts.stderr}`.trim();
  if (conflicts.code !== 0 && !/no conflicts found/i.test(conflictsText)) {
    return { refusal: `its conflicts cannot be read: ${conflictsText.split("\n").slice(-1)[0] ?? "unknown error"}` };
  }
  if (conflicts.stdout.trim()) return { refusal: "it has unresolved conflicts, which an archive would record as source" };
  const nested = await nestedRepositories(absolute, integrationRoot);
  if (nested.found.length) return { refusal: `it holds a nested repository (${nested.found.slice(0, 3).join(", ")}), whose own history an archive cannot keep` };
  if (nested.deep) return { refusal: "its directories nest deeper than an archive can prove are free of a nested repository" };
  const inventory = await inventoryOf(absolute, integrationRoot).catch(() => null);
  if (inventory === null) return { refusal: "its files outside history cannot be read" };
  if (inventory.length > (options.limitFiles ?? ARCHIVE_LIMIT_FILES)) {
    return { refusal: `it holds ${inventory.length} files outside history, over the ${options.limitFiles ?? ARCHIVE_LIMIT_FILES} this archive keeps` };
  }
  const bytes = await bytesOf(absolute, inventory);
  if (bytes > (options.limitBytes ?? ARCHIVE_LIMIT_BYTES)) {
    return { refusal: `its files outside history are ${(bytes / 1024 / 1024).toFixed(0)} MB, over the ${((options.limitBytes ?? ARCHIVE_LIMIT_BYTES) / 1024 / 1024).toFixed(0)} MB an archive keeps` };
  }
  return null;
}

/** Nested `.git`/`.jj` directories below the root: their private history would not survive. */
const NESTED_SEARCH_DEPTH = 8;

/**
 * Nested `.git`/`.jj` markers below the root, as directories *or* files: a worktree or a
 * submodule points at its parent with a `.git` file, and its own history would not survive
 * this archive. `deep` is set when the walk stopped at its depth bound before it could
 * finish, which the refusal reports rather than reading as clean.
 */
async function nestedRepositories(root: string, integrationRoot: string, limit: number = 5): Promise<{ found: string[]; deep: boolean }> {
  const found: string[] = [];
  let deep = false;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (found.length >= limit) return;
    if (depth > NESTED_SEARCH_DEPTH) { deep = true; return; }
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.name === ".jj" || entry.name === ".git") {
        if (depth > 0) found.push(path);
        continue;
      }
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      if (resolve(path) === resolve(integrationRoot)) continue;
      await walk(path, depth + 1);
      if (found.length >= limit) return;
    }
  };
  await walk(root, 0);
  return { found, deep };
}

export async function inventoryOf(root: string, integrationRoot: string): Promise<string[]> {
  // The repository's own `generatedPaths` say what it can rebuild, and the Spec keeps
  // those out of an archive. No primary root, though: a link pointing into the
  // integration checkout is still this workspace's own material, and skipping it would
  // lose it.
  const { generated } = await declaredPaths(integrationRoot);
  return await uniqueUntrackedMaterial(root, ARCHIVE_LIMIT_FILES + 1, generated, null);
}

const declaredPathsRead = new Map<string, { at: number; paths: Promise<{ generated: RegExp[] }> }>();
const DECLARED_PATHS_TTL_MS = 60_000;

/** The repository's `generatedPaths`, from the policy on its integration bookmark, briefly cached. */
function declaredPaths(integrationRoot: string): Promise<{ generated: RegExp[] }> {
  const cached = declaredPathsRead.get(integrationRoot);
  if (cached && Date.now() - cached.at < DECLARED_PATHS_TTL_MS) return cached.paths;
  const paths = readIntegrationPolicy(integrationRoot, { hintRoot: integrationRoot })
    .then(({ policy }) => ({ generated: generatedPathMatchers(policy?.generatedPaths) }))
    .catch(() => ({ generated: [] as RegExp[] }));
  declaredPathsRead.set(integrationRoot, { at: Date.now(), paths });
  return paths;
}

async function bytesOf(root: string, inventory: string[]): Promise<number> {
  let total = 0;
  for (const path of inventory) {
    const facts = await stat(join(root, path)).catch(() => null);
    if (facts?.isFile()) total += facts.size;
  }
  return total;
}

/** Preserve a checkout: its commit, a bookmark that keeps it, and every file outside history. */
export async function archiveWorkspace(root: string, options: {
  reason?: string; now?: number; limitBytes?: number; limitFiles?: number;
} = {}): Promise<{ archive: WorkspaceArchive } | { refusal: string }> {
  const context = await workspaceContext(root).catch(() => null);
  if (!context) return { refusal: "not a SlipJay workspace (no Jujutsu identity)" };
  const integrationRoot = resolve(context.integration.root);
  const refusal = await archiveRefusal(root, integrationRoot, options);
  if (refusal) return refusal;

  const [name] = (await listWorkspaces(integrationRoot)).filter((workspace) => workspace.root && resolve(workspace.root) === resolve(root)).map((workspace) => workspace.name);
  const workspaceName = name ?? context.current.name;
  const createdAt = new Date(options.now ?? Date.now());
  const commitId = (await jj(root, ["--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "commit_id"])).trim();
  const changeId = (await jj(root, ["--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "change_id"])).trim();
  const baseCommitId = (await jj(root, ["--ignore-working-copy", "log", "-r", "@-", "--no-graph", "-T", "commit_id"])).trim();
  const inventory = await inventoryOf(root, integrationRoot);
  // Digests are taken after packing, below: a file rewritten during the pack would
  // otherwise leave transient bytes in the payload and the final bytes in the manifest.
  const id = createHash("sha256").update(`${integrationRoot}\n${workspaceName}\n${commitId}\n${createdAt.toISOString()}`).digest("hex").slice(0, 16);
  const bookmark = `slipjay-archive-${id}`;

  // The bookmark is what keeps the commits: without it the store may collect them.
  await jj(integrationRoot, ["bookmark", "create", bookmark, "-r", commitId]);

  let payload: WorkspaceArchive["payload"] = null;
  let inventoryDigests: Record<string, string> = {};
  if (inventory.length) {
    await mkdir(archivesHome(), { recursive: true, mode: 0o700 });
    const file = archivePayloadPath(id);
    // `./` before every entry: a file someone named `--exclude=*` is a name, never an option.
    const listing = inventory.map((path) => `./${path}`).join("\n");
    const packed = await run("tar", ["-czf", file, "--files-from", "-"], { cwd: root, input: listing });
    if (packed.code !== 0) {
      await rm(file, { force: true });
      await jj(integrationRoot, ["bookmark", "delete", bookmark]).catch(() => undefined);
      return { refusal: `its files outside history could not be packed: ${packed.stderr.trim().split("\n").slice(-1)[0] ?? "unknown error"}` };
    }
    // The payload must hold exactly what the inventory names: a packer that quietly dropped
    // entries would otherwise produce an archive whose manifest promises bytes it lacks.
    const listed = await run("tar", ["-tzf", file], { cwd: root });
    const packedFiles = new Set(listed.stdout.split("\n").map((entry) => entry.replace(/^\.\//, "")).filter((entry) => entry && !entry.endsWith("/")));
    const missing = inventory.filter((path) => !packedFiles.has(path));
    if (listed.code !== 0 || missing.length) {
      await rm(file, { force: true });
      await jj(integrationRoot, ["bookmark", "delete", bookmark]).catch(() => undefined);
      return { refusal: `its payload does not hold every file its inventory names (missing ${missing.slice(0, 3).join(", ") || "members unreadable"})` };
    }
    const bytes = readFileSync(file);
    syncPath(file);
    payload = { file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength };
    // The payload is the authority: describe what it holds, not the checkout it came from.
    // A file rewritten while tar read it would otherwise leave old bytes in the payload and
    // new bytes in the manifest, and a restore would hand back the old ones.
    const extracted = await mkdtemp(join(tmpdir(), "slipjay-archive-"));
    try {
      const unpacked = await run("tar", ["-xpzf", file, "-C", extracted], { cwd: root });
      if (unpacked.code !== 0) {
        await rm(file, { force: true });
        await jj(integrationRoot, ["bookmark", "delete", bookmark]).catch(() => undefined);
        return { refusal: `its payload could not be read back to describe it: ${unpacked.stderr.trim().split("\n").slice(-1)[0] ?? "unknown error"}` };
      }
      inventoryDigests = await materialDigests(extracted, inventory);
    } finally {
      await rm(extracted, { recursive: true, force: true });
    }
  }

  const archive: WorkspaceArchive = {
    version: ARCHIVE_VERSION, id, workspaceName, workspacePath: resolve(root), repository: integrationRoot,
    commitId, changeId, baseCommitId, createdAt: createdAt.toISOString(),
    reason: options.reason ?? "archived", inventory, inventoryDigests, payload, bookmark,
  };
  await mkdir(archivesHome(), { recursive: true, mode: 0o700 });
  // The manifest is written last: an archive a reader can find is one whose payload is complete.
  await writeWorkspaceJson(archivePath(id), archive);
  // Durably on disk before anyone may remove the checkout this archive stands for.
  syncPath(archivePath(id));
  syncPath(archivesHome());
  return { archive };
}

/**
 * What a set of files outside history actually is: their bytes, their mode and, for a
 * link, where it points. An archive that recorded only names could not tell a changed
 * file from the one it holds, and a release would then delete material it never kept.
 */
export async function materialDigests(root: string, inventory: string[]): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  for (const path of inventory) {
    const facts = await lstat(join(root, path)).catch(() => null);
    if (!facts) continue;
    const hash = createHash("sha256");
    if (facts.isSymbolicLink()) {
      hash.update(`link:${await readlink(join(root, path)).catch(() => "unreadable")}`);
    } else if (facts.isFile()) {
      // Raw bytes, not a decoded string: two different byte sequences must never hash alike.
      const bytes = await readFile(join(root, path)).catch(() => null);
      if (bytes === null) {
        // Unreadable is not empty: record something no archive of a real file can match.
        digests[path] = "unreadable";
        continue;
      }
      hash.update(`file:${(facts.mode & 0o777).toString(8)}:`);
      hash.update(bytes);
    } else hash.update(`other:${(facts.mode & 0o777).toString(8)}`);
    digests[path] = hash.digest("hex");
  }
  return digests;
}

export async function readArchive(id: string): Promise<WorkspaceArchive | null> {
  try {
    return JSON.parse(await readFile(archivePath(id), "utf8")) as WorkspaceArchive;
  } catch {
    return null;
  }
}

export async function listArchives(): Promise<WorkspaceArchive[]> {
  const entries = await readdir(archivesHome()).catch(() => [] as string[]);
  const archives: WorkspaceArchive[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const archive = await readArchive(entry.slice(0, -".json".length));
    if (archive) archives.push(archive);
  }
  return archives.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Recreate a workspace from an archive: a fresh checkout at the archived commit,
 * with the payload unpacked on top. Dependencies are not archived; the first use
 * installs them, exactly as for a claimed spare.
 */
/**
 * The newest archive made for a checkout path. A harness resuming a released thread
 * knows the path, not which attempt archived it, so this is how it finds what to
 * restore without having to have kept the operation id.
 */
export async function latestArchiveFor(workspacePath: string): Promise<WorkspaceArchive | null> {
  const absolute = resolve(workspacePath);
  const archives = (await listArchives()).filter((archive) => resolve(archive.workspacePath) === absolute);
  for (const archive of archives.slice().reverse()) {
    if (archive.payload === null || existsSync(archive.payload.file)) return archive;
  }
  return null;
}

export async function restoreArchive(id: string, options: { name?: string; path?: string } = {}): Promise<{ workspacePath: string; workspaceName: string; archive: WorkspaceArchive } | { refusal: string }> {
  const archive = await readArchive(id);
  if (!archive) return { refusal: `no archive ${id}` };
  if (!existsSync(archive.repository)) return { refusal: `the repository ${archive.repository} is not on this machine` };
  const name = options.name ?? `${archive.workspaceName}-restored`;
  const path = options.path ?? join(workspaceHome(), name);
  if (existsSync(path)) return { refusal: `${path} already exists` };
  // The files outside history are the only copy of what a person wrote there, so a
  // missing or altered payload is a refusal, never a quietly incomplete restore.
  if (archive.inventory.length) {
    if (!archive.payload) return { refusal: `archive ${id} names files outside history but holds no payload` };
    if (!existsSync(archive.payload.file)) return { refusal: `archive ${id} has lost its payload (${archive.payload.file})` };
    const bytes = readFileSync(archive.payload.file);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== archive.payload.sha256) return { refusal: `archive ${id} has a payload that no longer matches its manifest` };
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // The lock covers the whole restore, unpack included: a release that acquires it after the
  // registration exists but before the payload lands would see an empty checkout and retire it.
  const failure = await withWorkspaceTransaction(`allocate:${archive.repository}`, async (): Promise<string | null> => {
    await jj(archive.repository, ["workspace", "add", "--name", name, "--revision", archive.commitId, path]);
    if (!archive.payload) return null;
    const unpacked = await run("tar", ["-xpzf", archive.payload.file], { cwd: path });
    return unpacked.code === 0 ? null : `restored ${path}, but its files outside history did not unpack: ${unpacked.stderr.trim().split("\n").slice(-1)[0] ?? "unknown error"}`;
  }, { waitMs: 120_000 });
  if (failure) return { refusal: failure };
  // The pass's own record says a workspace came back, not only that one went away.
  await mkdir(stateHome(), { recursive: true, mode: 0o700 }).catch(() => undefined);
  await appendFile(archiveOutcomesPath(), `${JSON.stringify({
    requestId: archive.id, workspacePath: path, at: new Date().toISOString(),
    outcome: "restored", reason: `restored from ${archive.id}`, archiveId: archive.id,
  } satisfies ArchiveOutcome)}\n`).catch(() => undefined);
  return { workspacePath: path, workspaceName: name, archive };
}

/**
 * A release request: the harness holding a thread's binding says this workspace may
 * go, naming the workspace it means. SlipJay archives first and retires second, and
 * a request that cannot be honoured stays on disk to be retried, never acted on
 * half-way. Ownership arrives this way — pushed, with its own identity — rather than
 * by SlipJay reading another application's state.
 */
export type ArchiveRequest = {
  id: string;
  workspacePath: string;
  reason?: string;
  /** Remove the checkout once its archive is durable. */
  retire?: boolean;
  /** The binding the request came from; recorded now so a later generation can be told apart. */
  thread?: string;
  generation?: number;
  requestedAt: string;
  /** The archive already made for this request, so a waiting pass does not make another. */
  archiveId?: string;
  attempts?: number;
  lastError?: string | null;
};

export type ArchiveOutcome = {
  requestId: string;
  workspacePath: string;
  at: string;
  outcome: "archived" | "retired" | "restored" | "failed" | "skipped";
  reason: string;
  archiveId?: string;
};

export const archiveRequestsHome = (): string => join(stateHome(), "archive-requests");
export const archiveOutcomesPath = (): string => join(stateHome(), "archive-outcomes.jsonl");

async function readRequests(): Promise<Array<{ file: string; request: ArchiveRequest }>> {
  const entries = await readdir(archiveRequestsHome()).catch(() => [] as string[]);
  const requests: Array<{ file: string; request: ArchiveRequest }> = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = join(archiveRequestsHome(), entry);
    try {
      requests.push({ file, request: JSON.parse(await readFile(file, "utf8")) as ArchiveRequest });
    } catch (error) {
      // An unreadable request is reported and left in place: dropping it silently is the
      // failure the retry exists to prevent.
      await appendFile(archiveOutcomesPath(), `${JSON.stringify({
        requestId: entry.slice(0, -".json".length), workspacePath: "", at: new Date().toISOString(),
        outcome: "failed", reason: `the request file could not be read: ${error instanceof Error ? error.message : String(error)}`,
      } satisfies ArchiveOutcome)}\n`).catch(() => undefined);
    }
  }
  return requests;
}

/**
 * Process every pending release request: archive it, retire it when the request asks
 * and the checkout is not in use, or record why not and keep the request for the next
 * pass. Every outcome is appended to one record, so the hourly pass can be inspected.
 */
export async function processArchiveRequests(options: { now?: number; retire?: boolean } = {}): Promise<ArchiveOutcome[]> {
  const now = options.now ?? Date.now();
  const outcomes: ArchiveOutcome[] = [];
  const record = async (outcome: ArchiveOutcome) => {
    outcomes.push(outcome);
    await mkdir(stateHome(), { recursive: true, mode: 0o700 });
    await appendFile(archiveOutcomesPath(), `${JSON.stringify(outcome)}\n`);
  };
  for (const { file, request } of await readRequests()) {
    const base = { requestId: request.id, workspacePath: request.workspacePath, at: new Date(now).toISOString() };
    try {
      if (!existsSync(request.workspacePath)) {
        await record({ ...base, outcome: "skipped", reason: "the checkout is already gone" });
        await rm(file, { force: true });
        continue;
      }
      // A null context is ambiguous: the checkout may have left SlipJay, or Jujutsu may have
      // failed for a moment. Dropping the request on the second reading would lose it, so it
      // is retried and reported instead.
      const context = await workspaceContext(request.workspacePath).catch(() => null);
      if (!context) {
        const reason = "its Jujutsu identity could not be read this pass; retrying next pass";
        await record({ ...base, outcome: "failed", reason });
        await writeRequestRetry(file, request, reason, now);
        continue;
      }
      // A request waiting for ownership keeps the archive it already made: re-archiving every
      // pass would mint a new id and a new retention bookmark each time.
      const existing = request.archiveId ? await readArchive(request.archiveId) : null;
      let archived = existing ? { archive: existing } : await archiveWorkspace(request.workspacePath, { reason: request.reason ?? "release request", now });
      if ("refusal" in archived) {
        await record({ ...base, outcome: "failed", reason: archived.refusal });
        await writeRequestRetry(file, request, archived.refusal, now);
        continue;
      }
      const archiveId = archived.archive.id;
      // Retirement waits for an ownership claim that can be validated against a resume: the
      // request names a thread and generation, but nothing here can prove they are still
      // current, and an idle thread holds no process to check.
      if (options.retire ?? request.retire) {
        await record({ ...base, outcome: "archived", reason: "archived; kept, because retirement needs an ownership claim this pass cannot validate", archiveId });
        await writeRequestRetry(file, { ...request, archiveId }, "archived; retirement waits for a validated ownership claim", now);
        continue;
      }
      // Recorded before the request is cleared: an interruption leaves one or the other, never neither.
      await record({ ...base, outcome: "archived", reason: "archived", archiveId });
      await rm(file, { force: true });
    } catch (error) {
      const reason = `the pass could not honour it: ${error instanceof Error ? error.message : String(error)}`;
      await record({ ...base, outcome: "failed", reason }).catch(() => undefined);
      await writeRequestRetry(file, request, reason, now).catch(() => undefined);
    }
  }
  return outcomes;
}

async function writeRequestRetry(file: string, request: ArchiveRequest, reason: string, now: number): Promise<void> {
  await writeWorkspaceJson(file, { ...request, attempts: (request.attempts ?? 0) + 1, lastError: reason, lastAttemptAt: new Date(now).toISOString() });
}
