import { START_STEPS, type StartStep } from "../workspace/start-steps.ts";
import { isLandingSubmission, repositoryKey, RUNNER_CONTROL_ID, type CauseClass, type Operation, type RunnerStage, type StoredEvent } from "./runner-contract.ts";
import type { TimeBudgets } from "../policy/execution-policy.ts";
import { auditSummariesFromEvents, type AuditSummary } from "../release/audit-ledger.ts";

export type MetricTiming = { samples: number; medianMs: number; p90Ms: number };
export type FlakeCandidate = {
  test: string;
  command: string;
  confirmed: boolean;
  fileSet?: string;
  changes: string[];
  failureEvidence: { operationId: string; seq: number; fileSet?: string }[];
  passingEvidence?: { operationId: string; seq: number };
  /** It failed, then passed on a retry of the same source commit: no input changed between them. */
  retriedPass?: { operationId: string; seq: number };
};
/** `steps`: the median of each start step, over the starts that recorded it (see start-steps.ts). */
export type WorkspaceStartMetric = { repo: string; machine: string; starts: number; poolHits: number; claim: MetricTiming; medianSpares: number; steps: Partial<Record<StartStep, number>> };
export type ChangeAttempts = { repo: string; changeId: string; operationIds: string[]; attempts: number; landed: boolean };
export type HeldMetric = { repo: string; operationId: string; commitId: string; retries: number; durationMs: number; published: boolean; seq: number };

/** Timings of one repository's operations of one kind: landings, releases, deploys and the rest are never pooled. */
export type OperationGroupMetrics = {
  repo: string;
  kind: Operation["kind"];
  operations: number;
  outcomes: Record<string, number>;
  stages: Partial<Record<RunnerStage, MetricTiming>>;
  queue: { total: MetricTiming | null; activeWait: MetricTiming | null; paused: MetricTiming | null };
  commands: Record<string, MetricTiming>;
};

/** A test file's executed (passed or failed, never skipped) durations in one operation kind: a landing's related run and the audit's complete one are never pooled. */
export type TestFileMetric = { kind: Operation["kind"]; file: string; suite: string; samples: number; medianMs: number; p90Ms: number };
export type TestFileGrowth = { kind: Operation["kind"]; file: string; suite: string; earlierMedianMs: number; laterMedianMs: number; samples: number };
/** A budget is judged only on enough samples; `over` names each budget the window broke. */
export type BudgetStatus = { status: "undeclared" | "insufficient-samples" | "within" | "over"; over: string[] };

/** One repository's landing health: verify time against its budgets, and its test files. */
export type RepositoryMetrics = {
  repo: string;
  budgets: TimeBudgets | null;
  /** Wall-clock verifying stage of landings whose checks ran, over the budget window ending now. */
  verify: MetricTiming | null;
  budget: BudgetStatus;
  /** Gate and audit commands by what their reports said; `missing` counts those that wrote none. */
  reports: { recorded: number; malformed: number; missing: number };
  slowestTestFiles: TestFileMetric[];
  growingTestFiles: TestFileGrowth[];
  testFilesOverBudget: TestFileMetric[];
  /** Its nightly audits (see `audit-ledger.ts`); null when it has none. */
  audit: AuditSummary | null;
};

