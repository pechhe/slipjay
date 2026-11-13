import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { capacityControllerState, capacityGroupEmpty, capacityStorePath, currentCapacityOwner, readCapacityObservation, readCapacityPolicy, readCapacityResources } from "./host-capacity-local.ts";
import { openCapacityStore } from "./host-capacity-store.ts";
import type { CapacityClass, CapacityRequest } from "./host-capacity.ts";
import { SYSTEMD_SLICE_ENV } from "./runner-contract.ts";

/** One transaction per poll; the caller owns its wait and can keep it outside verification deadlines. */
export function pollHostCapacity(request: Omit<CapacityRequest, "bytes" | "queuedAt" | "admittedAt">, now = Date.now()) {
  const policy = readCapacityPolicy();
  if (!policy) return { configured: false as const };
  recoverHostCapacity();
  const store = openCapacityStore(capacityStorePath());
  try {
    return { configured: true as const, policy, ...store.poll({ ...request, bytes: policy.profiles[request.lane], queuedAt: now, admittedAt: null }, policy, readCapacityObservation, now) };
  } finally { store.close(); }
}

export function hostCapacityStatus() {
  const policy = readCapacityPolicy();
  if (!policy) return { configured: false as const };
  const store = openCapacityStore(capacityStorePath());
  try {
    const requests = store.requests();
    return { configured: true as const, policy, requests, observation: readCapacityObservation(requests), history: store.history() };
  } finally { store.close(); }
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
  if (!policy) return execute(input.command);
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
  try {
    for (;;) {
      input.signal?.throwIfAborted();
      const result = pollHostCapacity(request);
      if (!result.configured) throw new Error("host capacity policy disappeared during admission; retry the command");
      if (result.outcome === "admitted") break;
      const waited = Date.now() - started;
      if (waited - lastNotice >= 30_000 || result.outcome === "unavailable") {
        input.onWait?.(`${input.job}: ${result.decision.reason}; waited ${Math.round(waited / 1000)}s; oldest queue ${Math.round(result.decision.oldestWaitMs / 1000)}s`);
        lastNotice = waited;
      }
      if (result.outcome === "unavailable") return 75;
      await pause(1000, undefined, { signal: input.signal });
    }
    if (policy.mode === "enforce") systemctl(["set-property", "--runtime", slice, `MemoryMax=${policy.profiles[input.lane]}`, "MemorySwapMax=0"]);
    return await execute(["systemd-run", "--user", "--scope", "--quiet", "--collect", `--slice=${slice}`, `--unit=slipjay-capacity-${id}.scope`,
      "--property=TimeoutStopSec=5s", "--", ...input.command], { ...(input.env ?? process.env), SLIPJAY_HOST_CAPACITY_ID: id, [SYSTEMD_SLICE_ENV]: slice });
  } finally {
    // Stop only the exact unit we allocated, then verify the cgroup before releasing its reservation. A lost SSH or
    // SIGKILL leaves it recorded for the next caller's identity-checked recovery instead of trusting an old PID.
    const resources = readCapacityResources(cgroup);
    systemctl(["stop", slice]);
    const store = openCapacityStore(capacityStorePath());
    try {
      if (!store.finish(id, request.owner, (recorded) => capacityGroupEmpty(recorded.cgroup) === true, resources)) {
        throw new Error(`host capacity cleanup is unconfirmed for ${slice}; commitment retained`);
      }
      systemctl(["revert", slice]);
    } finally { store.close(); }
  }
}
