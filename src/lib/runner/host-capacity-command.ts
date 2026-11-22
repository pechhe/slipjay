import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { capacityControllerState, capacityGroupEmpty, capacityGroupMemoryMax, capacityStorePath, currentCapacityOwner, readCapacityObservation, readCapacityPolicy, readCapacityResources, readContainerResidentBytes } from "./host-capacity-local.ts";
import { openCapacityStore, readCapacityWaits } from "./host-capacity-store.ts";
import { memoryCommitment, CAPACITY_OOM_SCORE_ADJUST, CAPACITY_WAIT_RETENTION_MS, summariseCapacityWaits, type CapacityClass, type CapacityRequest, type CapacityWaits } from "./host-capacity.ts";
import { SYSTEMD_SLICE_ENV } from "./runner-contract.ts";

/**
 * A process owner is capped by runWithHostCapacity. A preview holder may claim less than its profile only when the kernel
 * already caps its exact cgroup at or below the claim, so the ledger never promises memory the cgroup could exceed.
 */
export function requireCappedPreview(request: Pick<CapacityRequest, "lane" | "owner" | "cgroup">, memoryMaxBytes: number, readMemoryMax: (cgroup: string) => number | null = capacityGroupMemoryMax): void {
  if (request.owner.kind === "process") return;
  const limit = request.lane === "preview" && request.owner.kind === "holder" && request.cgroup ? readMemoryMax(request.cgroup) : null;
  if (limit === null || limit > memoryMaxBytes) {
    throw new Error(request.lane === "preview" && request.owner.kind === "holder"
      ? "a smaller preview commitment needs its cgroup's memory.max at or below it"
      : "smaller commitments require a capped command owner");
  }
}

/** One transaction per poll; the caller owns its wait and can keep it outside verification deadlines. */
export function pollHostCapacity(request: Omit<CapacityRequest, "bytes" | "queuedAt" | "admittedAt">, now = Date.now(), memoryMaxBytes?: number, expectedBytes?: number, readMemoryMax?: (cgroup: string) => number | null) {
  const policy = readCapacityPolicy();
  if (!policy) {
    if (memoryMaxBytes !== undefined) throw new Error("explicit --memory-max requires configured host capacity");
    return { configured: false as const };
  }
  if (memoryMaxBytes !== undefined) requireCappedPreview(request, memoryMaxBytes, readMemoryMax);
  const bytes = memoryCommitment(policy, request.lane, memoryMaxBytes);
  if (expectedBytes !== undefined && bytes !== expectedBytes) throw new Error("host capacity commitment changed while waiting; retry the command");
  recoverHostCapacity();
  const store = openCapacityStore(capacityStorePath());
  let receipt: ReturnType<typeof store.poll>;
  try {
    receipt = store.poll({ ...request, bytes, queuedAt: now, admittedAt: null }, policy, readCapacityObservation, now);
  } finally { store.close(); }
  if (receipt.request.admittedAt === now && receipt.request.owner.kind === "holder") startCapacitySampler(receipt.request);
  for (const preview of receipt.yields ?? []) stopYieldedPreview(preview);
  return { configured: true as const, policy, ...receipt };
}

/** A preview's unit is the last part of the cgroup it registered: a slice, scope or service of this user's manager. */
const YIELD_UNIT = /^[\w@.-]+\.(slice|scope|service)$/;

/**
 * Stop a preview a landing needs the room of (SJ-275), outside the ledger's transaction so a slow stop never holds
 * admission. Its owner is told why first, in `<holder>.yielded` beside its holder, so the end it records names the
 * landing. Not waited on: the landing's next poll sees the memory back, and repeats the stop while the group is populated.
 */
export function stopYieldedPreview(preview: CapacityRequest, stop: (unit: string) => unknown = (unit) => systemctl(["stop", "--no-block", unit])) {
  const unit = preview.cgroup?.split("/").at(-1) ?? "";
  if (!preview.yieldedFor || !preview.cgroup?.includes("/user@") || !YIELD_UNIT.test(unit)) return;
  if (preview.owner.kind === "holder") {
    try {
      writeFileSync(`${preview.owner.path}.yielded`, `${JSON.stringify({ requestId: preview.id, ...preview.yieldedFor })}\n`, { mode: 0o600 });
    } catch { /* The stop matters more than its explanation; the ledger keeps the record either way. */ }
  }
  try { stop(unit); } catch { /* Retried by the landing's next poll while the group stays populated. */ }
}

/** How often a running job's unreclaimable memory is read for its peak (SJ-267). */
export const CAPACITY_SAMPLE_EVERY_MS = 5000;

/**
 * Holder-owned work, a machine attempt, has no SlipJay process on this host while it runs, so its admission starts one
 * to sample it (SJ-267): a user unit outside the job's slice, so it never counts itself, that ends when the job leaves
 * the ledger. A command job samples itself from its own runner. A sampler that cannot start loses only measurements.
 */
