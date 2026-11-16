import type { OperationStoreReport } from "./operation-stores.ts";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { stateHome } from "../workspace/workspace-paths.ts";
import { writeWorkspaceJson } from "../infra/workspace-transaction.ts";

export const DISK_HEARTBEAT_STALE_MS: number = 2 * 60 * 60_000;
export const diskHeartbeatPath = () => join(stateHome(), "disk-heartbeat.json");
export function heartbeatWarning(at: unknown, now: number): string | null {
  return typeof at !== "number" || !Number.isFinite(at) || at > now || now - at > DISK_HEARTBEAT_STALE_MS
    ? "WARNING: disk pressure heartbeat missing or stale (>2h); check the disk-guard timer" : null;
}
export async function readHeartbeatWarning(now: number): Promise<string | null> {
  const record = await readFile(diskHeartbeatPath(), "utf8").then((text) => JSON.parse(text) as { at?: unknown }).catch(() => null);
  return heartbeatWarning(record?.at, now);
}
export async function writeDiskHeartbeat(record: { at: number; freeBytes?: number; floorBytes: number; level: string; failures: number; operationStores?: OperationStoreReport[] }): Promise<void> {
  await mkdir(stateHome(), { recursive: true, mode: 0o700 });
  await writeWorkspaceJson(diskHeartbeatPath(), record);
}
