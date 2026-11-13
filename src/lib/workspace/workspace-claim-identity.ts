import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import { run } from "../infra/workspace-jj.ts";

/** Liveness diagnostics only: identity loss never authorizes claim release. */
export type ClaimController = { platform: string; pid: number; boot: string; start: string };
export async function claimController(pid: number = process.pid): Promise<ClaimController | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform() === "linux") {
      const [boot, stat] = await Promise.all([readFile("/proc/sys/kernel/random/boot_id", "utf8"), readFile(`/proc/${pid}/stat`, "utf8")]);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (!fields[19] || fields[0] === "Z") return null;
      return { platform: "linux", pid, boot: boot.trim(), start: fields[19] };
    }
    if (platform() === "darwin") {
      const [boot, start] = await Promise.all([run("sysctl", ["-n", "kern.boottime"]), run("ps", ["-p", String(pid), "-o", "lstart="])]);
      if (boot.code || start.code || !boot.stdout.trim() || !start.stdout.trim()) return null;
      return { platform: "darwin", pid, boot: boot.stdout.trim(), start: start.stdout.trim() };
    }
  } catch { /* Unreadable means recovery-required, never dead custody. */ }
  return null;
}
export function sameClaimController(a: ClaimController | null, b: ClaimController | null): boolean {
  return Boolean(a && b && a.pid === b.pid && a.platform === b.platform && a.boot === b.boot && a.start === b.start);
}