function startCapacitySampler(request: CapacityRequest) {
  if (capacityGroupEmpty(request.cgroup) === null) return;
  spawnSync("systemd-run", ["--user", "--quiet", "--collect", `--unit=slipjay-capacity-sample-${request.id}`, "--nice=10",
    `--setenv=HOME=${homedir()}`, "--", process.execPath, fileURLToPath(new URL("../../launcher/workspace.ts", import.meta.url)),
    "host-budget", "sample", request.id], { stdio: "ignore", timeout: 15_000 });
}

/** The sampler's loop: one sample every few seconds until the job has left the ledger or its owner ended. */
export async function sampleHostCapacity(id: string, everyMs = CAPACITY_SAMPLE_EVERY_MS, signal?: AbortSignal) {
  const store = openCapacityStore(capacityStorePath());
  try {
    while (store.sample(id, readCapacityObservation)) await pause(everyMs, undefined, { signal });
  } finally { store.close(); }
}

export function hostCapacityStatus() {
  const policy = readCapacityPolicy();
  if (!policy) return { configured: false as const };
  const store = openCapacityStore(capacityStorePath());
  try {
    const requests = store.requests();
    return { configured: true as const, policy, typical: store.typical(policy), requests, observation: readCapacityObservation(requests), history: store.history(),
      yields: store.yields(Date.now() - CAPACITY_WAIT_RETENTION_MS) };
  } finally { store.close(); }
}

/** How long each kind of work waited over the last `hours`, read from the ledger without waiting for room or writing. */
export function hostCapacityWaits(hours: number, now = Date.now()): CapacityWaits {
  return summariseCapacityWaits(readCapacityWaits(capacityStorePath(), now - hours * 3_600_000));
}

const systemctl = (args: string[]) => {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 15_000, maxBuffer: 128 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`host capacity systemd control failed: ${result.stderr.trim() || result.error?.message || result.status}`);
  return result.stdout.trim();
};

/** Recover only exact wrapper scopes whose recorded controller has ended. Holder recovery stays with its verifier. */
export function recoverHostCapacity() {
  if (!readCapacityPolicy()) return { configured: false as const, recovered: 0 };
  const store = openCapacityStore(capacityStorePath());
  try {
    for (const request of store.requests()) {
      if (request.owner.kind !== "process" || capacityControllerState(request) !== "gone" || capacityGroupEmpty(request.cgroup) === null) continue;
      const unit = `app-slipjaybudget-${request.id}.slice`;
      if (!/^[a-f0-9]{32}$/.test(request.id) || !request.cgroup?.endsWith(`/${unit}`)) continue;
      systemctl(["stop", unit]);
      if (capacityGroupEmpty(request.cgroup) === true) systemctl(["revert", unit]);
    }
    return { configured: true as const, recovered: store.recover(readCapacityObservation) };
  } finally { store.close(); }
}

