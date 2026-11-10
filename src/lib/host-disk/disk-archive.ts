/**
 * Archiving a closed, expired Issue's run evidence before its directory is removed (SJ-226): every file of
 * at most 1 MiB (reports, logs, configs, the manifest) is copied into
 * `~/.slipjay/state/evidence/<issue>-<time>/files/` with a `provenance.json` naming each file's path,
 * size and SHA-256, following the convention of `preserveWorkspaceEvidence` (written as `<name>.partial`,
 * renamed once complete). Bigger files are the bulk being freed and are dropped, and counted. Small
 * files over 64 MiB in total, a copy that fails, or a directory that changes during the copy keep
 * everything: this throws, and the caller removes nothing.
 */
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { evidenceHome } from "../workspace/workspace-paths.ts";
import { MIB } from "./disk-plan.ts";

export const SMALL_FILE_BYTES: number = MIB;
export const MAX_ARCHIVE_BYTES: number = 64 * MIB;

export type ArchiveSummary = {
  directory: string;
  keptFiles: number;
  keptBytes: number;
  droppedFiles: number;
  droppedBytes: number;
  skipped: string[];
};

type Inventory = {
  files: Array<{ path: string; bytes: number; mtimeMs: number }>;
  links: Array<{ path: string; target: string }>;
  skipped: string[];
};

async function inventory(root: string): Promise<Inventory> {
  const found: Inventory = { files: [], links: [], skipped: [] };
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, path);
      else if (entry.isSymbolicLink()) found.links.push({ path, target: await readlink(absolute) });
      else if (entry.isFile()) { const { size, mtimeMs } = await lstat(absolute); found.files.push({ path, bytes: size, mtimeMs }); }
      else found.skipped.push(path);
    }
  };
  await walk(root, "");
  return found;
}

const sha256 = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");
const safe = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, "_");

/** Copy the small files of `directory` into the evidence home; the directory itself is not touched. */
export async function archiveEvidence(directory: string, manifest: { issue: string; owner: string }, now: number = Date.now()): Promise<ArchiveSummary> {
  const before = await inventory(directory);
  const small = before.files.filter((file) => file.bytes <= SMALL_FILE_BYTES);
  const dropped = before.files.filter((file) => file.bytes > SMALL_FILE_BYTES);
  const total = small.reduce((sum, file) => sum + file.bytes, 0);
  if (total > MAX_ARCHIVE_BYTES) {
    throw new Error(`its small files total ${Math.ceil(total / MIB)} MiB, more than the ${MAX_ARCHIVE_BYTES / MIB} MiB an archive keeps`);
  }
  const target = join(evidenceHome(), `${safe(manifest.issue)}-${new Date(now).toISOString().replace(/[:.]/g, "-")}`);
  const partial = `${target}.partial`;
  try {
    await rm(partial, { recursive: true, force: true });
    const recorded: Array<{ path: string; bytes: number; sha256: string }> = [];
    for (const file of small) {
      const destination = join(partial, "files", file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const digest = await sha256(join(directory, file.path));
      await copyFile(join(directory, file.path), destination);
      if (await sha256(destination) !== digest) throw new Error(`the copy of ${file.path} does not match it`);
      recorded.push({ path: file.path, bytes: file.bytes, sha256: digest });
    }
    // A directory still being written is not finished evidence: compare before the copy is kept.
    const after = await inventory(directory);
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("it changed while it was being archived");
    await mkdir(partial, { recursive: true, mode: 0o700 });
    await writeFile(join(partial, "provenance.json"), `${JSON.stringify({
      version: 1, kind: "run-evidence", issue: manifest.issue, owner: manifest.owner, source: directory,
      preservedAt: new Date(now).toISOString(), files: recorded, links: before.links, skipped: before.skipped,
      dropped: dropped.map(({ path, bytes }) => ({ path, bytes })),
    }, null, 2)}\n`, { mode: 0o600 });
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    directory: target, keptFiles: small.length, keptBytes: total, droppedFiles: dropped.length,
    droppedBytes: dropped.reduce((sum, file) => sum + file.bytes, 0), skipped: before.skipped,
  };
}
