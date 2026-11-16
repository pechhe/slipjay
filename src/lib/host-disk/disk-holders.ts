/**
 * Which live processes hold a file under a directory open or mapped (SJ-226). A working directory is not
 * enough for scratch and evidence: a build that mapped `node_modules/.../x.node` from a scratch tree runs
 * from somewhere else. Linux reads /proc; Darwin uses bounded lsof. Unsupported or unreadable inventories
 * answer null, so the planner keeps what it cannot judge. Inaccessible processes are skipped by both readers.
 */
import { run } from "../infra/workspace-jj.ts";
import { readdir, readFile, readlink } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { within } from "../workspace/workspace-holders.ts";
import type { ProcessWorkingDirectory } from "../workspace/workspace-holders.ts";

export type OpenPaths = Array<{ pid: number; command: string; paths: Set<string> }>;

/** Absolute paths open or mapped by readable processes, or null when the inventory cannot be read safely. */
export async function openPathsByProcess(options: { platform?: string; run?: typeof run } = {}): Promise<OpenPaths | null> {
  const hostPlatform = options.platform ?? platform();
  if (hostPlatform === "darwin") {
    const result = await (options.run ?? run)("lsof", ["-nP", "-Fpcn"], { timeoutMs: 5000 }).catch(() => null);
    // Like /proc, lsof may skip inaccessible processes. Empty/truncated output is never evidence of absence.
    return result && !result.timedOut && !result.truncated && (result.code === 0 || result.code === 1) && /^p\d/m.test(result.stdout) ? parseLsofPaths(result.stdout) : null;
  }
  if (hostPlatform !== "linux") return null;
  const entries = await readdir("/proc").catch(() => null);
  if (!entries) return null;
  const found: OpenPaths = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const base = join("/proc", entry);
    const paths = new Set<string>();
    // A process whose descriptors the kernel hides from this user (an sshd privilege-separation child, a browser sandbox
    // process, an exited one) cannot be listed and is skipped: on a host like peach-box dozens of the user's own
    // processes are such, so refusing to judge over them would leave scratch unremovable for ever. The list being
    // unreadable altogether (no /proc) still keeps everything.
    const descriptors = await readdir(join(base, "fd")).catch(() => null);
    if (descriptors === null) continue;
    for (const descriptor of descriptors) {
      const target = await readlink(join(base, "fd", descriptor)).catch(() => null);
      if (target?.startsWith("/")) paths.add(target);
    }
    for (const line of (await readFile(join(base, "maps"), "utf8").catch(() => "")).split("\n")) {
      const at = line.indexOf("/");
      if (at > 0) paths.add(line.slice(at).replace(/ \(deleted\)$/, ""));
    }
    if (!paths.size) continue;
    found.push({ pid: Number(entry), command: (await readFile(join(base, "comm"), "utf8").catch(() => "")).trim(), paths });
  }
  return found;
}

/** lsof's field format preserves spaces in names; cwd, descriptors and mappings all have n records. */
export function parseLsofPaths(text: string): OpenPaths {
  const found: OpenPaths = [];
  let current: OpenPaths[number] | undefined;
  for (const line of text.split("\n")) {
    if (/^p\d+$/.test(line)) { current = { pid: Number(line.slice(1)), command: "", paths: new Set() }; found.push(current); }
    else if (current && line.startsWith("c")) current.command = line.slice(1);
    else if (current && line.startsWith("n/")) current.paths.add(line.slice(1).replace(/ \(deleted\)$/, ""));
  }
  return found;
}

/** The processes with a file under `directory` open or mapped, shaped like working-directory holders. */
export function holdersOfOpenFiles(directory: string, open: OpenPaths): ProcessWorkingDirectory[] {
  const holders: ProcessWorkingDirectory[] = [];
  for (const process of open) {
    for (const path of process.paths) {
      if (within(path, directory)) { holders.push({ pid: process.pid, command: process.command, cwd: path }); break; }
    }
  }
  return holders;
}
