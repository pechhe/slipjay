import { readDiskConfig } from "./disk-config.ts";
import type { DiskConfig } from "./disk-config.ts";
import { readHostUsage } from "./disk-usage.ts";
import type { DiskUsage } from "./disk-plan.ts";

/** df's available blocks, not du's shared/cloned bytes, govern admission and pressure. */
export function freeSpaceFloor(config: DiskConfig, usage: DiskUsage): number {
  return Math.max(config.floor.bytes, (usage.totalBytes ?? 0) * config.floor.percent / 100);
}
export function belowFloor(config: DiskConfig, usage: DiskUsage): boolean {
  return usage.freeBytes !== undefined && usage.freeBytes < freeSpaceFloor(config, usage);
}
export function floorRefusal(config: DiskConfig, usage: DiskUsage): string | null {
  if (config.floor.bytes === 0 && config.floor.percent === 0) return null;
  if (usage.freeBytes === undefined) return "Cannot read available disk space; refusing a fresh install";
  if (!belowFloor(config, usage)) return null;
  const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  return `Disk free-space floor: ${gib(usage.freeBytes)} free, ${gib(freeSpaceFloor(config, usage))} required; run slipjay disk to reclaim headroom`;
}
export function hardMinimumRefusal(config: DiskConfig, usage: DiskUsage): string | null {
  if (config.hardMinimum.bytes === 0 && config.hardMinimum.percent === 0) return null;
  const minimum = Math.max(config.hardMinimum.bytes, (usage.totalBytes ?? 0) * config.hardMinimum.percent / 100);
  if (usage.freeBytes === undefined) return "Cannot read available disk space; refusing a fresh install";
  return usage.freeBytes < minimum ? `Disk hard minimum: ${(usage.freeBytes / 1024 ** 3).toFixed(1)} GiB free, ${(minimum / 1024 ** 3).toFixed(1)} GiB required; run slipjay disk before a fresh claim or install` : null;
}
export async function assertInstallHeadroom(options: { readUsage?: typeof readHostUsage; config?: DiskConfig; warn?: (message: string) => void } = {}): Promise<void> {
  const usage = await (options.readUsage ?? readHostUsage)();
  const config = options.config ?? readDiskConfig();
  const refusal = usage ? hardMinimumRefusal(config, usage) : "Cannot read available disk space; refusing a fresh install";
  if (refusal) throw new Error(refusal);
  const warning = usage ? floorRefusal(config, usage) : null;
  if (warning) (options.warn ?? console.warn)(`WARNING: ${warning}. Claims and installs may proceed above the hard minimum; slipjay disk can reclaim excess spares, idle scratch, archive eligible idle workspaces, and shed dependencies.`);
}
export async function assertRefillHeadroom(): Promise<void> {
  const usage = await readHostUsage();
  const refusal = usage ? floorRefusal(readDiskConfig(), usage) : "Cannot read available disk space; refusing spare refill";
  if (refusal) throw new Error(refusal);
}