/** Command boundary for cooperative agent checks and exclusive image-build lifetimes. Interactive turns stay out. */
export async function runWithHostCapacity(input: {
  lane: CapacityClass;
  job: string;
  command: string[];
  memoryMaxBytes?: number;
  /** Docker containers whose resident memory is the job's own, such as the BuildKit container an image build runs in. */
  measureContainers?: readonly string[];
  /** How often the job, and those containers, are measured while it runs. */
  measureEveryMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onWait?: (line: string) => void;
}): Promise<number> {
  const policy = readCapacityPolicy();
  const execute = (command: string[], env = input.env ?? process.env) => new Promise<number>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd: input.cwd, env, stdio: "inherit", signal: input.signal });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (!policy) {
    if (input.memoryMaxBytes !== undefined) throw new Error("explicit --memory-max requires configured host capacity");
    return execute(input.command);
  }
  // `run --memory-max` stays the agent lane's: only a preview holder that caps its own group claims less on the preview lane.
  if (input.memoryMaxBytes !== undefined && input.lane !== "agent") throw new Error("explicit --memory-max requires the agent lane and a page-aligned bound within its configured profile");
  const bytes = memoryCommitment(policy, input.lane, input.memoryMaxBytes);
  if (process.platform !== "linux") throw new Error("configured host capacity requires Linux cgroup accounting");
  recoverHostCapacity();
  const id = randomUUID().replaceAll("-", "");
  const slice = `app-slipjaybudget-${id}.slice`;
  systemctl(["start", slice]);
  const cgroup = systemctl(["show", slice, "--property=ControlGroup", "--value"]);
  if (!cgroup.startsWith("/")) throw new Error("host capacity cannot resolve its command slice");
  const request = { id, job: input.job, lane: input.lane, owner: currentCapacityOwner(), cgroup };
  const started = Date.now();
  let lastNotice = -Infinity;
  let admittedMode = policy.mode;
  // The most the job and the containers it measures were seen to hold together, while it ran.
  let measuredPeak = 0;
  const measure = async () => {
    const external = await Promise.all((input.measureContainers ?? []).map(readContainerResidentBytes));
    const own = readCapacityObservation([{ ...request, bytes: 0, queuedAt: 0, admittedAt: 0 }]).reading?.currentBytes[id];
    if (external.some((bytes) => bytes === null) || typeof own !== "number") return;
    const externalBytes = external.reduce<number>((sum, bytes) => sum + bytes!, 0);
    measuredPeak = Math.max(measuredPeak, own + externalBytes);
    const store = openCapacityStore(capacityStorePath());
    try { store.noteUsage(id, request.owner, externalBytes, measuredPeak); } finally { store.close(); }
  };
  let measuring: ReturnType<typeof setInterval> | undefined;
  let sample: Promise<void> | undefined;
  try {
    // Set and verify the caller's explicit bound before admission. It is also a hard bound in shadow mode;
    // default shadow commands retain their existing uncapped behavior. Machine holders never use this path.
    if (input.memoryMaxBytes !== undefined) {
      systemctl(["set-property", "--runtime", slice, `MemoryMax=${bytes}`, "MemorySwapMax=0"]);
      if (systemctl(["show", slice, "--property=MemoryMax", "--value"]) !== String(bytes)) {
        throw new Error("explicit --memory-max could not be verified; refusing under-reserved execution");
      }
    }
    for (;;) {
      input.signal?.throwIfAborted();
      const result = pollHostCapacity(request, Date.now(), input.memoryMaxBytes, bytes);
      if (!result.configured) throw new Error("host capacity policy disappeared during admission; retry the command");
      if (result.outcome === "admitted") { admittedMode = result.mode; break; }
      const waited = Date.now() - started;
      if (waited - lastNotice >= 30_000 || result.outcome === "unavailable") {
        input.onWait?.(`${input.job}: ${result.decision.reason}; waited ${Math.round(waited / 1000)}s; oldest queue ${Math.round(result.decision.oldestWaitMs / 1000)}s`);
        lastNotice = waited;
      }
      if (result.outcome === "unavailable") return 75;
      await pause(1000, undefined, { signal: input.signal });
    }
    const enforced = policy.mode === "enforce" || admittedMode === "enforce";
    if (enforced && input.memoryMaxBytes === undefined) systemctl(["set-property", "--runtime", slice, `MemoryMax=${bytes}`, "MemorySwapMax=0"]);
    // Ceilings overlap (SJ-244), so restartable work is first in the kernel's out-of-memory order. A scope cannot carry
    // OOMScoreAdjust; choom raises it for the command and everything it starts, which needs no privilege.
    const adjust = enforced ? CAPACITY_OOM_SCORE_ADJUST[input.lane] : 0;
    // Unreclaimable memory has no kernel peak, so the job's own is sampled with any containers it names (SJ-267). A
    // measurement is evidence, never a reason to stop the job.
    measuring = setInterval(() => {
      if (!sample) sample = measure().catch(() => undefined).finally(() => { sample = undefined; });
    }, input.measureEveryMs ?? CAPACITY_SAMPLE_EVERY_MS);
    return await execute(["systemd-run", "--user", "--scope", "--quiet", "--collect", `--slice=${slice}`, `--unit=slipjay-capacity-${id}.scope`,
      "--property=TimeoutStopSec=5s", "--", ...adjust ? ["choom", "-n", String(adjust), "--"] : [], ...input.command], { ...(input.env ?? process.env), SLIPJAY_HOST_CAPACITY_ID: id,
        SLIPJAY_HOST_CAPACITY_BYTES: input.memoryMaxBytes === undefined ? "" : String(bytes), [SYSTEMD_SLICE_ENV]: slice });
  } finally {
    // Stop only the exact unit we allocated, then verify the cgroup before releasing its reservation. A lost SSH or
    // SIGKILL leaves it recorded for the next caller's identity-checked recovery instead of trusting an old PID.
    if (measuring) clearInterval(measuring);
    await sample;
    const resources = readCapacityResources(cgroup);
    // The job's own cgroup peak stays as read; the most it held with its measured containers is kept beside it.
    const evidence = measuredPeak ? { ...resources, measuredPeakBytes: measuredPeak } : resources;
    systemctl(["stop", slice]);
    const store = openCapacityStore(capacityStorePath());
    try {
      if (!store.finish(id, request.owner, (recorded) => capacityGroupEmpty(recorded.cgroup) === true, evidence)) {
        throw new Error(`host capacity cleanup is unconfirmed for ${slice}; commitment retained`);
      }
      systemctl(["revert", slice]);
    } finally { store.close(); }
  }
}
