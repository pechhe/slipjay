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
  /**
   * How long a landing or release check waits before it takes room on what the host really has. It then needs
   * its own admission size within available memory less the reserve, ignoring what running jobs may still grow into:
   * that room is a forecast, and the kernel's out-of-memory order is what protects the host from a burst.
   */
  takeRoomAfterMs: number;
  /**
   * Each kind of work's ceiling: the most one job can ever count for, and a command job's kernel memory limit (SJ-241).
   * A machine attempt keeps its machine's own limit, shared by its gate places, so it can use more than it counts for.
   */
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
  /**
   * The most unreclaimable memory it was seen to hold while it ran (SJ-246, SJ-267): anonymous and kernel memory, never
   * file cache, read from its cgroup's `memory.stat` while it runs. Its retained peak once it finishes. A ledger request
   * from before SJ-267 carried a `peakBytes` from `memory.peak` instead, which the store drops.
   */
  residentPeakBytes?: number;
  /**
   * How it grew: `[ms since admission, resident peak bytes]` each time its peak was seen a step higher. Kept with its
   * finished peak, so the ledger shows how early large work declares itself; admission does not read it.
   */
  growth?: ReadonlyArray<readonly [number, number]>;
  /**
   * Memory the job uses outside its own cgroup, as its runner last measured it: an image build's BuildKit container,
   * whose memory is Docker's. Readings add it to the job's own, and its runner's samples raise `residentPeakBytes`.
   */
  externalBytes?: number;
};

