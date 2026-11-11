import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { run } from "../infra/workspace-jj.ts";
import { slipjayHome } from "../workspace/workspace-paths.ts";
import type { DiskUsage } from "./disk-plan.ts";

/** Reads how full a filesystem is; null when it cannot be read. Injected wherever the clock or the disk matters. */
export type DiskUsageReader = () => Promise<DiskUsage | null>;

/** Runs one command, so a test can state what the host answers about the disk. */
type DiskCommand = (command: string, args: string[], options?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * The filesystem the policy measures: the one holding SlipJay's state home, where its workspaces, ballast, rescue
 * settings and run evidence all live. On macOS `/` is the sealed system volume, which holds only the OS: it read 40%
 * full while the Data volume holding everything SlipJay manages read 96%, so measuring `/` left the host at `ok` and
 * nothing ever shed. On Linux this is normally the root filesystem itself, and a machine with no state home yet
 * measures the home it will be created in, which is on the same filesystem.
 */
export function usagePath(): string {
  const state = slipjayHome();
  return existsSync(state) ? state : homedir();
}

/** The usage `df` reports of the filesystem holding `path`: used / (used + available), the percentage `df` prints. */
export async function readUsageOf(path: string, exec: DiskCommand = run): Promise<DiskUsage | null> {
  const result = await exec("df", ["-Pk", path], { timeoutMs: 20_000 }).catch(() => null);
  if (!result || result.code !== 0) return null;
  const columns = result.stdout.trim().split("\n").at(-1)?.trim().split(/\s+/);
  const used = Number(columns?.[2]);
  const available = Number(columns?.[3]);
  if (!Number.isFinite(used) || !Number.isFinite(available) || used + available <= 0) return null;
  const totalBytes = (used + available) * 1024;
  return { percent: Math.ceil((used / (used + available)) * 100), totalBytes, freeBytes: available * 1024, usedBytes: used * 1024 };
}

/** The host's usage as the policy measures it (see `usagePath`). */
export const readHostUsage: DiskUsageReader = () => readUsageOf(usagePath());
