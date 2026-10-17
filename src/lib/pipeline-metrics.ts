import { RUNNER_CONTROL_ID, type CauseClass, type RunnerStage, type StoredEvent } from "./runner-contract.ts";

export type MetricTiming = { samples: number; medianMs: number; p90Ms: number };
export type FlakeCandidate = {
  test: string;
  command: string;
  confirmed: boolean;
  fileSet?: string;
  changes: string[];
  failureEvidence: { operationId: string; seq: number; fileSet?: string }[];
  passingEvidence?: { operationId: string; seq: number };
};
export type WorkspaceStartMetric = { repo: string; machine: string; starts: number; poolHits: number; claim: MetricTiming; medianSpares: number };
export type ChangeAttempts = { repo: string; changeId: string; operationIds: string[]; attempts: number; landed: boolean };
export type HeldMetric = { repo: string; operationId: string; commitId: string; retries: number; durationMs: number; published: boolean; seq: number };

export type PipelineMetrics = {
  since: string;
  operations: number;
  outcomes: Record<string, number>;
  causes: Record<CauseClass, number>;
  stages: Partial<Record<RunnerStage, MetricTiming>>;
  queue: { total: MetricTiming | null; activeWait: MetricTiming | null; paused: MetricTiming | null };
  commands: Record<string, MetricTiming>;
  flakes: FlakeCandidate[];
  attempts: ChangeAttempts[];
  held: HeldMetric[];
  workspaceStarts: WorkspaceStartMetric[];
};

type OperationHistory = {
  id: string;
  events: StoredEvent[];
  submitted?: Extract<StoredEvent["event"], { type: "submitted" }>;
  submittedEvent?: StoredEvent;
  shape?: Extract<StoredEvent["event"], { type: "change_shape" }>;
};

const timing = (values: number[]): MetricTiming | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const p90Ms = sorted[Math.ceil(sorted.length * 0.9) - 1]!;
  return { samples: sorted.length, medianMs, p90Ms };
};

const eventTime = (event: StoredEvent): number => Date.parse(event.at);
const validDuration = (value: number): boolean => Number.isFinite(value) && value >= 0;
const isTerminal = (type: string): boolean => ["landed", "released", "deployed", "reset", "failed", "declined", "superseded", "cancelled"].includes(type);

function pauseWindows(events: readonly StoredEvent[]): [number, number][] {
  const controls = events.filter((row) => row.operationId === RUNNER_CONTROL_ID && (row.event.type === "paused" || row.event.type === "resumed"))
    .sort((a, b) => a.seq - b.seq);
  const windows: [number, number][] = [];
  let started: number | undefined;
  for (const row of controls) {
    const at = eventTime(row);
    if (!Number.isFinite(at)) continue;
    if (row.event.type === "paused") started ??= at;
    else if (started !== undefined) { windows.push([started, Math.max(started, at)]); started = undefined; }
  }
  if (started !== undefined) windows.push([started, Number.POSITIVE_INFINITY]);
  return windows;
}

function pausedOverlap(start: number, end: number, windows: readonly [number, number][]): number {
  return windows.reduce((total, [pauseStart, pauseEnd]) => total + Math.max(0, Math.min(end, pauseEnd) - Math.max(start, pauseStart)), 0);
}

function operationHistory(events: readonly StoredEvent[]): Map<string, OperationHistory> {
  const histories = new Map<string, OperationHistory>();
  for (const row of [...events].sort((a, b) => a.seq - b.seq)) {
    if (row.operationId === RUNNER_CONTROL_ID) continue;
    let history = histories.get(row.operationId);
    if (!history) { history = { id: row.operationId, events: [] }; histories.set(row.operationId, history); }
    history.events.push(row);
    if (row.event.type === "submitted") { history.submitted = row.event; history.submittedEvent = row; }
    if (row.event.type === "change_shape") history.shape = row.event;
  }
  return histories;
}