export type PipelineMetrics = {
  since: string;
  operations: number;
  outcomes: Record<string, number>;
  causes: Record<CauseClass, number>;
  groups: OperationGroupMetrics[];
  repositories: RepositoryMetrics[];
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

/** The window a budget is judged over, and the fewest samples it is judged on. */
export const BUDGET_WINDOW_MS = 7 * 24 * 3_600_000;
export const BUDGET_MIN_SAMPLES = 10;
const LISTED_FILES = 10;
/** A file is growing when its later median is this much over its earlier one, each from enough samples. */
const GROWTH_RATIO = 1.2;
const GROWTH_MIN_SAMPLES = 3;

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
const isTerminal = (type: string): boolean => ["landed", "released", "verified", "audited", "deployed", "reset", "failed", "declined", "superseded", "cancelled"].includes(type);

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
  type Failure = { operationId: string; seq: number; at: number; repo: string; changeId: string; source: string; test: string; command: string; fileSet?: string };
  type Pass = { operationId: string; seq: number; repo: string; source: string; command: string; fileSet?: string };
  const failures: Failure[] = [];
  const passes: Pass[] = [];

  for (const op of all.values()) {
    if (!isLandingSubmission(op.submitted)) continue;
    const commandByRun = new Map<string, string>();
    for (const row of op.events) if (row.event.type === "run_started") commandByRun.set(row.event.runId, row.event.command);
    for (const row of op.events) {
      if (row.event.type === "classified" && row.event.cause === "gate" && row.event.command) {
        for (const test of row.event.failingTests) failures.push({ operationId: op.id, seq: row.seq, at: eventTime(row), repo: op.submitted.repo, changeId: op.submitted.changeId, source: op.submitted.commitId, test, command: row.event.command, ...(op.shape ? { fileSet: op.shape.fileSet } : {}) });
      }
      if (row.event.type !== "run_finished") continue;
      const command = commandByRun.get(row.event.runId);
      if (command && row.event.exitCode === 0 && row.event.signal === null && !row.event.timedOut && !row.event.killed)
        passes.push({ operationId: op.id, seq: row.seq, repo: op.submitted.repo, source: op.submitted.commitId, command, ...(op.shape ? { fileSet: op.shape.fileSet } : {}) });
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
    const first = group[0]!;
    // The same source commit passing the same command later: nothing the change controls differed.
    const retried = group.flatMap((failure) => passes.filter((pass) => pass.seq > failure.seq && pass.operationId !== failure.operationId
      && pass.repo === failure.repo && pass.source === failure.source && pass.command === failure.command)).sort((a, b) => a.seq - b.seq)[0];
    if (changes.length < 2 && !retried) continue;
    const allFailures = latestFailures.get(key) ?? group;
    const latestFailureSeq = Math.max(...allFailures.map((entry) => entry.seq));
    const passing = passes.find((pass) => pass.seq > latestFailureSeq && pass.repo === first.repo && pass.command === first.command && pass.fileSet !== undefined && group.some((failure) => failure.fileSet === pass.fileSet));
    const confirmedFailure = passing ? group.find((failure) => failure.fileSet === passing.fileSet) : undefined;
    result.push({
      test: first.test,
      command: first.command,
      confirmed: Boolean((passing && confirmedFailure) || retried),
      ...(passing && confirmedFailure ? { fileSet: passing.fileSet, passingEvidence: { operationId: passing.operationId, seq: passing.seq } } : {}),
      ...(retried ? { retriedPass: { operationId: retried.operationId, seq: retried.seq } } : {}),
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
  const groups = new Map<string, { repo: string; machine: string; durations: number[]; spares: number[]; hits: number; steps: Partial<Record<StartStep, number[]>> }>();
  for (const row of events) {
    if (row.event.type !== "client" || row.event.fact.kind !== "pool_claim" || !(eventTime(row) >= since) || !validDuration(row.event.fact.durationMs)) continue;
    const origin = origins.get(row.operationId);
    if (!origin) continue;
    const key = JSON.stringify([origin.repo, origin.machine]);
    const group = groups.get(key) ?? { ...origin, durations: [], spares: [], hits: 0, steps: {} };
    group.durations.push(row.event.fact.durationMs);
    for (const step of START_STEPS) {
      const ms = row.event.fact.steps?.[step];
      if (ms !== undefined && validDuration(ms)) (group.steps[step] ??= []).push(ms);
    }
    group.spares.push(row.event.fact.spareCount);
    if (row.event.fact.hit) group.hits++;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({ repo: group.repo, machine: group.machine, starts: group.durations.length, poolHits: group.hits, claim: timing(group.durations)!, medianSpares: timing(group.spares)!.medianMs,
    steps: Object.fromEntries(START_STEPS.flatMap((step) => group.steps[step] ? [[step, timing(group.steps[step])!.medianMs]] : [])) }))
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.machine.localeCompare(b.machine));
}

const operationKind = (submitted: OperationHistory["submitted"]): Operation["kind"] => submitted?.kind ?? "landing";

/** A landing's verifying-stage duration when its checks ran: not skipped as a settings landing, not cancelled. */
function executedVerify(op: OperationHistory): number | undefined {
  if (!isLandingSubmission(op.submitted)) return undefined;
  if (op.events.some((row) => row.event.type === "verification_skipped" || row.event.type === "cancelled")) return undefined;
  if (!op.events.some((row) => row.event.type === "verification_base")) return undefined;
  const detail = op.events.find((row) => row.event.type === "stage_detail" && row.event.stage === "verifying" && validDuration(row.event.durationMs));
  return detail?.event.type === "stage_detail" ? detail.event.durationMs : undefined;
}

function budgetStatus(budgets: TimeBudgets | null, verify: MetricTiming | null, overFiles: number): BudgetStatus {
  if (!budgets || !Object.keys(budgets).length) return { status: "undeclared", over: [] };
  const over: string[] = [];
  if (budgets.testFileSeconds !== undefined && overFiles) over.push("testFileSeconds");
  const verifyDeclared = budgets.verifyP50Seconds !== undefined || budgets.verifyP90Seconds !== undefined;
  if (verifyDeclared && (!verify || verify.samples < BUDGET_MIN_SAMPLES)) return { status: over.length ? "over" : "insufficient-samples", over };
  if (verify && budgets.verifyP50Seconds !== undefined && verify.medianMs > budgets.verifyP50Seconds * 1000) over.push("verifyP50Seconds");
  if (verify && budgets.verifyP90Seconds !== undefined && verify.p90Ms > budgets.verifyP90Seconds * 1000) over.push("verifyP90Seconds");
  return { status: over.length ? "over" : "within", over };
}

/** Each repository's verify time against its latest recorded budgets, and its test files from executed reports. */
function repositoryMetrics(histories: Map<string, OperationHistory>, since: number, now: number, audits: Map<string, AuditSummary>): RepositoryMetrics[] {
  type Repo = { budgets: TimeBudgets | null; budgetSeq: number; verify: number[]; recorded: number; malformed: number; missing: number; files: Map<string, { kind: Operation["kind"]; file: string; suite: string; samples: number[] }> };
  const repos = new Map<string, Repo>();
  const repoOf = (name: string): Repo => {
    let repo = repos.get(name);
    if (!repo) { repo = { budgets: null, budgetSeq: -1, verify: [], recorded: 0, malformed: 0, missing: 0, files: new Map() }; repos.set(name, repo); }
    return repo;
  };
  for (const op of [...histories.values()].sort((a, b) => (a.submittedEvent?.seq ?? 0) - (b.submittedEvent?.seq ?? 0))) {
    if (!op.submitted || !op.submittedEvent) continue;
    const repo = repoOf(op.submitted.repo);
    for (const row of op.events) {
      // The latest landing's policy is the repository's current budget.
      if (row.event.type === "verification_base" && row.seq > repo.budgetSeq) { repo.budgets = row.event.budgets ?? null; repo.budgetSeq = row.seq; }
    }
    const submittedAt = eventTime(op.submittedEvent);
    const verify = executedVerify(op);
    if (verify !== undefined && submittedAt >= now - BUDGET_WINDOW_MS && submittedAt <= now) repo.verify.push(verify);
    if (!(submittedAt >= since)) continue;
    const kind = operationKind(op.submitted);
    for (const row of op.events) {
      if (row.event.type !== "test_report") continue;
      if (row.event.status === "malformed") { repo.malformed++; continue; }
      if (row.event.status === "missing") { repo.missing++; continue; }
      repo.recorded++;
      for (const file of row.event.files) {
        if (file.status === "skipped") continue;
        const key = JSON.stringify([kind, file.suite, file.file]);
        const entry = repo.files.get(key) ?? { kind, file: file.file, suite: file.suite, samples: [] };
        entry.samples.push(file.ms);
        repo.files.set(key, entry);
      }
    }
  }
  return [...repos].map(([name, repo]): RepositoryMetrics => {
    const files = [...repo.files.values()].map((entry) => ({ kind: entry.kind, file: entry.file, suite: entry.suite, ...timing(entry.samples)! }));
    const growing = [...repo.files.values()].flatMap((entry): TestFileGrowth[] => {
      const half = Math.floor(entry.samples.length / 2);
      if (half < GROWTH_MIN_SAMPLES) return [];
      const earlier = timing(entry.samples.slice(0, half))!.medianMs;
      const later = timing(entry.samples.slice(entry.samples.length - half))!.medianMs;
      return later > earlier * GROWTH_RATIO ? [{ kind: entry.kind, file: entry.file, suite: entry.suite, earlierMedianMs: earlier, laterMedianMs: later, samples: entry.samples.length }] : [];
    }).sort((a, b) => (b.laterMedianMs - b.earlierMedianMs) - (a.laterMedianMs - a.earlierMedianMs)).slice(0, LISTED_FILES);
    const limit = repo.budgets?.testFileSeconds;
    // The file budget is a landing budget, judged per file on its own landing samples: an audit's complete run, and
    // a file with fewer than BUDGET_MIN_SAMPLES landings, is listed but never judged against it.
    const overBudget = limit === undefined ? [] : files.filter((file) => file.kind === "landing" && file.samples >= BUDGET_MIN_SAMPLES && file.medianMs > limit * 1000).sort((a, b) => b.medianMs - a.medianMs);
    const verify = timing(repo.verify);
    return {
      repo: name, budgets: repo.budgets, verify, budget: budgetStatus(repo.budgets, verify, overBudget.length),
      reports: { recorded: repo.recorded, malformed: repo.malformed, missing: repo.missing },
      slowestTestFiles: [...files].sort((a, b) => b.medianMs - a.medianMs).slice(0, LISTED_FILES),
      growingTestFiles: growing,
      testFilesOverBudget: overBudget,
      audit: [...audits].find(([repo]) => repositoryKey(repo) === repositoryKey(name))?.[1] ?? null,
    };
  }).sort((a, b) => a.repo.localeCompare(b.repo));
}

/** Project terminal pipeline metrics from runner evidence, per repository and operation kind; `repo` narrows to one. */
export function pipelineMetrics(events: readonly StoredEvent[], since: string, options: { repo?: string; now?: number } = {}): PipelineMetrics {
  const now = options.now ?? Date.now();
  const only = options.repo === undefined ? undefined : repositoryKey(options.repo);
  const histories = new Map([...operationHistory(events)].filter(([, op]) => !only || (op.submitted && repositoryKey(op.submitted.repo) === only)));
  const threshold = Date.parse(since);
  const selected = [...histories.values()].filter((op) => op.submittedEvent && Number.isFinite(threshold) && eventTime(op.submittedEvent) >= threshold);
  const causes = Object.fromEntries(["gate", "conflict", "infrastructure", "policy", "killed", "paused_out", "held", "superseded", "cancelled"].map((cause) => [cause, 0])) as Record<CauseClass, number>;
  const outcomes: Record<string, number> = {};
  type Group = { repo: string; kind: Operation["kind"]; operations: number; outcomes: Record<string, number>; stages: Map<RunnerStage, number[]>; commands: Map<string, number[]>; total: number[]; paused: number[]; active: number[] };
  const groups = new Map<string, Group>();
  const windows = pauseWindows(events);
  const attemptsByChange = new Map<string, { repo: string; changeId: string; operations: OperationHistory[] }>();
  const push = <K>(map: Map<K, number[]>, key: K, value: number) => { const values = map.get(key) ?? []; values.push(value); map.set(key, values); };

  for (const op of selected) {
    const rows = op.events;
    const submittedRow = op.submittedEvent!;
    const submitted = op.submitted!;
    const kind = operationKind(submitted);
    const groupKey = JSON.stringify([submitted.repo, kind]);
    const group: Group = groups.get(groupKey) ?? { repo: submitted.repo, kind, operations: 0, outcomes: {}, stages: new Map(), commands: new Map(), total: [], paused: [], active: [] };
    groups.set(groupKey, group);
    group.operations++;
    const terminal = rows.find((row) => isTerminal(row.event.type));
    const outcome = terminal?.event.type ?? "open";
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    group.outcomes[outcome] = (group.outcomes[outcome] ?? 0) + 1;
    for (const row of rows) {
      if (row.event.type === "classified") causes[row.event.cause]++;
      if (row.event.type === "stage_detail" && row.event.migrateDurationMs === undefined && row.event.pushDurationMs === undefined && validDuration(row.event.durationMs))
        push(group.stages, row.event.stage, row.event.durationMs);
    }

    const firstStage = rows.find((row) => row.event.type === "stage" && row.event.stage !== "queued");
    const start = eventTime(submittedRow);
    const end = firstStage ? eventTime(firstStage) : terminal ? eventTime(terminal) : Number.NaN;
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      const total = end - start;
      const paused = Math.min(total, pausedOverlap(start, end, windows));
      const active = Math.max(0, total - paused);
      group.total.push(total); group.paused.push(paused); group.active.push(active);
      push(group.stages, "queued", active);
    }

    const starts = new Map<string, string>();
    for (const row of rows) if (row.event.type === "run_started") starts.set(row.event.runId, row.event.command);
    for (const row of rows) {
      if (row.event.type !== "run_finished" || !validDuration(row.event.durationMs)) continue;
      const command = starts.get(row.event.runId);
      if (command) push(group.commands, command, row.event.durationMs);
    }

    if (isLandingSubmission(submitted)) {
      const key = JSON.stringify([submitted.repo, submitted.changeId]);
      const change = attemptsByChange.get(key) ?? { repo: submitted.repo, changeId: submitted.changeId, operations: [] };
      change.operations.push(op);
      attemptsByChange.set(key, change);
    }
  }

  const attempts = [...attemptsByChange.values()].map((group) => {
    const history = [...histories.values()].filter((op) => isLandingSubmission(op.submitted) && op.submitted.repo === group.repo && op.submitted.changeId === group.changeId).sort((a, b) => a.submittedEvent!.seq - b.submittedEvent!.seq);
    const landedAt = history.findIndex((op) => op.events.some((row) => row.event.type === "landed"));
    const throughLanded = history.slice(0, landedAt < 0 ? undefined : landedAt + 1);
    return { repo: group.repo, changeId: group.changeId, operationIds: throughLanded.map((op) => op.id), attempts: throughLanded.length, landed: landedAt >= 0 };
  }).sort((a, b) => a.repo.localeCompare(b.repo) || a.changeId.localeCompare(b.changeId));

  const heldGroups = new Map<string, StoredEvent[]>();
  for (const row of events) {
    if (row.event.type !== "held" || (only && repositoryKey(row.event.repo) !== only)) continue;
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

  return {
    since,
    operations: selected.length,
    outcomes,
    causes,
    groups: [...groups.values()].map((group): OperationGroupMetrics => ({
      repo: group.repo, kind: group.kind, operations: group.operations, outcomes: group.outcomes,
      stages: Object.fromEntries([...group.stages].map(([stage, values]) => [stage, timing(values)!])),
      queue: { total: timing(group.total), activeWait: timing(group.active), paused: timing(group.paused) },
      commands: Object.fromEntries([...group.commands].map(([command, values]) => [command, timing(values)!])),
    })).sort((a, b) => a.repo.localeCompare(b.repo) || a.kind.localeCompare(b.kind)),
    repositories: repositoryMetrics(histories, threshold, now, auditSummariesFromEvents(events, new Date(now))),
    flakes: flakeCandidates(histories, threshold),
    attempts,
    held,
    workspaceStarts: workspaceStarts(events, threshold).filter((entry) => !only || repositoryKey(entry.repo) === only),
  };
}

const formatTiming = (value: MetricTiming | null | undefined): string => value
  ? `${value.samples} samples, median ${Math.round(value.medianMs)}ms, p90 ${Math.round(value.p90Ms)}ms`
  : "no samples";
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** Render a concise terminal summary of the measured pipeline evidence. */
export function formatPipelineMetrics(metrics: PipelineMetrics): string {
  const lines = [`Pipeline metrics since ${metrics.since}`, `${metrics.operations} operations`];
  lines.push(`Outcomes: ${Object.entries(metrics.outcomes).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${name} ${count}`).join(", ") || "none"}`);
  lines.push(`Causes: ${Object.entries(metrics.causes).filter(([, count]) => count > 0).map(([name, count]) => `${name} ${count}`).join(", ") || "none"}`);
  for (const group of metrics.groups) {
    lines.push(`${group.repo} ${group.kind}: ${group.operations} operations (${Object.entries(group.outcomes).sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => `${name} ${count}`).join(", ")})`);
    lines.push(`  Queue: total ${formatTiming(group.queue.total)}; active ${formatTiming(group.queue.activeWait)}; paused ${formatTiming(group.queue.paused)}`);
    lines.push(`  Stages: ${Object.entries(group.stages).map(([name, value]) => `${name} ${formatTiming(value)}`).join("; ") || "no samples"}`);
    lines.push(`  Commands: ${Object.entries(group.commands).map(([name, value]) => `${name} ${formatTiming(value)}`).join("; ") || "no samples"}`);
  }
  for (const repo of metrics.repositories) {
    lines.push(`${repo.repo} budget: ${repo.budget.status}${repo.budget.over.length ? ` (${repo.budget.over.join(", ")})` : ""}; landing verify over 7 days ${formatTiming(repo.verify)}${repo.budgets ? `; budgets ${JSON.stringify(repo.budgets)}` : ""}`);
    lines.push(`  Test reports: ${repo.reports.recorded} recorded, ${repo.reports.malformed} malformed, ${repo.reports.missing} missing`);
    if (repo.audit) {
      const { lastGreen, overdue, openFailure, escapes } = repo.audit;
      lines.push(`  Audit: last green ${lastGreen ? `${lastGreen.commit.slice(0, 12)} at ${lastGreen.finishedAt}` : "never"}${overdue ? " (overdue)" : ""}; ${openFailure ? `failing since ${openFailure.since}, ${openFailure.suspects.length} suspects, cause ${openFailure.cause ? openFailure.cause.kind : "not recorded"}` : "no open failure"}; ${escapes} escapes`);
    }
    if (repo.slowestTestFiles.length) lines.push(`  Slowest test files: ${repo.slowestTestFiles.map((file) => `${file.kind} ${file.file} ${seconds(file.medianMs)}`).join("; ")}`);
    if (repo.growingTestFiles.length) lines.push(`  Growing test files: ${repo.growingTestFiles.map((file) => `${file.kind} ${file.file} ${seconds(file.earlierMedianMs)} → ${seconds(file.laterMedianMs)}`).join("; ")}`);
    if (repo.testFilesOverBudget.length) lines.push(`  Test files over budget: ${repo.testFilesOverBudget.map((file) => `${file.kind} ${file.file} ${seconds(file.medianMs)}`).join("; ")}`);
  }
  lines.push(`Flake candidates: ${metrics.flakes.length ? metrics.flakes.map((candidate) => `${candidate.test} (${candidate.confirmed ? "confirmed" : "candidate"}; ${candidate.changes.length} changes; ${candidate.command}${candidate.fileSet ? `; fileSet ${candidate.fileSet}` : ""}${candidate.retriedPass ? `; passed on retry ${candidate.retriedPass.operationId}` : ""})`).join("; ") : "none"}`);
  lines.push(`Attempts: ${metrics.attempts.length ? metrics.attempts.map((attempt) => `${attempt.repo}/${attempt.changeId} ${attempt.attempts}${attempt.landed ? " until landed" : " open"}`).join("; ") : "none"}`);
  lines.push(`Held integrations: ${metrics.held.length ? metrics.held.map((entry) => `${entry.repo}/${entry.commitId} retries ${entry.retries}, ${entry.durationMs}ms, ${entry.published ? "published" : "unpublished"}`).join("; ") : "none"}`);
  lines.push(`Workspace starts: ${metrics.workspaceStarts.length ? metrics.workspaceStarts.map((entry) => `${entry.repo} on ${entry.machine} ${entry.starts} starts, ${entry.poolHits} from the pool, claim median ${Math.round(entry.claim.medianMs)}ms, p90 ${Math.round(entry.claim.p90Ms)}ms, median ${entry.medianSpares} spares at start${Object.keys(entry.steps).length ? ` (step medians: ${Object.entries(entry.steps).map(([step, ms]) => `${step} ${Math.round(ms)}ms`).join(", ")})` : ""}`).join("; ") : "none"}`);
  return lines.join("\n");
}
