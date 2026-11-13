import { setTimeout as pause } from "node:timers/promises";
import { shellWord } from "./remote-attempt.ts";
import type { CapacityClass, CapacityOwner } from "./host-capacity.ts";
import type { pollHostCapacity } from "./host-capacity-command.ts";

export const capacityPolicyScript = `# SlipJay host capacity policy
if [ -f "$HOME/.slipjay/config.json" ] && grep -q '"hostBudget"' "$HOME/.slipjay/config.json"; then
  if capacity_policy=$(slipjay host-budget policy); then
    printf '%s\\n' "$capacity_policy"
  else
    printf '%s\\n' '{"configured":true,"unavailable":"host capacity policy could not be read"}'
  fi
else
  printf '%s\\n' '{"configured":false}'
fi`;

export class HostCapacityUnavailable extends Error {
  readonly capacityUnavailable = true;
}

/** A present but unreadable policy cannot become an unconfigured-machine fallback. */
export function decodeCapacityPolicy(text: string): { configured: boolean } {
  try {
    const policy: unknown = JSON.parse(text);
    if (!policy || typeof policy !== "object" || !("configured" in policy) || typeof policy.configured !== "boolean"
      || "unavailable" in policy) throw new Error("host capacity policy is unavailable or invalid");
    return { configured: policy.configured };
  } catch (cause) {
    throw new HostCapacityUnavailable("host capacity policy could not be read; no unbudgeted fallback", { cause });
  }
}

/** Admission owns no verification timeout. Each SSH call is short; the caller keeps the whole holder until cleanup. */
export async function admitMachineCapacity(input: {
  control: (script: string, signal?: AbortSignal) => Promise<string>;
  id: string;
  job: string;
  lane: CapacityClass;
  owner: CapacityOwner;
  slice: string;
  signal: AbortSignal;
  policy?: { configured: boolean };
  onWait?: (line: string, waitedMs: number, finished: boolean) => void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<unknown>;
}): Promise<number> {
  const policy = input.policy ?? decodeCapacityPolicy(await input.control(capacityPolicyScript, input.signal));
  if (!policy.configured) return 0;
  try {
    // Existing machine lane limits remain authoritative. A commitment is configured admission capacity; the policy and
    // diagnostics must distinguish it from the lane's kernel ceiling, including Docker's separate accounting domain.
    const cgroup = await input.control(`systemctl --user start ${shellWord(input.slice)}\nsystemctl --user show ${shellWord(input.slice)} --property=ControlGroup --value`, input.signal);
    if (!cgroup.startsWith("/")) throw new Error("host capacity cannot resolve the attempt cgroup");
    const request = { id: input.id, job: input.job, lane: input.lane, owner: input.owner, cgroup };
    const script = `slipjay host-budget poll ${shellWord(JSON.stringify(request))}`;
    const now = input.now ?? Date.now;
    const sleep = input.sleep ?? ((ms, signal) => pause(ms, undefined, { signal }));
    const started = now();
    let notice = -Infinity;
    let waited = false;
    for (;;) {
      input.signal.throwIfAborted();
      const result = JSON.parse(await input.control(script, input.signal)) as ReturnType<typeof pollHostCapacity>;
      const elapsed = now() - started;
      if (!("configured" in result) || !result.configured) throw new HostCapacityUnavailable("host capacity policy disappeared during acquisition; retry");
      if (!["admitted", "waiting", "unavailable"].includes(result.outcome) || !result.decision || typeof result.decision.reason !== "string") throw new Error("invalid host capacity receipt");
      if (result.outcome === "admitted") {
        if (waited) input.onWait?.(`${input.job} admitted after ${Math.round(elapsed / 1000)}s of host capacity wait`, elapsed, true);
        return waited ? elapsed : 0;
      }
      if (elapsed - notice >= 30_000 || result.outcome === "unavailable") {
        input.onWait?.(`${input.job}: ${result.decision.reason}; waited ${Math.round(elapsed / 1000)}s; oldest queue ${Math.round(result.decision.oldestWaitMs / 1000)}s`, elapsed, false);
        notice = elapsed;
      }
      if (result.outcome === "unavailable") throw new HostCapacityUnavailable(`${input.job}: ${result.decision.reason}`);
      waited = true;
      await sleep(1000, input.signal);
    }
  } catch (cause) {
    input.signal.throwIfAborted();
    if (cause instanceof HostCapacityUnavailable) throw cause;
    throw new HostCapacityUnavailable(`host capacity acquisition failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}
