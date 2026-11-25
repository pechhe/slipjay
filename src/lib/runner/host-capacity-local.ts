import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import { readMachineConfig } from "../policy/machine-config.ts";
import { CAPACITY_CLASSES, type CapacityClass, type CapacityOwner, type CapacityPolicy, type CapacityReading, type CapacityRequest } from "./host-capacity.ts";
import type { CapacityObservation } from "./host-capacity-store.ts";

const GiB = 1024 ** 3;
export const capacityStorePath = () => join(homedir(), ".slipjay", "host-budget.sqlite");

const LARGE_HOST_BYTES = 96 * GiB;
/** What a kind of work is expected to hold, unconfigured, on any host. */
const BASELINE_TYPICAL: Record<CapacityClass, number> = { landing: 24 * GiB, release: 16 * GiB, image: 16 * GiB, agent: 16 * GiB, audit: 16 * GiB, preview: 4 * GiB };

/** Unconfigured ceilings: a host of 96 GiB or more can afford larger ones than a small host. */
export function defaultCapacityProfiles(hostMemoryBytes: number = totalmem()): Record<CapacityClass, number> {
  return hostMemoryBytes >= LARGE_HOST_BYTES
    ? { landing: 32 * GiB, release: 32 * GiB, image: 24 * GiB, agent: 32 * GiB, audit: 32 * GiB, preview: 4 * GiB }
    : { ...BASELINE_TYPICAL };
}

/** Unconfigured typical sizes: the baseline, never above the ceiling in force. */
export function defaultCapacityTypical(profiles: Record<CapacityClass, number> = defaultCapacityProfiles(), hostMemoryBytes: number = totalmem()): Record<CapacityClass, number> {
  const ceilings = profiles ?? defaultCapacityProfiles(hostMemoryBytes);
  return Object.fromEntries(CAPACITY_CLASSES.map((lane) => [lane, Math.min(BASELINE_TYPICAL[lane], ceilings[lane])])) as Record<CapacityClass, number>;
}

/** Explicit opt-in, host-owned policy. An invalid configuration is an error, not an unconfigured host. */
export function readCapacityPolicy(config: Record<string, unknown> = readMachineConfig(), options: { hostMemoryBytes?: number } = {}): CapacityPolicy | null {
  const hostMemoryBytes = options.hostMemoryBytes ?? totalmem();
  const raw = config.hostBudget;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("hostBudget must be an object");
  const input = raw as Record<string, unknown>;
  const allowed = ["mode", "reserveBytes", "agingMs", "maxWaitMs", "maxMemoryFullAvg10", "takeRoomAfterMs", "profiles", "typical"];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`unknown hostBudget setting ${key}`);
  if (input.mode !== "shadow" && input.mode !== "enforce") throw new Error("hostBudget.mode must be shadow or enforce");
  const positive = (value: unknown, fallback: number, name: string, minimum = 1) => {
    const result = value === undefined ? fallback : value;
    if (typeof result !== "number" || !Number.isFinite(result) || result < minimum || !Number.isSafeInteger(result)) throw new Error(`hostBudget.${name} must be an integer >= ${minimum}`);
    return result;
  };
  const sizes = (name: "profiles" | "typical", into: Record<CapacityClass, number>) => {
    const raw = input[name];
    if (raw === undefined) return into;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`hostBudget.${name} must be an object`);
    for (const [key, value] of Object.entries(raw)) {
      if (!CAPACITY_CLASSES.includes(key as CapacityClass)) throw new Error(`unknown hostBudget ${name === "profiles" ? "profile" : "typical size"} ${key}`);
      into[key as CapacityClass] = positive(value, 0, `${name}.${key}`);
    }
    return into;
  };
  const profiles = sizes("profiles", defaultCapacityProfiles(hostMemoryBytes));
  // Unconfigured, a kind of work counts at the baseline size, or its ceiling when that is lower. A ceiling the host set itself
  // is counted whole, as it always was: only the defaults this file raises are kept from raising what work typically holds.
  const configuredProfiles = input.profiles && typeof input.profiles === "object" ? Object.keys(input.profiles) : [];
  const baseline = defaultCapacityTypical(profiles, hostMemoryBytes);
  const typical = sizes("typical", Object.fromEntries(CAPACITY_CLASSES.map((lane) => [lane, configuredProfiles.includes(lane) ? profiles[lane] : baseline[lane]])) as Record<CapacityClass, number>);
  for (const lane of CAPACITY_CLASSES) {
    if (typical[lane] > profiles[lane]) throw new Error(`hostBudget.typical.${lane} must not exceed its profile`);
  }
  const policy: CapacityPolicy = {
    mode: input.mode, profiles, typical,
    reserveBytes: positive(input.reserveBytes, 8 * GiB, "reserveBytes", 0),
    agingMs: positive(input.agingMs, 60_000, "agingMs"),
    maxWaitMs: positive(input.maxWaitMs, 30 * 60_000, "maxWaitMs"),
    maxMemoryFullAvg10: positive(input.maxMemoryFullAvg10, 5, "maxMemoryFullAvg10", 0),
    // Five minutes, so a landing waits only briefly for a forecast before it takes room the host really has.
    takeRoomAfterMs: positive(input.takeRoomAfterMs, 5 * 60_000, "takeRoomAfterMs"),
  };
  return policy;
}

