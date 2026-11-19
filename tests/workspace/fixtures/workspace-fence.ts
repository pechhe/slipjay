import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateHome } from "../../../src/lib/workspace/workspace-paths.ts";

/** The custody record of a checkout, keyed by the canonical path it was admitted under. */
export function custodyRecordPath(canonicalPath: string): string {
  return join(stateHome(), "custody", `${createHash("sha256").update(canonicalPath).digest("hex")}.json`);
}

/**
 * Rewrite the retirement fence of a checkout's current custody generation: `null` removes it,
 * and any other record stands in for one a process left behind, a legacy one included.
 * Rewriting the file is the only way to reach the state a crash or an earlier version left.
 */
export async function writeRetirementFence(path: string, fence: Record<string, unknown> | null): Promise<void> {
  const file = custodyRecordPath(path);
  const record = JSON.parse(await readFile(file, "utf8")) as { current: string; generations: Array<{ id: string; retirement?: unknown }> };
  const current = record.generations.find((generation) => generation.id === record.current);
  if (!current) throw new Error("the custody record names no current generation");
  if (fence) current.retirement = fence;
  else delete current.retirement;
  await writeFile(file, JSON.stringify(record));
}

/** A controller identity no process can hold: its PID probes ESRCH, so the owner is provably gone. */
export function goneController(): { platform: string; pid: number; boot: string; start: string } {
  return { platform: process.platform, pid: 2147483647, boot: "a boot that has ended", start: "a process that has exited" };
}
