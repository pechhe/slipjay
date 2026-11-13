/** One host's admission policy; execution and observation stay at the existing host-budget boundary (SJ-241). */
export const CAPACITY_CLASSES = ["landing", "release", "image", "agent", "audit", "preview"] as const;
export type CapacityClass = typeof CAPACITY_CLASSES[number];
export type CapacityMode = "shadow" | "enforce";

/** Explicit whole-command limits use systemd's binary units and exact kernel page-sized bytes. */
export function parseCapacityMemoryMax(value: string): number {
  const match = /^([1-9]\d*)([KMG]?)(?:i?B)?$/i.exec(value);
  const bytes = match ? Number(match[1]) * 1024 ** (match[2] ? "KMG".indexOf(match[2].toUpperCase()) + 1 : 0) : NaN;
  if (!Number.isSafeInteger(bytes) || bytes < 4096 || bytes % 4096 !== 0) {
    throw new Error("--memory-max must be a positive page-aligned byte count or binary K/M/G size");
  }
  return bytes;
}

/** A smaller demand is a caller-selected hard bound, never an estimate inferred from command text or usage. */
export function agentMemoryCommitment(policy: CapacityPolicy, lane: CapacityClass, memoryMaxBytes?: number): number {
  if (memoryMaxBytes === undefined) return policy.profiles[lane];
  if (lane !== "agent" || !Number.isSafeInteger(memoryMaxBytes) || memoryMaxBytes < 4096
    || memoryMaxBytes % 4096 !== 0 || memoryMaxBytes > policy.profiles.agent) {
    throw new Error("explicit --memory-max requires the agent lane and a page-aligned bound within its configured profile");
  }
  return memoryMaxBytes;
}

export type CapacityPolicy = {
  mode: CapacityMode;
  /** A bound on declared commitments, not a claim that arbitrary host processes are bounded. */
  budgetBytes: number;
  reserveBytes: number;
  agingMs: number;
  maxWaitMs: number;
  maxMemoryFullAvg10: number;
  profiles: Record<CapacityClass, number>;
};

export type CapacityOwner =
  | { kind: "holder"; path: string; identity: string }
  | { kind: "process"; pid: number; start: string; boot: string };

export function sameCapacityOwner(a: CapacityOwner, b: CapacityOwner): boolean {
  return a.kind === "holder" ? b.kind === "holder" && a.path === b.path && a.identity === b.identity
    : b.kind === "process" && a.pid === b.pid && a.start === b.start && a.boot === b.boot;
}

export type CapacityRequest = {
  id: string;
  job: string;
  lane: CapacityClass;
  bytes: number;
  queuedAt: number;
  admittedAt: number | null;
  owner: CapacityOwner;
  /** Exact cgroup path on this host; absent until a command starts or for an external daemon. */
  cgroup: string | null;
};

export type CapacityReading = {
  totalBytes: number;
  availableBytes: number;
  memoryFullAvg10: number | null;
  /** Unknown usage reserves the whole commitment; it is never silently read as a measured zero. */
  currentBytes: Readonly<Record<string, number | null>>;
};

export type CapacityDecision = {
  admitted: boolean;
  reason: string;
  activeBytes: number;
  outstandingBytes: number;
  oldestWaitMs: number;
  head: string | null;
};

const priority: Record<CapacityClass, number> = { landing: 0, release: 1, image: 1, agent: 1, audit: 2, preview: 2 };

/** Arrival plus a bounded initial preference: old background work eventually precedes every newer landing. */
export function capacityOrder(requests: readonly CapacityRequest[], agingMs: number): CapacityRequest[] {
  return requests.filter((request) => request.admittedAt === null).toSorted((a, b) =>
    (a.queuedAt + priority[a.lane] * agingMs) - (b.queuedAt + priority[b.lane] * agingMs)
    || a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
}

/** Pure decisions make concurrent-arrival, pressure and starvation cases reproducible without loading the host. */
export function decideCapacity(policy: CapacityPolicy, requests: readonly CapacityRequest[], id: string, reading: CapacityReading | null, now: number): CapacityDecision {
  const request = requests.find((item) => item.id === id);
  const active = requests.filter((item) => item.admittedAt !== null);
  const queue = capacityOrder(requests, policy.agingMs);
  const head = queue[0];
  const activeBytes = active.reduce((sum, item) => sum + item.bytes, 0);
  const outstandingBytes = active.reduce((sum, item) => {
    const current = reading?.currentBytes[item.id];
    return sum + Math.max(0, item.bytes - (current !== undefined && current !== null && Number.isFinite(current) && current >= 0 ? current : 0));
  }, 0);
  const result = (admitted: boolean, reason: string): CapacityDecision => ({
    admitted, reason, activeBytes, outstandingBytes,
    oldestWaitMs: queue.length ? Math.max(0, now - Math.min(...queue.map((item) => item.queuedAt))) : 0,
    head: head?.id ?? null,
  });
  if (!request) return result(false, "request is not registered");
  if (request.admittedAt !== null) return result(true, "already admitted; commitment retained until verified cleanup");
  if (request.bytes > policy.budgetBytes) return result(false, "request exceeds the configured host commitment budget");
  if (now - request.queuedAt >= policy.maxWaitMs) return result(false, "capacity unavailable: wait limit reached");
  if (!reading || !Number.isFinite(reading.totalBytes) || !Number.isFinite(reading.availableBytes)
    || reading.totalBytes <= 0 || reading.availableBytes < 0 || reading.availableBytes > reading.totalBytes) {
    return result(false, "host memory reading unavailable");
  }
  if (reading.memoryFullAvg10 === null || !Number.isFinite(reading.memoryFullAvg10) || reading.memoryFullAvg10 < 0) {
    return result(false, "host memory pressure reading unavailable");
  }
  if (reading.memoryFullAvg10 > policy.maxMemoryFullAvg10) return result(false, "host memory reclaim pressure is over the configured limit");
  const freeCommitments = policy.budgetBytes - activeBytes;
  const freeMemory = reading.availableBytes - policy.reserveBytes - outstandingBytes;
  // Backfill is useful only if it leaves the earlier request's entire commitment available. Reserving just a CPU
  // preference, or letting every small request fit independently, can starve a large compiler forever.
  const ahead = head && head.id !== id ? head.bytes : 0;
  if (request.bytes + ahead > freeCommitments) return result(false, ahead ? `preserving commitment capacity for ${head!.job}` : "active commitments fill the host budget");
  if (request.bytes + ahead > freeMemory) return result(false, ahead ? `preserving memory headroom for ${head!.job}` : "waiting for available memory and service headroom");
  return result(true, ahead ? "admitted with head-of-queue capacity preserved" : "memory and commitment capacity available");
}