export type CapacityReading = {
  totalBytes: number;
  availableBytes: number;
  memoryFullAvg10: number | null;
  /**
   * The unreclaimable memory each job holds now (SJ-267): its cgroup's anonymous and kernel memory, not the file cache
   * the kernel gives back under pressure, plus what its runner measured outside its cgroup. Unknown usage reserves the
   * whole commitment; it is never silently read as a measured zero.
   */
  currentBytes: Readonly<Record<string, number | null>>;
  /**
   * The most unreclaimable memory the job has been seen to hold: the larger of its current reading and its recorded
   * `residentPeakBytes`. Unknown counts the job at its whole ceiling.
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

/**
 * Arrival plus a bounded initial preference: old background work eventually precedes newer landings. A preview is
 * the exception (SJ-267): it is a server that never finishes, so one admitted ahead of a landing holds its memory for
 * hours. A queued landing therefore goes ahead of every queued preview, whatever either's age: it moves to just before
 * the first preview in the aged order, which also takes it ahead of any other work aged in between, for as long as that
 * preview is queued, even one that has stopped asking. Everything else keeps its aged order, previews still ahead of
 * newer background work.
 */
export function capacityOrder(requests: readonly CapacityRequest[], agingMs: number): CapacityRequest[] {
  const aged = requests.filter((request) => request.admittedAt === null).toSorted((a, b) =>
    (a.queuedAt + priority[a.lane] * agingMs) - (b.queuedAt + priority[b.lane] * agingMs)
    || a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
  const order: CapacityRequest[] = [];
  for (const request of aged) {
    const preview = request.lane === "landing" ? order.findIndex((item) => item.lane === "preview") : -1;
    if (preview < 0) order.push(request);
    else order.splice(preview, 0, request);
  }
  return order;
}

const measured = (value: number | null | undefined): value is number => value !== undefined && value !== null && Number.isFinite(value) && value >= 0;

/** The size a job is admitted at: its kind's typical need, or its own smaller explicit ceiling. */
export function admissionBytes(policy: CapacityPolicy, request: CapacityRequest): number {
  return Math.min(request.bytes, policy.typical[request.lane]);
}

/** The kinds of work whose arrival is a commit's own progress: late, they take room on real memory. */
const TAKE_ROOM_CLASSES: ReadonlyArray<CapacityClass> = ["landing", "release"];

/**
 * What a running job counts for (SJ-244): the larger of its kind's typical need and the most unreclaimable memory it has
 * held (SJ-267), never more than its ceiling. Ceilings overlap, so a burst past what was counted is met by the host's runtime order
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
  if (!reading || !Number.isFinite(reading.totalBytes) || !Number.isFinite(reading.availableBytes)
    || reading.totalBytes <= 0 || reading.availableBytes < 0 || reading.availableBytes > reading.totalBytes) {
    return result(false, "host memory reading unavailable");
  }
  if (reading.memoryFullAvg10 === null || !Number.isFinite(reading.memoryFullAvg10) || reading.memoryFullAvg10 < 0) {
    return result(false, "host memory pressure reading unavailable");
  }
  const need = admissionBytes(policy, request);
  const waitedMs = Math.max(0, now - request.queuedAt);
  const pressureOverLimit = reading.memoryFullAvg10 > policy.maxMemoryFullAvg10;
  const realRoom = !pressureOverLimit && reading.availableBytes - policy.reserveBytes >= need;
  // A landing or release check has waited long enough to take room on real memory alone. Room running jobs may
  // still grow into is a forecast, not held memory: on 18 Nov three previews' growth room kept a landing out of 46 GB
  // the host really had. The kernel's order of who gives way first meets an overlapping burst.
  if (TAKE_ROOM_CLASSES.includes(request.lane) && realRoom
    && (waitedMs >= policy.takeRoomAfterMs || waitedMs >= policy.maxWaitMs)) {
    const waited = waitedMs >= 60_000 ? `${Math.floor(waitedMs / 60_000)} min` : `${Math.floor(waitedMs / 1000)} s`;
    return result(true, `admitted after ${waited}: real memory holds it; others' growth room not reserved`);
  }
  // Out of time, and for a landing or release check that means the host is genuinely short: no room, or over pressure.
  if (waitedMs >= policy.maxWaitMs) return result(false, "capacity unavailable: wait limit reached");
  if (pressureOverLimit) return result(false, "host memory reclaim pressure is over the configured limit");
  const freeMemory = reading.availableBytes - policy.reserveBytes - outstandingBytes;
  // Backfill is useful only if it leaves the earlier request's admission size available. Reserving just a CPU
  // preference, or letting every small request fit independently, can starve a large compiler forever.
  const ahead = head && head.id !== id ? admissionBytes(policy, head) : 0;
  if (need + ahead > freeMemory) return result(false, ahead ? `preserving memory headroom for ${head!.job}` : "waiting for available memory and service headroom");
  return result(true, ahead ? "admitted with head-of-queue capacity preserved" : "memory capacity available");
}

/** A finished job's measured peak of unreclaimable memory, kept in the ledger's own history (SJ-246, SJ-267). */
export type CapacitySample = { lane: CapacityClass; peakBytes: number };

/** How a request stopped waiting: admitted, out of time, or its owner ended first. */
export type CapacityWaitOutcome = "admitted" | "wait-limit" | "abandoned";

/** One request's wait, recorded in the ledger when it ended, so a day of waits outlives the per-poll decisions. */
export type CapacityWait = { lane: CapacityClass; job: string; queuedAt: number; endedAt: number; outcome: CapacityWaitOutcome };

/** How long one kind of work waited: every wait that ended in the window, in seconds, and those that ran out of time. */
export type CapacityWaitSummary = { count: number; p50: number; p90: number; max: number; waitLimit: number };

/** A window's waits: `value` is the number a Champion metric reads, the largest p90 across kinds of work. */
export type CapacityWaits = { value: number; lanes: Record<string, CapacityWaitSummary> };

/** How long waits are kept: long enough to answer what waited yesterday, short enough to stay small. */
export const CAPACITY_WAIT_RETENTION_MS = 7 * 24 * 3_600_000;
export const CAPACITY_WAIT_DEFAULT_HOURS = 24;

const waitSeconds = (ms: number) => Math.round(Math.max(0, ms) / 100) / 10;

/**
 * Each kind of work's waits over a window: how many ended, the median, the 90th percentile and the longest in
 * seconds, and how many hit the wait limit. Kinds with no waits are left out, so `lanes` names only work that waited.
 */
export function summariseCapacityWaits(waits: readonly CapacityWait[]): CapacityWaits {
  const lanes = [...new Set(waits.map((wait) => wait.lane))]
    .sort((a, b) => CAPACITY_CLASSES.indexOf(a) - CAPACITY_CLASSES.indexOf(b) || a.localeCompare(b));
  const summaries = Object.fromEntries(lanes.map((lane): [string, CapacityWaitSummary] => {
    const mine = waits.filter((wait) => wait.lane === lane);
    const seconds = mine.map((wait) => waitSeconds(wait.endedAt - wait.queuedAt)).toSorted((a, b) => a - b);
    return [lane, {
      count: seconds.length, p50: seconds[Math.ceil(seconds.length * 0.5) - 1]!, p90: seconds[Math.ceil(seconds.length * 0.9) - 1]!,
      max: seconds.at(-1)!, waitLimit: mine.filter((wait) => wait.outcome === "wait-limit").length,
    }];
  }));
  return { value: Math.max(0, ...Object.values(summaries).map((summary) => summary.p90)), lanes: summaries };
}

/** What the waits report says to a person: one line per kind of work that waited, and the number a metric reads. */
export function formatCapacityWaits(waits: CapacityWaits, hours: number): string {
  const lanes = Object.entries(waits.lanes);
  if (!lanes.length) return `Waits ending in the last ${hours}h: none`;
  const lines = [`Waits ending in the last ${hours}h: ${lanes.reduce((sum, [, summary]) => sum + summary.count, 0)} ended`];
  for (const [lane, summary] of lanes) {
    lines.push(`${lane}: ${summary.count} ended, p50 ${summary.p50}s, p90 ${summary.p90}s, max ${summary.max}s, ${summary.waitLimit} at the wait limit`);
  }
  const [longest] = lanes.filter(([, summary]) => summary.p90 === waits.value);
  lines.push(`Longest p90: ${longest![0]} ${waits.value}s`);
  return lines.join("\n");
}

/**
 * How many of a kind of work's latest peaks are learned from, and how many it needs before they replace its configured
 * size. Ten, so their 90th percentile is never the single largest: on 18 Nov one 26.7 GiB landing among five sized every
 * landing at the 24 GiB ceiling and kept the next one waiting its full 30 minutes beside three previews.
 */
export const CAPACITY_SAMPLE_WINDOW = 50;
export const CAPACITY_SAMPLE_MINIMUM = 10;
/** A smaller peak measured nothing: work such as a Docker build runs outside the cgroup the ledger reads. */
export const CAPACITY_SAMPLE_FLOOR_BYTES = 64 * 1024 ** 2;
/** A running job's growth is noted each time its peak is this much higher than the last note: at most ~100 per job. */
export const CAPACITY_GROWTH_STEP_BYTES = 256 * 1024 ** 2;

export type LearnedTypical = Record<CapacityClass, { bytes: number; source: "learned" | "configured"; samples: number }>;

/**
 * Each kind of work's typical size (SJ-246): the 90th percentile of its latest measured peaks once it has enough of
 * them (CAPACITY_SAMPLE_MINIMUM), never above its ceiling; until then, the host's configured size, so one unusual run
 * never sizes a kind of work by itself. `samples` are oldest first.
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
