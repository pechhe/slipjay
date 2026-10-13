import { readdir, readFile, readlink } from "node:fs/promises";
import { platform } from "node:os";
import { join, resolve, sep } from "node:path";
import { run } from "./workspace-jj.mjs";

/**
 * Live processes working inside a directory. Cleanup never deletes a checkout a
 * process is using; naming the holders lets whoever is waiting on that checkout
 * stop them. Reading working directories is best-effort: callers fail closed
 * when it is unavailable.
 */

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

export function within(path, root) {
  const target = resolve(path);
  const base = resolve(root);
  return target === base || target.startsWith(base + sep);
}

/** `{ pid, command, cwd }` for every process on this host, or null when they cannot be read. */
export async function processWorkingDirectories() {
  if (platform() === "linux") {
    const found = [];
    for (const entry of await readdir("/proc").catch(() => [])) {
      if (!/^\d+$/.test(entry)) continue;
      const cwd = await readlink(join("/proc", entry, "cwd")).catch(() => null);
      if (!cwd) continue;
      const command = (await readFile(join("/proc", entry, "comm"), "utf8").catch(() => "")).trim();
      found.push({ pid: Number(entry), command, cwd });
    }
    return found;
  }
  const result = await run("lsof", ["-n", "-P", "-w", "-d", "cwd", "-F", "pcRn"]).catch(() => null);
  // lsof exits 1 when some processes could not be inspected; the rest is still valid.
  if (!result || !result.stdout || result.truncated) return null;
  const found = [];
  let pid = 0;
  let parent = 0;
  let command = "";
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("p")) { pid = Number(line.slice(1)); parent = 0; command = ""; }
    else if (line.startsWith("R")) parent = Number(line.slice(1));
    else if (line.startsWith("c")) command = line.slice(1);
    // The probe itself inherits this process's directory; it is not a holder.
    else if (line.startsWith("n/") && !(parent === process.pid && command === "lsof")) found.push({ pid, command, cwd: line.slice(1) });
  }
  return found;
}

/**
 * This process, its ancestors and its process group: the session that ran the
 * command is the caller, not a bystander, and so is the rest of its shell job
 * (`slipjay land | tail` puts `tail` beside slipjay in its group, not above it).
 */
export async function callerPids(pid = process.pid) {
  const pids = new Set([pid]);
  const listed = await run("ps", ["-A", "-o", "pid=,ppid=,pgid="], { timeoutMs: 10_000 }).catch(() => null);
  if (!listed || listed.code !== 0) return pids;
  const parentOf = new Map();
  const groupOf = new Map();
  for (const line of listed.stdout.split("\n")) {
    const [child, parent, group] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
    parentOf.set(child, parent);
    if (Number.isInteger(group)) groupOf.set(child, group);
  }
  for (let up = parentOf.get(pid); up > 1 && !pids.has(up); up = parentOf.get(up)) pids.add(up);
  const group = groupOf.get(pid);
  if (group > 1) for (const [member, memberGroup] of groupOf) if (memberGroup === group) pids.add(member);
  return pids;
}

/** Processes with their working directory inside `root`, minus `ignore` pids; null when unreadable. */
export async function workspaceHolders(root, { processes, ignore = new Set() } = {}) {
  const all = processes ?? await processWorkingDirectories();
  if (!all) return null;
  return all.filter((entry) => !ignore.has(entry.pid) && within(entry.cwd, root));
}

/** `pid 123 (node), pid 456 (sleep)` */
export function describeHolders(holders) {
  return holders.map(({ pid, command }) => `pid ${pid}${command ? ` (${command})` : ""}`).join(", ");
}
