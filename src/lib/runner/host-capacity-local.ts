import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readMachineConfig } from "../policy/machine-config.ts";
import { CAPACITY_CLASSES, type CapacityOwner, type CapacityPolicy, type CapacityReading, type CapacityRequest } from "./host-capacity.ts";
import type { CapacityObservation } from "./host-capacity-store.ts";

const GiB = 1024 ** 3;
export const capacityStorePath = () => join(homedir(), ".slipjay", "host-budget.sqlite");

/** Explicit opt-in, host-owned policy. An invalid configuration is an error, not an unconfigured host. */
export function readCapacityPolicy(config: Record<string, unknown> = readMachineConfig()): CapacityPolicy | null {
  const raw = config.hostBudget;
  if (raw === undefined) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("hostBudget must be an object");
  const input = raw as Record<string, unknown>;
  const allowed = ["mode", "budgetBytes", "reserveBytes", "agingMs", "maxWaitMs", "maxMemoryFullAvg10", "profiles"];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`unknown hostBudget setting ${key}`);
  if (input.mode !== "shadow" && input.mode !== "enforce") throw new Error("hostBudget.mode must be shadow or enforce");
  const positive = (value: unknown, fallback: number, name: string, minimum = 1) => {
    const result = value === undefined ? fallback : value;
    if (typeof result !== "number" || !Number.isFinite(result) || result < minimum || !Number.isSafeInteger(result)) throw new Error(`hostBudget.${name} must be an integer >= ${minimum}`);
    return result;
  };
  const profiles = { landing: 24 * GiB, release: 16 * GiB, image: 16 * GiB, agent: 16 * GiB, audit: 16 * GiB, preview: 4 * GiB };
  if (input.profiles !== undefined) {
    if (!input.profiles || typeof input.profiles !== "object" || Array.isArray(input.profiles)) throw new Error("hostBudget.profiles must be an object");
    for (const [key, value] of Object.entries(input.profiles)) {
      if (!CAPACITY_CLASSES.includes(key as typeof CAPACITY_CLASSES[number])) throw new Error(`unknown hostBudget profile ${key}`);
      profiles[key as keyof typeof profiles] = positive(value, 0, `profiles.${key}`);
    }
  }
  const policy: CapacityPolicy = {
    mode: input.mode, profiles,
    budgetBytes: positive(input.budgetBytes, 48 * GiB, "budgetBytes"),
    reserveBytes: positive(input.reserveBytes, 8 * GiB, "reserveBytes", 0),
    agingMs: positive(input.agingMs, 60_000, "agingMs"),
    maxWaitMs: positive(input.maxWaitMs, 30 * 60_000, "maxWaitMs"),
    maxMemoryFullAvg10: positive(input.maxMemoryFullAvg10, 5, "maxMemoryFullAvg10", 0),
  };
  for (const bytes of Object.values(profiles)) if (bytes > policy.budgetBytes) throw new Error("hostBudget profiles must fit within budgetBytes");
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
  for (const request of requests) {
    owners[request.id] = capacityOwnerState(request);
    const current = request.cgroup ? cgroupFile(request.cgroup, "memory.current") : null;
    const text = current?.state === "read" ? current.text.trim() : null;
    currentBytes[request.id] = text && /^\d+$/.test(text) ? Number(text) : null;
  }
  const memory = file("/proc/meminfo");
  const pressure = file("/proc/pressure/memory");
  const total = memory.state === "read" ? /^MemTotal:\s+(\d+) kB$/m.exec(memory.text)?.[1] : undefined;
  const available = memory.state === "read" ? /^MemAvailable:\s+(\d+) kB$/m.exec(memory.text)?.[1] : undefined;
  const full = pressure.state === "read" ? /^full avg10=([\d.]+)/m.exec(pressure.text)?.[1] : undefined;
  const reading: CapacityReading | null = total && available ? {
    totalBytes: Number(total) * 1024, availableBytes: Number(available) * 1024,
    memoryFullAvg10: full === undefined ? null : Number(full), currentBytes,
  } : null;
  return { owners, reading };
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
  return { memoryCurrentBytes: numeric("memory.current"), memoryPeakBytes: numeric("memory.peak"),
    memoryEvents: counters("memory.events"), cpu: counters("cpu.stat"),
    memoryPressure: pressure?.state === "read" ? pressure.text.trim() : null };
}
