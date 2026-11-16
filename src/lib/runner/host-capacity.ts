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
  reserveBytes: number;
  agingMs: number;
  maxWaitMs: number;
  maxMemoryFullAvg10: number;
  /** Each kind of work's hard ceiling: its kernel memory limit and the most it can ever count for (SJ-241). */
  profiles: Record<CapacityClass, number>;
  /**
   * What each kind of work typically needs (SJ-244). Admission counts running work by the larger of this and its own
   * measured peak, never more than its ceiling. The ledger learns it from finished jobs' peaks (SJ-246); this is the
   * configured size used until a kind of work has enough of them, equal to the profile unless configured smaller.
   */
  typical: Record<CapacityClass, number>;
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
  /** The last time its owner asked for admission; absent means its arrival. Ages nothing, only marks it waiting. */
  polledAt?: number;
  admittedAt: number | null;
  owner: CapacityOwner;
  /** Exact cgroup path on this host; absent until a command starts or for an external daemon. */
  cgroup: string | null;
  /** The most its cgroup was observed to have used while it ran (SJ-246); its retained peak once it finishes. */
  peakBytes?: number;
  /**
   * Memory the job uses outside its own cgroup, as its runner last measured it: an image build's BuildKit container,
   * whose memory is Docker's. Readings add it to the job's own, and its runner's samples raise `peakBytes`.
   */
  externalBytes?: number;
};

export type CapacityReading = {
  totalBytes: number;
  availableBytes: number;
  memoryFullAvg10: number | null;
  /** Unknown usage reserves the whole commitment; it is never silently read as a measured zero. */
  currentBytes: Readonly<Record<string, number | null>>;
  /**
   * The most the job has used so far: its cgroup's `memory.peak`, or more if its runner saw it hold more together with
   * the containers it measures. Unknown counts the job at its whole ceiling.
   */
  peakBytes: Readonly<Record<string, number | null>>;
};

