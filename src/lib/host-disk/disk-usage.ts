import { run } from "../infra/workspace-jj.ts";
import type { DiskUsage } from "./disk-plan.ts";

/** Reads how full a filesystem is; null when it cannot be read. Injected wherever the clock or the disk matters. */
export type DiskUsageReader = () => Promise<DiskUsage | null>;

/** The root filesystem's usage as `df` reports it: used / (used + available), the percentage `df` prints. */
export const readRootUsage: DiskUsageReader = async () => {
  const result = await run("df", ["-Pk", "/"], { timeoutMs: 20_000 }).catch(() => null);
  if (!result || result.code !== 0) return null;
  const columns = result.stdout.trim().split("\n").at(-1)?.trim().split(/\s+/);
  const used = Number(columns?.[2]);
  const available = Number(columns?.[3]);
  if (!Number.isFinite(used) || !Number.isFinite(available) || used + available <= 0) return null;
  const totalBytes = (used + available) * 1024;
  return { percent: Math.ceil((used / (used + available)) * 100), totalBytes, freeBytes: available * 1024 };
};