function flakeCandidates(all: Map<string, OperationHistory>, since: number): FlakeCandidate[] {
  type Failure = { operationId: string; seq: number; at: number; repo: string; changeId: string; test: string; command: string; fileSet?: string };
  type Pass = { operationId: string; seq: number; repo: string; command: string; fileSet: string };
  const failures: Failure[] = [];
  const passes: Pass[] = [];

  for (const op of all.values()) {
    if (!op.submitted || op.submitted.kind === "release" || op.submitted.kind === "deploy" || op.submitted.kind === "reset") continue;
    const commandByRun = new Map<string, string>();
    for (const row of op.events) if (row.event.type === "run_started") commandByRun.set(row.event.runId, row.event.command);
    for (const row of op.events) {
      if (row.event.type === "classified" && row.event.cause === "gate" && row.event.command) {
        for (const test of row.event.failingTests) failures.push({ operationId: op.id, seq: row.seq, at: eventTime(row), repo: op.submitted.repo, changeId: op.submitted.changeId, test, command: row.event.command, ...(op.shape ? { fileSet: op.shape.fileSet } : {}) });
      }
      if (row.event.type !== "run_finished") continue;
      const command = commandByRun.get(row.event.runId);
      if (command && op.shape && row.event.exitCode === 0 && row.event.signal === null && !row.event.timedOut && !row.event.killed)
        passes.push({ operationId: op.id, seq: row.seq, repo: op.submitted.repo, command, fileSet: op.shape.fileSet });
    }
  }

  const latestFailures = new Map<string, Failure[]>();
  for (const failure of failures) {
    const key = JSON.stringify([failure.repo, failure.test, failure.command]);
    const group = latestFailures.get(key) ?? [];
    group.push(failure);
    latestFailures.set(key, group);
  }
  const grouped = new Map<string, Failure[]>();
  for (const failure of failures) {
    if (!Number.isFinite(since) || failure.at < since) continue;
    const key = JSON.stringify([failure.repo, failure.test, failure.command]);
    const group = grouped.get(key) ?? [];
    group.push(failure);
    grouped.set(key, group);
  }
  const result: FlakeCandidate[] = [];
  for (const [key, group] of grouped) {
    const changes = [...new Set(group.map((entry) => `${entry.repo}/${entry.changeId}`))];
    if (changes.length < 2) continue;
    const allFailures = latestFailures.get(key) ?? group;
    const latestFailureSeq = Math.max(...allFailures.map((entry) => entry.seq));
    const first = group[0]!;
    const passing = passes.find((pass) => pass.seq > latestFailureSeq && pass.repo === first.repo && pass.command === first.command && group.some((failure) => failure.fileSet === pass.fileSet));
    const confirmedFailure = passing ? group.find((failure) => failure.fileSet === passing.fileSet) : undefined;
    result.push({
      test: first.test,
      command: first.command,
      confirmed: Boolean(passing && confirmedFailure),
      ...(passing && confirmedFailure ? { fileSet: passing.fileSet, passingEvidence: { operationId: passing.operationId, seq: passing.seq } } : {}),
      changes,
      failureEvidence: group.sort((a, b) => a.seq - b.seq).map(({ operationId, seq, fileSet }) => ({ operationId, seq, ...(fileSet ? { fileSet } : {}) })),
    });
  }
  return result.sort((a, b) => a.test.localeCompare(b.test) || a.command.localeCompare(b.command));
}

/** Claim timings for workspace starts, grouped by repository and machine, from the clients' pool_claim facts. */
function workspaceStarts(events: readonly StoredEvent[], since: number): WorkspaceStartMetric[] {
  const origins = new Map<string, { repo: string; machine: string }>();
  for (const row of events) if (row.event.type === "client_operation") origins.set(row.operationId, { repo: row.event.repo, machine: row.event.machine });
  const groups = new Map<string, { repo: string; machine: string; durations: number[]; spares: number[]; hits: number }>();
  for (const row of events) {
    if (row.event.type !== "client" || row.event.fact.kind !== "pool_claim" || !(eventTime(row) >= since) || !validDuration(row.event.fact.durationMs)) continue;
    const origin = origins.get(row.operationId);
    if (!origin) continue;
    const key = JSON.stringify([origin.repo, origin.machine]);
    const group = groups.get(key) ?? { ...origin, durations: [], spares: [], hits: 0 };
    group.durations.push(row.event.fact.durationMs);
    group.spares.push(row.event.fact.spareCount);
    if (row.event.fact.hit) group.hits++;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({ repo: group.repo, machine: group.machine, starts: group.durations.length, poolHits: group.hits, claim: timing(group.durations)!, medianSpares: timing(group.spares)!.medianMs }))
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.machine.localeCompare(b.machine));
}

