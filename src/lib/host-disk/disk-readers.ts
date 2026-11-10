/**
 * Report-only readers for the host disk pass (SJ-235): Docker volumes and loop-mounted images. They only read, and
 * each answers null when its tool is absent or fails, so a host without Docker or loop devices reports nothing wrong.
 */
import { stat } from "node:fs/promises";
import { run } from "../infra/workspace-jj.ts";

export type DockerVolume = { name: string; sizeBytes: number; containers: string[] };
export type LoopImage = { backingFile: string; mount: string | null; hostBytes: number; filesystemBytes: number | null };

const UNITS: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

/** Docker's human size ("1.074GB", "0B"); null for anything else (`N/A`). */
export function parseDockerSize(text: unknown): number | null {
  const match = typeof text === "string" ? /^\s*([\d.]+)\s*([a-z]+)\s*$/i.exec(text) : null;
  const unit = match ? UNITS[match[2]!.toLowerCase()] : undefined;
  return match && unit !== undefined ? Math.round(Number(match[1]) * unit) : null;
}

const jsonLines = (text: string): Array<Record<string, unknown>> => text.split("\n").filter((line) => line.trim().startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);

/** Every Docker volume with its size and the containers (running or not) that mount it; null when Docker cannot be read. */
export async function readDockerVolumes(): Promise<DockerVolume[] | null> {
  try {
    const df = await run("docker", ["system", "df", "-v", "--format", "json"], { timeoutMs: 120_000 });
    const ps = await run("docker", ["ps", "-a", "--format", "json"], { timeoutMs: 60_000 });
    if (df.code !== 0 || ps.code !== 0) return null;
    const users = new Map<string, string[]>();
    for (const container of jsonLines(ps.stdout)) {
      for (const volume of String(container.Mounts ?? "").split(",").filter(Boolean)) users.set(volume, [...users.get(volume) ?? [], String(container.Names ?? container.ID)]);
    }
    const volumes = ((JSON.parse(df.stdout) as { Volumes?: Array<Record<string, unknown>> }).Volumes ?? []);
    return volumes.map((volume) => ({ name: String(volume.Name), sizeBytes: parseDockerSize(volume.Size) ?? 0, containers: users.get(String(volume.Name)) ?? [] }));
  } catch { return null; }
}

/** Every loop-mounted image: the backing file's allocated bytes on the host, and what its mounted filesystem uses. Null where there is no `losetup` (macOS). */
export async function readLoopImages(): Promise<LoopImage[] | null> {
  try {
    const listed = await run("losetup", ["--list", "--json"], { timeoutMs: 20_000 });
    if (listed.code !== 0) return null;
    const images: LoopImage[] = [];
    for (const device of (JSON.parse(listed.stdout) as { loopdevices?: Array<Record<string, unknown>> }).loopdevices ?? []) {
      const backingFile = String(device["back-file"] ?? "").replace(/ \(deleted\)$/, "");
      const info = await stat(backingFile).catch(() => null);
      if (!info) continue;
      const mounted = await run("findmnt", ["--json", "--bytes", "-o", "TARGET,USED", "-S", String(device.name)], { timeoutMs: 20_000 }).catch(() => null);
      const entry = mounted?.code === 0 ? (JSON.parse(mounted.stdout) as { filesystems?: Array<{ target?: string; used?: number | string }> }).filesystems?.[0] : undefined;
      const used = entry?.used === undefined ? NaN : Number(entry.used);
      images.push({ backingFile, mount: entry?.target ?? null, hostBytes: info.blocks * 512, filesystemBytes: Number.isFinite(used) ? used : null });
    }
    return images;
  } catch { return null; }
}