export type CapacityDecision = {
  admitted: boolean;
  reason: string;
  /** What admitted work counts for: each job's typical size or measured peak, never above its ceiling. */
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

const measured = (value: number | null | undefined): value is number => value !== undefined && value !== null && Number.isFinite(value) && value >= 0;

/** The size a job is admitted at: its kind's typical need, or its own smaller explicit ceiling. */
export function admissionBytes(policy: CapacityPolicy, request: CapacityRequest): number {
  return Math.min(request.bytes, policy.typical[request.lane]);
}

/**
 * What a running job counts for (SJ-244): the larger of its kind's typical need and the most it has actually used,
 * never more than its ceiling. Ceilings overlap, so a burst past what was counted is met by the host's runtime order
 * of who gives way first, not by holding every ceiling free. Without both measurements it counts at its ceiling.
 */
export function countedBytes(policy: CapacityPolicy, request: CapacityRequest, reading: CapacityReading | null): number {
  const current = reading?.currentBytes[request.id];
  const peak = reading?.peakBytes[request.id];
  if (!measured(current) || !measured(peak)) return request.bytes;
  return Math.min(request.bytes, Math.max(admissionBytes(policy, request), peak, current));
}

/**
 * A queued request whose owner has not asked for two minutes is not waiting now (SJ-244): a preview polls once per
 * start attempt, and one that went quiet held the head of the queue, and every landing behind it, until its wait limit.
 * It keeps its age, so it is at the head again the next time it asks.
 */
export const CAPACITY_WAITER_FRESH_MS = 120_000;

/** Pure decisions make concurrent-arrival, pressure and starvation cases reproducible without loading the host. */
export function decideCapacity(policy: CapacityPolicy, requests: readonly CapacityRequest[], id: string, reading: CapacityReading | null, now: number): CapacityDecision {
  const request = requests.find((item) => item.id === id);
  const active = requests.filter((item) => item.admittedAt !== null);
  const queue = capacityOrder(requests, policy.agingMs);
  const head = queue.find((item) => item.id === id || now - (item.polledAt ?? item.queuedAt) < CAPACITY_WAITER_FRESH_MS);
  const counted = active.map((item) => ({ item, bytes: countedBytes(policy, item, reading) }));
  const activeBytes = counted.reduce((sum, { bytes }) => sum + bytes, 0);
  // Room each running job may still grow into before it exceeds what it is counted for; already in use is already
  // missing from available memory.
  const outstandingBytes = counted.reduce((sum, { item, bytes }) => {
    const current = reading?.currentBytes[item.id];
    return sum + Math.max(0, bytes - (measured(current) ? current : 0));
  }, 0);
  const result = (admitted: boolean, reason: string): CapacityDecision => ({
    admitted, reason, activeBytes, outstandingBytes,
    oldestWaitMs: queue.length ? Math.max(0, now - Math.min(...queue.map((item) => item.queuedAt))) : 0,
    head: head?.id ?? null,
  });
  if (!request) return result(false, "request is not registered");
  if (request.admittedAt !== null) return result(true, "already admitted; commitment retained until verified cleanup");
  if (now - request.queuedAt >= policy.maxWaitMs) return result(false, "capacity unavailable: wait limit reached");
  if (!reading || !Number.isFinite(reading.totalBytes) || !Number.isFinite(reading.availableBytes)
    || reading.totalBytes <= 0 || reading.availableBytes < 0 || reading.availableBytes > reading.totalBytes) {
    return result(false, "host memory reading unavailable");
  }
  if (reading.memoryFullAvg10 === null || !Number.isFinite(reading.memoryFullAvg10) || reading.memoryFullAvg10 < 0) {
    return result(false, "host memory pressure reading unavailable");
  }
  if (reading.memoryFullAvg10 > policy.maxMemoryFullAvg10) return result(false, "host memory reclaim pressure is over the configured limit");
  const freeMemory = reading.availableBytes - policy.reserveBytes - outstandingBytes;
  // Backfill is useful only if it leaves the earlier request's admission size available. Reserving just a CPU
  // preference, or letting every small request fit independently, can starve a large compiler forever.
  const need = admissionBytes(policy, request);
  const ahead = head && head.id !== id ? admissionBytes(policy, head) : 0;
  if (need + ahead > freeMemory) return result(false, ahead ? `preserving memory headroom for ${head!.job}` : "waiting for available memory and service headroom");
  return result(true, ahead ? "admitted with head-of-queue capacity preserved" : "memory capacity available");
}

/** A finished job's measured peak, kept in the ledger's own history (SJ-246). */
export type CapacitySample = { lane: CapacityClass; peakBytes: number };

/** How many of a kind of work's latest peaks are learned from, and how many it needs before they replace its configured size. */
export const CAPACITY_SAMPLE_WINDOW = 50;
export const CAPACITY_SAMPLE_MINIMUM = 10;
/** A smaller peak measured nothing: work such as a Docker build runs outside the cgroup the ledger reads. */
export const CAPACITY_SAMPLE_FLOOR_BYTES = 64 * 1024 ** 2;

export type LearnedTypical = Record<CapacityClass, { bytes: number; source: "learned" | "configured"; samples: number }>;

/**
 * Each kind of work's typical size (SJ-246): the 90th percentile of its latest measured peaks once it has enough of
 * them, never above its ceiling; until then, the host's configured size. `samples` are oldest first.
 */
export function learnTypical(policy: CapacityPolicy, samples: readonly CapacitySample[]): LearnedTypical {
  return Object.fromEntries(CAPACITY_CLASSES.map((lane) => {
    const peaks = samples.filter((sample) => sample.lane === lane && Number.isFinite(sample.peakBytes) && sample.peakBytes >= CAPACITY_SAMPLE_FLOOR_BYTES)
      .slice(-CAPACITY_SAMPLE_WINDOW).map((sample) => sample.peakBytes).toSorted((a, b) => a - b);
    if (peaks.length < CAPACITY_SAMPLE_MINIMUM) return [lane, { bytes: policy.typical[lane], source: "configured", samples: peaks.length }];
    const p90 = peaks[Math.ceil(peaks.length * 0.9) - 1]!;
    return [lane, { bytes: Math.min(policy.profiles[lane], p90), source: "learned", samples: peaks.length }];
  })) as LearnedTypical;
}

/** The policy admission uses: its typical sizes replaced by what the ledger has learned. */
export function withLearnedTypical(policy: CapacityPolicy, samples: readonly CapacitySample[]): CapacityPolicy {
  const learned = learnTypical(policy, samples);
  return { ...policy, typical: Object.fromEntries(CAPACITY_CLASSES.map((lane) => [lane, learned[lane].bytes])) as Record<CapacityClass, number> };
}

/**
 * The kernel's out-of-memory order when overlapping ceilings do meet (SJ-244): restartable previews give way first,
 * then cooperative agent and audit checks; landings, releases and image builds keep the kernel's default.
 */
export const CAPACITY_OOM_SCORE_ADJUST: Record<CapacityClass, number> = { preview: 500, agent: 300, audit: 300, landing: 0, release: 0, image: 0 };