type FileReading = { state: "read"; text: string } | { state: "gone" | "unknown" };
const file = (path: string): FileReading => {
  try { return { state: "read", text: readFileSync(path, "utf8") }; }
  catch (error) { return { state: (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown" }; }
};

/** Linux /proc's comm can contain spaces and parentheses; fields after its last ')' have stable positions. */
export function processStart(stat: string): string | null {
  const end = stat.lastIndexOf(")");
  const value = end < 0 ? undefined : stat.slice(end + 1).trim().split(/\s+/)[19];
  return value && /^\d+$/.test(value) ? value : null;
}

export function currentCapacityOwner(): CapacityOwner {
  const stat = file(`/proc/${process.pid}/stat`);
  const boot = file("/proc/sys/kernel/random/boot_id");
  const start = stat.state === "read" ? processStart(stat.text) : null;
  if (!start || boot.state !== "read") throw new Error("host capacity requires readable Linux process and boot identities");
  return { kind: "process", pid: process.pid, start, boot: boot.text.trim() };
}

const validCgroup = (path: string) => path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\0");
const cgroupFile = (path: string, name: string): FileReading => validCgroup(path) ? file(`/sys/fs/cgroup${path}/${name}`) : { state: "unknown" };

/** The kernel's own memory cap on a cgroup: null for "max", an unreadable file or anything but a decimal byte count. */
export function capacityGroupMemoryMax(cgroup: string): number | null {
  const reading = cgroupFile(cgroup, "memory.max");
  const text = reading.state === "read" ? reading.text.trim() : "";
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
}

/** Read-only: a dead controller alone does not release descendants, and an unreadable counter never means empty. */
export function capacityControllerState(request: CapacityRequest): "alive" | "gone" | "unknown" {
  if (request.owner.kind === "holder") {
    const holder = file(request.owner.path);
    return holder.state === "read" ? holder.text.trim() === request.owner.identity ? "alive" : "gone" : holder.state;
  } else {
    const boot = file("/proc/sys/kernel/random/boot_id");
    const stat = file(`/proc/${request.owner.pid}/stat`);
    return boot.state !== "read" ? "unknown"
      : boot.text.trim() !== request.owner.boot ? "gone"
      : stat.state === "read" ? processStart(stat.text) === request.owner.start ? "alive" : "gone" : stat.state;
  }
}

export function capacityGroupEmpty(cgroup: string | null): boolean | null {
  if (!cgroup) return null;
  const events = cgroupFile(cgroup, "cgroup.events");
  if (events.state === "gone") return true;
  if (events.state !== "read") return null;
  const populated = /^populated ([01])$/m.exec(events.text)?.[1];
  return populated === "0" ? true : populated === "1" ? false : null;
}

export function capacityOwnerState(request: CapacityRequest): "alive" | "gone" | "unknown" {
  // A preview a landing stopped (SJ-275) leaves once its group is empty: its holder stays for its own controller's cleanup.
  if (request.yieldedFor) {
    const empty = capacityGroupEmpty(request.cgroup);
    return empty === true ? "gone" : empty === false ? "alive" : "unknown";
  }
  const owner = capacityControllerState(request);
  if (owner !== "gone") return owner;
  // Holder deletion is the machine verifier's cleanup certificate, after labelled Docker cleanup as well as cgroups.
  // Still check the recorded process cgroup: a scope with descendants must never lose its commitment.
  const empty = capacityGroupEmpty(request.cgroup);
  return empty === true ? "gone" : empty === false ? "alive" : "unknown";
}

export function readCapacityObservation(requests: readonly CapacityRequest[]): CapacityObservation {
  const owners: Record<string, "alive" | "gone" | "unknown"> = {};
  const currentBytes: Record<string, number | null> = {};
  const peakBytes: Record<string, number | null> = {};
  const giveWay: Record<string, number> = {};
  for (const request of requests) {
    owners[request.id] = capacityOwnerState(request);
    const declared = request.lane === "preview" ? capacityGiveWay(request) : null;
    if (declared !== null) giveWay[request.id] = declared;
    // What the job cannot give back (SJ-267), not `memory.current` or `memory.peak`: both count the file cache a
    // checkout or install leaves, which the kernel reclaims and MemAvailable already counts as available.
    const stat = request.cgroup ? cgroupFile(request.cgroup, "memory.stat") : null;
    const resident = stat?.state === "read" ? residentBytes(stat.text) : null;
    // Memory outside the job's cgroup that its runner measured counts as the job's own.
    const current = resident === null ? null : resident + (request.externalBytes ?? 0);
    currentBytes[request.id] = current;
    peakBytes[request.id] = current === null ? null : Math.max(current, request.residentPeakBytes ?? 0);
  }
  const memory = file("/proc/meminfo");
  const pressure = file("/proc/pressure/memory");
  const total = memory.state === "read" ? /^MemTotal:\s+(\d+) kB$/m.exec(memory.text)?.[1] : undefined;
  const available = memory.state === "read" ? /^MemAvailable:\s+(\d+) kB$/m.exec(memory.text)?.[1] : undefined;
  const full = pressure.state === "read" ? /^full avg10=([\d.]+)/m.exec(pressure.text)?.[1] : undefined;
  const reading: CapacityReading | null = total && available ? {
    totalBytes: Number(total) * 1024, availableBytes: Number(available) * 1024,
    memoryFullAvg10: full === undefined ? null : Number(full), currentBytes, peakBytes,
  } : null;
  return { owners, reading, giveWay };
}

/**
 * How readily a holder-owned preview gives way to a landing (SJ-275): a single digit its owner keeps beside its holder,
 * `<holder>.give-way`, lower first. The owner may change it while the preview runs (a review hold raises it).
 */
export function capacityGiveWay(request: CapacityRequest): number | null {
  if (request.owner.kind !== "holder") return null;
  const declared = file(`${request.owner.path}.give-way`);
  return declared.state === "read" && /^\d$/.test(declared.text.trim()) ? Number(declared.text.trim()) : null;
}


/**
 * From a cgroup's `memory.stat`, the memory the kernel cannot reclaim: anonymous and kernel memory, less the file cache
 * and reclaimable slab (dentries and inodes from unpacking layers) that it reclaims alike.
 */
export function residentBytes(stat: string): number | null {
  const value = (name: string) => { const match = new RegExp(`^${name} (\\d+)$`, "m").exec(stat); return match ? Number(match[1]) : null; };
  const anon = value("anon"), kernel = value("kernel"), reclaimable = value("slab_reclaimable");
  return anon === null || kernel === null || reclaimable === null ? null : anon + kernel - reclaimable;
}

/**
 * A running Docker container's resident memory (SJ-246 follow-up): BuildKit runs an image build in its own long-lived
 * container, so the build's memory is not in the job's cgroup. File cache is left out: the container's own limit bounds
 * it and the kernel reclaims it, so counting it would count every build at that limit. Unknown is null.
 */
export async function readContainerResidentBytes(name: string): Promise<number | null> {
  // Asynchronous, so a hung Docker daemon never holds up the job's own result.
  const pid = await promisify(execFile)("docker", ["inspect", "--format", "{{.State.Pid}}", name], { encoding: "utf8", timeout: 10_000 })
    .then(({ stdout }) => stdout.trim(), () => "");
  if (!/^[1-9]\d*$/.test(pid)) return null;
  const membership = file(`/proc/${pid}/cgroup`);
  const cgroup = membership.state === "read" ? /^0::(\/.*)$/m.exec(membership.text)?.[1] : undefined;
  const stat = cgroup ? cgroupFile(cgroup, "memory.stat") : null;
  return stat?.state === "read" ? residentBytes(stat.text) : null;
}

/** Capture before stopping a slice: collected cgroups cannot supply retrospective counters. Missing stays unknown. */
export function readCapacityResources(cgroup: string | null) {
  const read = (name: string) => cgroup ? cgroupFile(cgroup, name) : null;
  const numeric = (name: string) => {
    const value = read(name);
    return value?.state === "read" && /^\d+$/.test(value.text.trim()) ? Number(value.text.trim()) : null;
  };
  const counters = (name: string) => {
    const value = read(name);
    return value?.state === "read" ? Object.fromEntries(value.text.trim().split("\n").flatMap((line) => {
      const match = /^(\w+) (\d+)$/.exec(line);
      return match ? [[match[1]!, Number(match[2])]] : [];
    })) : null;
  };
  const pressure = read("memory.pressure");
  const stat = read("memory.stat");
  // `memoryPeakBytes` stays as the kernel's evidence; only `memoryResidentBytes` (SJ-267) sizes later work.
  return { memoryCurrentBytes: numeric("memory.current"), memoryPeakBytes: numeric("memory.peak"),
    memoryResidentBytes: stat?.state === "read" ? residentBytes(stat.text) : null,
    memoryEvents: counters("memory.events"), cpu: counters("cpu.stat"),
    memoryPressure: pressure?.state === "read" ? pressure.text.trim() : null };
}
