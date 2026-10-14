import { KILLABLE_STAGES, TERMINAL_EVENT_TYPES } from "./runner-contract.ts";
import type { Operation, StoredEvent, WatchOperation } from "./runner-contract.ts";

/** Completed stage intervals only; cap each same-kind/stage sample at the latest 100. */
export function projectWatchOperation(operation: Operation, events: readonly StoredEvent[], now: Date): WatchOperation {
  const kinds = new Map<string, string>();
  const stages = new Map<string, { stage: string; at: string }>();
  const samples: number[] = [];
  let stageStartedAt: string | undefined;
  for (const stored of events) {
    const event = stored.event;
    if (event.type === "submitted") kinds.set(stored.operationId, event.kind ?? "landing");
    if (event.type === "stage" || (TERMINAL_EVENT_TYPES as readonly string[]).includes(event.type)) {
      const previous = stages.get(stored.operationId);
      if (previous && previous.stage === operation.stage && kinds.get(stored.operationId) === operation.kind) {
        const duration = Date.parse(stored.at) - Date.parse(previous.at);
        if (duration >= 0) { samples.push(duration); if (samples.length > 100) samples.shift(); }
      }
      if (event.type === "stage") {
        stages.set(stored.operationId, { stage: event.stage, at: stored.at });
        if (stored.operationId === operation.id) stageStartedAt = stored.at;
      } else stages.delete(stored.operationId);
    }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const medianMs = sorted.length ? ((sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2) : null;
  const amberAfterMs = medianMs === null ? null : medianMs * 2;
  const command = operation.runs.findLast((run) => !run.finishedAt);
  const deadline = command?.timeoutMs === undefined ? null : Date.parse(command.startedAt) + command.timeoutMs;
  const running = operation.status === "running";
  const state = !running ? "unknown" : deadline !== null && now.getTime() > deadline ? "red"
    : amberAfterMs === null || !stageStartedAt ? "unknown" : now.getTime() - Date.parse(stageStartedAt) > amberAfterMs ? "amber" : "normal";
  const allowed = running && operation.kind !== "deploy" && KILLABLE_STAGES.includes(operation.stage);
  return { ...operation, ...(stageStartedAt ? { stageStartedAt } : {}),
    timing: { state, medianMs, amberAfterMs, samples: samples.length, commandDeadlineAt: deadline === null ? null : new Date(deadline).toISOString() },
    kill: { allowed, reason: allowed ? null : !running ? "Operation is not running" : operation.kind === "deploy" ? "Deploy operations cannot be killed" : `${operation.stage} is past verification and cannot be killed` } };
}
