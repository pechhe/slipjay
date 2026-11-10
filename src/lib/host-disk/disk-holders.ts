/**
 * Which live processes hold a file under a directory open or mapped (SJ-226). A working directory is not
 * enough for scratch and evidence: a build that mapped `node_modules/.../x.node` from a scratch tree runs
 * from somewhere else. Linux only, from /proc; any other host answers null, so the planner keeps what it
 * cannot judge. A process whose descriptors this user cannot read is skipped, as `lsof` skips it.
 */
import { readdir, readFile, readlink } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";
import { within } from "../workspace/workspace-holders.ts";
import type { ProcessWorkingDirectory } from "../workspace/workspace-holders.ts";

export type OpenPaths = Array<{ pid: number; command: string; paths: Set<string> }>;

/** Every absolute path each readable process has open or mapped, or null off Linux or when /proc is unreadable. */
export async function openPathsByProcess(): Promise<OpenPaths | null> {
  if (platform() !== "linux") return null;
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