/** Project terminal pipeline metrics from runner evidence. */
export function pipelineMetrics(events: readonly StoredEvent[], since: string): PipelineMetrics {
  const histories = operationHistory(events);
  const threshold = Date.parse(since);
  const selected = [...histories.values()].filter((op) => op.submittedEvent && Number.isFinite(threshold) && eventTime(op.submittedEvent) >= threshold);
  const causes = Object.fromEntries(["gate", "conflict", "infrastructure", "policy", "killed", "paused_out", "held", "superseded", "cancelled"].map((cause) => [cause, 0])) as Record<CauseClass, number>;
  const outcomes: Record<string, number> = {};
  const stageSamples = new Map<RunnerStage, number[]>();
  const commandSamples = new Map<string, number[]>();
  const queueTotal: number[] = [];
  const queuePaused: number[] = [];
  const queueActive: number[] = [];
  const windows = pauseWindows(events);
  const attemptsByChange = new Map<string, { repo: string; changeId: string; operations: OperationHistory[] }>();

  for (const op of selected) {
    const rows = op.events;
    const submittedRow = op.submittedEvent!;
    const submitted = op.submitted!;
    const terminal = rows.find((row) => isTerminal(row.event.type));
    const outcome = terminal?.event.type ?? "open";
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    for (const row of rows) {
      if (row.event.type === "classified") causes[row.event.cause]++;
      if (row.event.type === "stage_detail" && row.event.migrateDurationMs === undefined && row.event.pushDurationMs === undefined && validDuration(row.event.durationMs)) {
        const samples = stageSamples.get(row.event.stage) ?? [];
        samples.push(row.event.durationMs);
        stageSamples.set(row.event.stage, samples);
      }
    }

    const firstStage = rows.find((row) => row.event.type === "stage" && row.event.stage !== "queued");
    const start = eventTime(submittedRow);
    const end = firstStage ? eventTime(firstStage) : terminal ? eventTime(terminal) : Number.NaN;
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      const total = end - start;
      const paused = Math.min(total, pausedOverlap(start, end, windows));
      const active = Math.max(0, total - paused);
      queueTotal.push(total); queuePaused.push(paused); queueActive.push(active);
      const queuedSamples = stageSamples.get("queued") ?? [];
      queuedSamples.push(active);
      stageSamples.set("queued", queuedSamples);
    }

    const starts = new Map<string, { command: string; seq: number }>();
    for (const row of rows) if (row.event.type === "run_started") starts.set(row.event.runId, { command: row.event.command, seq: row.seq });
    for (const row of rows) {
      if (row.event.type !== "run_finished" || !validDuration(row.event.durationMs)) continue;
      const started = starts.get(row.event.runId);
      if (!started) continue;
      const samples = commandSamples.get(started.command) ?? [];
      samples.push(row.event.durationMs);
      commandSamples.set(started.command, samples);
    }

    if (submitted.kind !== "release" && submitted.kind !== "deploy" && submitted.kind !== "reset") {
      const key = JSON.stringify([submitted.repo, submitted.changeId]);
      const group = attemptsByChange.get(key) ?? { repo: submitted.repo, changeId: submitted.changeId, operations: [] };
      group.operations.push(op);
      attemptsByChange.set(key, group);
    }
  }

  const attempts = [...attemptsByChange.values()].map((group) => {
    const history = [...histories.values()].filter((op) => op.submitted?.kind !== "release" && op.submitted?.kind !== "deploy" && op.submitted?.kind !== "reset" && op.submitted?.repo === group.repo && op.submitted.changeId === group.changeId).sort((a, b) => a.submittedEvent!.seq - b.submittedEvent!.seq);
    const landedAt = history.findIndex((op) => op.events.some((row) => row.event.type === "landed"));
    const throughLanded = history.slice(0, landedAt < 0 ? undefined : landedAt + 1);
    return { repo: group.repo, changeId: group.changeId, operationIds: throughLanded.map((op) => op.id), attempts: throughLanded.length, landed: landedAt >= 0 };
  }).sort((a, b) => a.repo.localeCompare(b.repo) || a.changeId.localeCompare(b.changeId));

  const heldGroups = new Map<string, StoredEvent[]>();
  for (const row of events) {
    if (row.event.type !== "held") continue;
    const key = JSON.stringify([row.event.repo, row.event.commitId]);
    const group = heldGroups.get(key) ?? [];
    group.push(row);
    heldGroups.set(key, group);
  }
  const held = [...heldGroups.values()].flatMap((group): HeldMetric[] => {
    if (!Number.isFinite(threshold) || !group.some((row) => eventTime(row) >= threshold)) return [];
    const latest = group.reduce((a, b) => a.seq >= b.seq ? a : b);
    if (latest.event.type !== "held") return [];
    return [{ repo: latest.event.repo, operationId: latest.operationId, commitId: latest.event.commitId, retries: latest.event.retries, durationMs: latest.event.durationMs, published: latest.event.published, seq: latest.seq }];
  }).sort((a, b) => a.seq - b.seq);

  const stages = Object.fromEntries([...stageSamples].map(([stage, values]) => [stage, timing(values)!])) as Partial<Record<RunnerStage, MetricTiming>>;
  const commands = Object.fromEntries([...commandSamples].map(([command, values]) => [command, timing(values)!]));
  return {
    since,
    operations: selected.length,
    outcomes,
    causes,
    stages,
    queue: { total: timing(queueTotal), activeWait: timing(queueActive), paused: timing(queuePaused) },
    commands,
    flakes: flakeCandidates(histories, threshold),
    attempts,
    held,
    workspaceStarts: workspaceStarts(events, threshold),
  };
}

const formatTiming = (value: MetricTiming | null | undefined): string => value
  ? `${value.samples} samples, median ${Math.round(value.medianMs)}ms, p90 ${Math.round(value.p90Ms)}ms`
  : "no samples";

/** Render a concise terminal summary of the measured pipeline evidence. */
export function formatPipelineMetrics(metrics: PipelineMetrics): string {
  const lines = [`Pipeline metrics since ${metrics.since}`, `${metrics.operations} operations`];
  lines.push(`Outcomes: ${Object.entries(metrics.outcomes).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${name} ${count}`).join(", ") || "none"}`);
  lines.push(`Causes: ${Object.entries(metrics.causes).filter(([, count]) => count > 0).map(([name, count]) => `${name} ${count}`).join(", ") || "none"}`);
  lines.push(`Queue: total ${formatTiming(metrics.queue.total)}; active ${formatTiming(metrics.queue.activeWait)}; paused ${formatTiming(metrics.queue.paused)}`);
  lines.push(`Stages: ${Object.entries(metrics.stages).map(([name, value]) => `${name} ${formatTiming(value)}`).join("; ") || "no samples"}`);
  lines.push(`Commands: ${Object.entries(metrics.commands).map(([name, value]) => `${name} ${formatTiming(value)}`).join("; ") || "no samples"}`);
  lines.push(`Flake candidates: ${metrics.flakes.length ? metrics.flakes.map((candidate) => `${candidate.test} (${candidate.confirmed ? "confirmed" : "candidate"}; ${candidate.changes.length} changes; ${candidate.command}${candidate.fileSet ? `; fileSet ${candidate.fileSet}` : ""})`).join("; ") : "none"}`);
  lines.push(`Attempts: ${metrics.attempts.length ? metrics.attempts.map((attempt) => `${attempt.repo}/${attempt.changeId} ${attempt.attempts}${attempt.landed ? " until landed" : " open"}`).join("; ") : "none"}`);
  lines.push(`Held integrations: ${metrics.held.length ? metrics.held.map((entry) => `${entry.repo}/${entry.commitId} retries ${entry.retries}, ${entry.durationMs}ms, ${entry.published ? "published" : "unpublished"}`).join("; ") : "none"}`);
  lines.push(`Workspace starts: ${metrics.workspaceStarts.length ? metrics.workspaceStarts.map((entry) => `${entry.repo} on ${entry.machine} ${entry.starts} starts, ${entry.poolHits} from the pool, claim median ${Math.round(entry.claim.medianMs)}ms, p90 ${Math.round(entry.claim.p90Ms)}ms, median ${entry.medianSpares} spares at start`).join("; ") : "none"}`);
  return lines.join("\n");
}
