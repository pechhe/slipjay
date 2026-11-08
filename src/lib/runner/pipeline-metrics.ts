import { batchMetrics, formatBatchMetrics, type BatchMetrics } from "./batch-metrics.ts";
import { START_STEPS, type StartStep } from "../workspace/start-steps.ts";
import { isLandingSubmission, repositoryKey, RUNNER_CONTROL_ID } from "./runner-contract.ts";
import type { CauseClass, GatePlacement, Operation, OperationEvent, RunnerStage, StoredEvent } from "./runner-types.ts";
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
  /**
   * Gates on a remote verifier: how long each machine took to hold the candidate and the time attempts held it. `dollars`
   * is what the provider billed the machines between their first and last reading in the window, idle time included,
   * or null when any reading is missing; `estimatedDollars` prices only the attempts' own time.
   */
  remote?: { attempts: number; setup: MetricTiming | null; machineMs: number; dollars: number | null; estimatedDollars: number;
    /**
     * The same attempts split by where their gate was placed (SJ-189): setup is opening to the candidate held and
     * installed, gate is from then to the gate's end. Host attempts bill nothing, so `machineMs` and the dollars are boat's.
     */
    fallbacks?: Record<string, number>;
    placements: Partial<Record<GatePlacement, { attempts: number; setup: MetricTiming | null; gate: MetricTiming | null }>>;
    /** The VM seconds boat billed the gate pool between each machine's first and last reading in the window; null when any reading is missing. */
    boatVmSeconds: number | null };
};

/** boat.dev's price of a default (4 vCPU) VM hour, and each size's multiple of it (boat billing, Oct 2026). */
export const BOAT_VM_HOUR_DOLLARS = 0.036;
const BOAT_SIZE_RATE: Record<string, number> = { small: 0.5, default: 1, large: 2, xlarge: 0.2 / BOAT_VM_HOUR_DOLLARS };

/** A test file's executed (passed or failed, never skipped) durations in one operation kind: a landing's related run and the audit's complete one are never pooled. */
export type TestFileMetric = { kind: Operation["kind"]; file: string; suite: string; samples: number; medianMs: number; p90Ms: number };
export type TestFileGrowth = { kind: Operation["kind"]; file: string; suite: string; earlierMedianMs: number; laterMedianMs: number; samples: number };
/** A budget is judged only on enough samples; `over` names each budget the window broke. */
export type BudgetStatus = { status: "undeclared" | "insufficient-samples" | "within" | "over"; over: string[] };

/** One repository's landing health: verify time against its budgets, and its test files. */
export type LandingTimes = { published: MetricTiming | null; failed: number; relanded: number };
export type RepositoryMetrics = {
  repo: string;
  budgets: TimeBudgets | null;
  /** Wall-clock verifying stage of landings whose checks ran, over the budget window ending now. */
  verify: MetricTiming | null;
  /** The same verify stage split by how the gate chose its tests: a related run is a representative landing. */
  verifyBySelection: { related: MetricTiming | null; complete: MetricTiming | null };
  /**
   * Where those landings' gates spent their time, from the timing a gate wrote into its report manifest: how often
   * each suite was the critical one (finished last) with its median serial tail, and the gate's wait for its CPU lock.
   */
  gateCriticalPath: { timed: number; suites: Array<{ suite: string; landings: number; serialTail: MetricTiming | null }>; lockWait: MetricTiming | null };
  budget: BudgetStatus;
  /**
   * Landings submitted in the report window, from submission to publication (SJ-200), split by how the gate chose its
   * tests, whether the change touched migration trigger paths, and where its last gate ran. `failed` counts those that
   * ended failed or declined, so a fast median cannot hide a slow path that fails.
   */
  submissionToPublication: LandingTimes & {
    bySelection: Record<string, LandingTimes>;
    byMigration: { migrationBearing: LandingTimes; other: LandingTimes };
    byPlacement: Record<string, LandingTimes>;
  };
  /** Gate and audit commands by what their reports said; `missing` counts those that wrote none. */
  reports: { recorded: number; malformed: number; missing: number };
  slowestTestFiles: TestFileMetric[];
  growingTestFiles: TestFileGrowth[];
  /** The files the nightly file-cost run should measure: parallel runs cannot judge their cost, only rank it. */
  costCandidates: TestFileMetric[];
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
  /** Batch checks and the landing gate's time, per repository (`batch-metrics.ts`). */
  batches: BatchMetrics[];
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
/** A file-cost sample is expensive and nightly, so the per-file ceiling is judged on fewer of them. */
export const FILE_COST_MIN_SAMPLES = 5;
/** How many files the file-cost run may be asked to measure: the slowest ones, over half the ceiling first. */
const COST_CANDIDATES = 40;
const LISTED_FILES = 10;
/** A file is growing when its later median is this much over its earlier one, each from enough samples. */
const GROWTH_RATIO = 1.2;
const GROWTH_MIN_SAMPLES = 3;

export const timing = (values: number[]): MetricTiming | null => {
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
  type Failure = { operationId: string; seq: number; at: number; repo: string; changeId: string; source: string; candidate?: string; base?: string; test: string; command: string; fileSet?: string };
  type Pass = { operationId: string; seq: number; repo: string; source: string; candidate?: string; base?: string; command: string; fileSet?: string };
  const failures: Failure[] = [];
  const passes: Pass[] = [];

  for (const op of all.values()) {
    if (!isLandingSubmission(op.submitted)) continue;
    const commandByRun = new Map<string, string>();
    // The tree the gate verified is the candidate rebased onto the base at that point, not the submitted source.
    const verifiedAt = (seq: number): { base: string; candidate?: string } | undefined => {
      const verified = op.events.findLast((row) => row.seq < seq && row.event.type === "verification_base")?.event;
      return verified?.type === "verification_base" ? { base: verified.base, ...(verified.candidate ? { candidate: verified.candidate } : {}) } : undefined;
    };
    for (const row of op.events) if (row.event.type === "run_started") commandByRun.set(row.event.runId, row.event.command);
    for (const row of op.events) {
      if (row.event.type === "classified" && row.event.cause === "gate" && row.event.command) {
        // With per-check facts each test belongs to the command that failed it, and only gate checks count.
        const attributed = row.event.checks?.length
          ? row.event.checks.filter((check) => check.cause === "gate").flatMap((check) => check.failingTests.map((test) => ({ test, command: check.command })))
          : row.event.failingTests.map((test) => ({ test, command: row.event.type === "classified" ? row.event.command! : "" }));
        for (const { test, command } of attributed) failures.push({ operationId: op.id, seq: row.seq, at: eventTime(row), repo: op.submitted.repo, changeId: op.submitted.changeId, source: op.submitted.commitId, ...verifiedAt(row.seq), test, command, ...(op.shape ? { fileSet: op.shape.fileSet } : {}) });
      }
      if (row.event.type !== "run_finished") continue;
      const command = commandByRun.get(row.event.runId);
      if (command && row.event.exitCode === 0 && row.event.signal === null && !row.event.timedOut && !row.event.killed)
        passes.push({ operationId: op.id, seq: row.seq, repo: op.submitted.repo, source: op.submitted.commitId, ...verifiedAt(row.seq), command, ...(op.shape ? { fileSet: op.shape.fileSet } : {}) });
    }
  }

  const latestFailures = new Map<string, Failure[]>();
  for (const failure of failures) {
    const key = JSON.stringify([failure.repo, failure.test, failure.command]);
    const group = latestFailures.get(key) ?? [];
    group.push(failure);
    latestFailures.set(key, group);
  }
  /**
   * The failures are one break the changes shared, not evidence that the test itself varies: every failure ran on
   * the same integration base and no pass of that command happened on it, or the failures span bases with no pass
   * of the command between them, as a base that moves during a rename does. Evidence that confirms a flake
   * outranks this, so the caller checks that first.
   */
  function sharedFailure(group: Failure[]): boolean {
    const [first] = group;
    if (!first) return false;
    const passed = (pass: Pass) => pass.repo === first.repo && pass.command === first.command;
    if (first.base !== undefined && group.every((entry) => entry.base === first.base))
      return !passes.some((pass) => passed(pass) && pass.base === first.base);
    const earliest = Math.min(...group.map((entry) => entry.seq));
    const latest = Math.max(...group.map((entry) => entry.seq));
    return !passes.some((pass) => passed(pass) && pass.seq > earliest && pass.seq < latest);
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
    // The same verified tree passing the same command later: nothing differed. A pass on another candidate shows the base
    // changed, and one with no recorded candidate cannot show the tree was unchanged.
    const retried = group.flatMap((failure) => passes.filter((pass) => pass.seq > failure.seq && pass.operationId !== failure.operationId
      && pass.repo === failure.repo && pass.source === failure.source && pass.command === failure.command
      && failure.candidate !== undefined && pass.candidate === failure.candidate)).sort((a, b) => a.seq - b.seq)[0];
    const allFailures = latestFailures.get(key) ?? group;
    const latestFailureSeq = Math.max(...allFailures.map((entry) => entry.seq));
    const passing = passes.find((pass) => pass.seq > latestFailureSeq && pass.repo === first.repo && pass.command === first.command && pass.fileSet !== undefined && group.some((failure) => failure.fileSet === pass.fileSet));
    const confirmedFailure = passing ? group.find((failure) => failure.fileSet === passing.fileSet) : undefined;
    const confirmed = Boolean((passing && confirmedFailure) || retried);
    if (changes.length < 2 && !retried) continue;
    // A shared break explains the failures without the test varying; only evidence that confirms a flake outranks it.
    if (!confirmed && sharedFailure(group)) continue;
    result.push({
      test: first.test,
      command: first.command,
      confirmed,
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

/**
 * A landing's gate duration when its checks ran: not skipped as a settings landing, not cancelled. A screened landing
 * counts its authoritative rerun when its base moved, and otherwise the screen, which was its gate.
 */
function executedVerify(op: OperationHistory): number | undefined {
  if (!isLandingSubmission(op.submitted)) return undefined;
  if (op.events.some((row) => row.event.type === "verification_skipped" || row.event.type === "cancelled")) return undefined;
  if (!op.events.some((row) => row.event.type === "verification_base")) return undefined;
  const gate = (stage: string) => op.events.find((row) => row.event.type === "stage_detail" && row.event.stage === stage && validDuration(row.event.durationMs));
  const detail = gate("verifying") ?? gate("screening");
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
/** Where a landing's last gate ran, and for a machine place whether it waited for it or took it at once (SJ-200). */
function gatePlacementKind(events: OperationHistory["events"], ready: OperationEvent | undefined): string {
  if (ready?.type !== "remote_verification" || ready.phase !== "ready" || !ready.placement) return "runner";
  if (!ready.placement.startsWith("machine:")) return ready.placement;
  return `${ready.placement} ${events.some((row) => row.event.type === "gate_waited") ? "waited" : "at once"}`;
}

function repositoryMetrics(histories: Map<string, OperationHistory>, since: number, now: number, audits: Map<string, AuditSummary>): RepositoryMetrics[] {
  type Repo = { budgets: TimeBudgets | null; budgetSeq: number; verify: number[]; verifyRelated: number[]; verifyComplete: number[]; timed: number; critical: Map<string, { landings: number; tails: number[] }>; lockWait: number[]; recorded: number; malformed: number; missing: number; files: Map<string, { kind: Operation["kind"]; file: string; suite: string; samples: number[] }>; cost: Map<string, { file: string; suite: string; samples: number[] }> };
  type Times = { published: number[]; failed: number; relanded: number };
  const earlierChanges = new Set<string>();
  const landingTimes = new Map<string, { all: Times; selection: Map<string, Times>; migration: { migrationBearing: Times; other: Times }; placement: Map<string, Times> }>();
  const times = (): Times => ({ published: [], failed: 0, relanded: 0 });
  const timesIn = (map: Map<string, Times>, key: string) => map.get(key) ?? map.set(key, times()).get(key)!;
  const repos = new Map<string, Repo>();
  const repoOf = (name: string): Repo => {
    let repo = repos.get(name);
    if (!repo) { repo = { budgets: null, budgetSeq: -1, verify: [], verifyRelated: [], verifyComplete: [], timed: 0, critical: new Map(), lockWait: [], recorded: 0, malformed: 0, missing: 0, files: new Map(), cost: new Map() }; repos.set(name, repo); }
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
    if (verify !== undefined && submittedAt >= now - BUDGET_WINDOW_MS && submittedAt <= now) {
      repo.verify.push(verify);
      // A landing's selection is what the gate recorded; a v1 report says nothing, so it counts in no split.
      const selection = op.events.find((row) => row.event.type === "test_report" && row.event.status === "recorded" && row.event.selection !== undefined);
      if (selection?.event.type === "test_report" && selection.event.status === "recorded") {
        if (selection.event.selection === "related") repo.verifyRelated.push(verify);
        else if (selection.event.selection === "complete") repo.verifyComplete.push(verify);
      }
      for (const row of op.events) {
        if (row.event.type !== "test_report" || row.event.status !== "recorded" || !row.event.timing) continue;
        const { criticalSuite, serialTailMs, lockWaitMs } = row.event.timing;
        repo.timed++;
        if (criticalSuite) {
          const entry = repo.critical.get(criticalSuite) ?? { landings: 0, tails: [] };
          entry.landings++;
          if (serialTailMs !== undefined) entry.tails.push(serialTailMs);
          repo.critical.set(criticalSuite, entry);
        }
        if (lockWaitMs !== undefined) repo.lockWait.push(lockWaitMs);
      }
    }
    if (!(submittedAt >= since)) continue;
    const kind = operationKind(op.submitted);
    const changeKey = isLandingSubmission(op.submitted) ? `${op.submitted.repo}\0${op.submitted.changeId}` : undefined;
    if (kind === "landing" && submittedAt <= now) {
      const outcome = op.events.find((row) => row.event.type === "landed" || row.event.type === "failed" || row.event.type === "declined");
      if (outcome) {
        const split = landingTimes.get(op.submitted.repo) ?? landingTimes.set(op.submitted.repo, { all: times(), selection: new Map(), migration: { migrationBearing: times(), other: times() }, placement: new Map() }).get(op.submitted.repo)!;
        const report = op.events.find((row) => row.event.type === "test_report" && row.event.status === "recorded" && row.event.selection !== undefined)?.event;
        const shape = op.events.find((row) => row.event.type === "change_shape")?.event;
        const placement = op.events.findLast((row) => row.event.type === "remote_verification" && row.event.phase === "ready")?.event;
        const into = [split.all,
          timesIn(split.selection, report?.type === "test_report" && report.status === "recorded" ? report.selection ?? "unrecorded" : "unrecorded"),
          shape?.type === "change_shape" && shape.migrationBearing ? split.migration.migrationBearing : split.migration.other,
          timesIn(split.placement, gatePlacementKind(op.events, placement))];
        // A relanded change is one whose earlier submission did not publish it.
        const relanded = outcome.event.type === "landed" && changeKey !== undefined && earlierChanges.has(changeKey);
        for (const entry of into) {
          if (outcome.event.type === "landed") entry.published.push(eventTime(outcome) - submittedAt);
          else entry.failed++;
          if (relanded) entry.relanded++;
        }
      }
    }
    if (changeKey) earlierChanges.add(changeKey);
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
  // The per-file budget, like the verify budget, spans its own window: a nightly file-cost run is one sample,
  // and a report window that started this morning would never gather the five a judgement needs.
  for (const op of histories.values()) {
    if (!op.submitted || !op.submittedEvent) continue;
    const repo = repoOf(op.submitted.repo);
    const submittedAt = eventTime(op.submittedEvent);
    if (!(submittedAt >= now - BUDGET_WINDOW_MS && submittedAt <= now)) continue;
    for (const row of op.events) {
      if (row.event.type !== "test_report" || row.event.status !== "recorded") continue;
      for (const file of row.event.files) {
        if (file.suite !== FILE_COST_SUITE || file.status === "skipped") continue;
        const entry = repo.cost.get(file.file) ?? { file: file.file, suite: file.suite, samples: [] };
        entry.samples.push(file.ms);
        repo.cost.set(file.file, entry);
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
    // The per-file budget is judged on the file-cost measurement, where one file runs at a time: a landing's
    // or audit's parallel run is contention, not the file's cost. Its samples span the budget window.
    const costFiles = [...repo.cost.values()].map((entry) => ({ kind: "audit" as const, file: entry.file, suite: entry.suite, ...timing(entry.samples)! }));
    const overBudget = limit === undefined ? [] : costFiles.filter((file) => file.samples >= FILE_COST_MIN_SAMPLES && file.medianMs > limit * 1000).sort((a, b) => b.medianMs - a.medianMs);
    // What to measure next: a file whose parallel median is already past half the ceiling is almost certainly the
    // one to check, and no other listing reaches past the ten slowest.
    const costCandidates = limit === undefined ? [] : files.filter((file) => file.suite !== FILE_COST_SUITE && file.medianMs > (limit * 1000) / 2).sort((a, b) => b.medianMs - a.medianMs).slice(0, COST_CANDIDATES);
    const verify = timing(repo.verify);
    return {
      repo: name, budgets: repo.budgets, verify, verifyBySelection: { related: timing(repo.verifyRelated), complete: timing(repo.verifyComplete) },
      gateCriticalPath: { timed: repo.timed, lockWait: timing(repo.lockWait),
        suites: [...repo.critical].map(([suite, entry]) => ({ suite, landings: entry.landings, serialTail: timing(entry.tails) }))
          .sort((a, b) => b.landings - a.landings || a.suite.localeCompare(b.suite)) },
      budget: budgetStatus(repo.budgets, verify, overBudget.length),
      submissionToPublication: (() => {
        const split = landingTimes.get(name);
        const out = (entry?: Times): LandingTimes => ({ published: timing(entry?.published ?? []), failed: entry?.failed ?? 0, relanded: entry?.relanded ?? 0 });
        const record = (map?: Map<string, Times>) => Object.fromEntries([...map ?? []].sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, out(entry)]));
        return { ...out(split?.all), bySelection: record(split?.selection), byMigration: { migrationBearing: out(split?.migration.migrationBearing), other: out(split?.migration.other) }, byPlacement: record(split?.placement) };
      })(),
      reports: { recorded: repo.recorded, malformed: repo.malformed, missing: repo.missing },
      slowestTestFiles: [...files].sort((a, b) => b.medianMs - a.medianMs).slice(0, LISTED_FILES),
      growingTestFiles: growing,
      costCandidates,
      testFilesOverBudget: overBudget,
      audit: [...audits].find(([repo]) => repositoryKey(repo) === repositoryKey(name))?.[1] ?? null,
    };
  }).sort((a, b) => a.repo.localeCompare(b.repo));
}

/** The suite a file-cost measurement writes: one test file at a time, so its durations are the file's own cost. */
export const FILE_COST_SUITE = "file-cost";

/** Project terminal pipeline metrics from runner evidence, per repository and operation kind; `repo` narrows to one. */
export function pipelineMetrics(events: readonly StoredEvent[], since: string, options: { repo?: string; now?: number } = {}): PipelineMetrics {
  const now = options.now ?? Date.now();
  const only = options.repo === undefined ? undefined : repositoryKey(options.repo);
  const histories = new Map([...operationHistory(events)].filter(([, op]) => !only || (op.submitted && repositoryKey(op.submitted.repo) === only)));
  const threshold = Date.parse(since);
  const selected = [...histories.values()].filter((op) => op.submittedEvent && Number.isFinite(threshold) && eventTime(op.submittedEvent) >= threshold);
  const causes = Object.fromEntries(["gate", "conflict", "infrastructure", "policy", "killed", "paused_out", "held", "superseded", "cancelled"].map((cause) => [cause, 0])) as Record<CauseClass, number>;
  const outcomes: Record<string, number> = {};
  type Group = { repo: string; kind: Operation["kind"]; operations: number; outcomes: Record<string, number>; stages: Map<RunnerStage, number[]>; commands: Map<string, number[]>; total: number[]; paused: number[]; active: number[]; remoteSetup: number[]; remoteMs: number; remoteDollars: number; billed: Map<string, number[]>; billedSeconds: Map<string, number[]>; unbilled: number;
    fallbacks: Record<string, number>; placements: Map<GatePlacement, { setup: number[]; gate: number[] }> };
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
    const group: Group = groups.get(groupKey) ?? { repo: submitted.repo, kind, operations: 0, outcomes: {}, stages: new Map(), commands: new Map(), total: [], paused: [], active: [], remoteSetup: [], remoteMs: 0, remoteDollars: 0, billed: new Map(), billedSeconds: new Map(), unbilled: 0, fallbacks: {}, placements: new Map() };
    groups.set(groupKey, group);
    group.operations++;
    const terminal = rows.find((row) => isTerminal(row.event.type));
    const outcome = terminal?.event.type ?? "open";
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    group.outcomes[outcome] = (group.outcomes[outcome] ?? 0) + 1;
    /** The attempt whose gate is running: where it was placed and how long its setup took. */
    let gating: { placement: GatePlacement; setupMs: number; readyAt: number } | undefined;
    for (const row of rows) {
      if (row.event.type === "gate_fallback") { const key = `${row.event.placement}: ${row.event.reason}`; group.fallbacks[key] = (group.fallbacks[key] ?? 0) + 1; }
      if (row.event.type === "classified") causes[row.event.cause]++;
      if (row.event.type === "remote_verification" && (row.event.phase === "ready" || row.event.phase === "failed") && typeof row.event.setupMs === "number" && validDuration(row.event.setupMs)) {
        group.remoteSetup.push(row.event.setupMs);
        const placement = row.event.placement ?? "boat";
        const split = group.placements.get(placement) ?? { setup: [], gate: [] };
        split.setup.push(row.event.setupMs);
        group.placements.set(placement, split);
        if (row.event.phase === "ready") gating = { placement, setupMs: row.event.setupMs, readyAt: eventTime(row) };
      }
      if (row.event.type === "remote_verification" && row.event.phase === "finished" && gating && validDuration(row.event.machineMs) && row.event.machineMs >= gating.setupMs)
        group.placements.get(gating.placement)!.gate.push(row.event.machineMs - gating.setupMs);
      if (row.event.type === "remote_verification" && row.event.phase !== "ready") gating = undefined;
      // A host attempt bills nothing: its events carry no reading, and no reading is missing.
      if (row.event.type === "remote_verification" && row.event.machine.verifier === "boat") {
        for (const reading of row.event.phase === "failed" ? [row.event.usageBefore, row.event.usage] : [row.event.usage]) {
          if (reading) { push(group.billed, row.event.machine.id, reading.dollars); push(group.billedSeconds, row.event.machine.id, reading.seconds); }
          else group.unbilled += 1;
        }
      }
      if (row.event.type === "remote_verification" && row.event.phase === "finished" && row.event.machine.verifier === "boat" && validDuration(row.event.machineMs)) {
        group.remoteMs += row.event.machineMs;
        group.remoteDollars += row.event.machineMs / 3_600_000 * BOAT_VM_HOUR_DOLLARS * (BOAT_SIZE_RATE[row.event.machine.size] ?? 1);
      }
      if (row.event.type === "stage_detail" && row.event.migrateDurationMs === undefined && row.event.pushDurationMs === undefined && validDuration(row.event.durationMs))
        push(group.stages, row.event.stage, row.event.durationMs);
    }

    // A lost executor may leave no finish reading. Its terminal verdict still bounds the gate's time.
    if (gating && terminal && eventTime(terminal) >= gating.readyAt)
      group.placements.get(gating.placement)!.gate.push(eventTime(terminal) - gating.readyAt);

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
      ...group.remoteSetup.length || group.billed.size || group.unbilled || Object.keys(group.fallbacks).length ? { remote: { attempts: group.remoteSetup.length, setup: timing(group.remoteSetup), machineMs: group.remoteMs,
        // A reading boat could not give, or a machine read only once, leaves the window's spend unknown, never $0.
        dollars: billedSpan(group.billed, group.unbilled, 10_000),
        estimatedDollars: Math.round(group.remoteDollars * 10_000) / 10_000,
        fallbacks: group.fallbacks,
        placements: Object.fromEntries([...group.placements].map(([placement, split]) => [placement, { attempts: split.setup.length, setup: timing(split.setup), gate: timing(split.gate) }])),
        boatVmSeconds: billedSpan(group.billedSeconds, group.unbilled, 1) } } : {},
    })).sort((a, b) => a.repo.localeCompare(b.repo) || a.kind.localeCompare(b.kind)),
    repositories: repositoryMetrics(histories, threshold, now, auditSummariesFromEvents(events, new Date(now))),
    flakes: flakeCandidates(histories, threshold),
    attempts,
    held,
    workspaceStarts: workspaceStarts(events, threshold).filter((entry) => !only || repositoryKey(entry.repo) === only),
    batches: batchMetrics(events, threshold, timing, only, now),
  };
}

/** The sum over machines of their last reading less their first, rounded to `1 / scale`; null when any reading is missing or a machine was read once. */
const billedSpan = (readings: Map<string, number[]>, unbilled: number, scale: number): number | null =>
  unbilled || [...readings.values()].some((values) => values.length < 2) ? null
    : Math.round([...readings.values()].reduce((sum, values) => sum + Math.max(...values) - Math.min(...values), 0) * scale) / scale;

const formatTiming = (value: MetricTiming | null | undefined): string => value
  ? `${value.samples} samples, median ${Math.round(value.medianMs)}ms, p90 ${Math.round(value.p90Ms)}ms`
  : "no samples";
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
/** One line of flake evidence: confirmed flakes and candidates are never pooled, so each keeps its own line. */
const flakeLine = (label: string, entries: FlakeCandidate[]): string =>
  `${label}: ${entries.length ? entries.map((candidate) => `${candidate.test} (${candidate.changes.length} changes; ${candidate.command}${candidate.fileSet ? `; fileSet ${candidate.fileSet}` : ""}${candidate.retriedPass ? `; passed on retry ${candidate.retriedPass.operationId}` : ""})`).join("; ") : "none"}`;

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
    if (group.remote) {
      lines.push(`  Remote verifier: ${group.remote.attempts} attempts; setup ${formatTiming(group.remote.setup)}; attempt machine time ${seconds(group.remote.machineMs)} (about $${group.remote.estimatedDollars.toFixed(4)}); ${group.remote.dollars === null ? "billed spend unavailable (boat did not report every reading)" : `billed $${group.remote.dollars.toFixed(4)}, idle time included`}`);
      for (const [reason, count] of Object.entries(group.remote.fallbacks ?? {})) lines.push(`  Gate fallback ${reason}: ${count}`);
      for (const [placement, split] of Object.entries(group.remote.placements))
        if (split) lines.push(`  Gates on ${placement}: ${split.attempts} attempts; setup ${formatTiming(split.setup)}; gate ${formatTiming(split.gate)}`);
      lines.push(`  Boat VM time billed: ${group.remote.boatVmSeconds === null ? "unavailable (boat did not report every reading)" : seconds(group.remote.boatVmSeconds * 1000)}`);
    }
  }
  for (const repo of metrics.repositories) {
    lines.push(`${repo.repo} budget: ${repo.budget.status}${repo.budget.over.length ? ` (${repo.budget.over.join(", ")})` : ""}; landing verify over 7 days ${formatTiming(repo.verify)}${repo.budgets ? `; budgets ${JSON.stringify(repo.budgets)}` : ""}`);
    lines.push(`  Verify by selection: related ${formatTiming(repo.verifyBySelection.related)}; complete ${formatTiming(repo.verifyBySelection.complete)}`);
    const landing = (times: LandingTimes) => `${formatTiming(times.published)}, ${times.failed} failed, ${times.relanded} relanded`;
    const stp = repo.submissionToPublication;
    lines.push(`  Submission to publication: ${landing(stp)}`);
    lines.push(`    by selection: ${Object.entries(stp.bySelection).map(([key, value]) => `${key} ${landing(value)}`).join("; ") || "none"}`);
    lines.push(`    by migration change: migration-bearing ${landing(stp.byMigration.migrationBearing)}; other ${landing(stp.byMigration.other)}`);
    lines.push(`    by placement: ${Object.entries(stp.byPlacement).map(([key, value]) => `${key} ${landing(value)}`).join("; ") || "none"}`);
    if (repo.gateCriticalPath.timed) {
      const { timed, suites, lockWait } = repo.gateCriticalPath;
      lines.push(`  Gate critical path over ${timed} timed gates: ${suites.map(({ suite, landings, serialTail }) => `${suite} ${landings}${serialTail ? ` (serial tail median ${seconds(serialTail.medianMs)})` : ""}`).join("; ") || "none named"}; lock wait ${formatTiming(lockWait)}`);
    }
    lines.push(`  Test reports: ${repo.reports.recorded} recorded, ${repo.reports.malformed} malformed, ${repo.reports.missing} missing`);
    if (repo.audit) {
      const { lastGreen, overdue, openFailure, inconclusive, escapes } = repo.audit;
      lines.push(`  Audit: last green ${lastGreen ? `${lastGreen.commit.slice(0, 12)} at ${lastGreen.finishedAt}` : "never"}${overdue ? " (overdue)" : ""}; ${openFailure ? `failing since ${openFailure.since}, ${openFailure.suspects.length} suspects, cause ${openFailure.cause ? openFailure.cause.kind : "not recorded"}` : "no open failure"}${inconclusive?.audits.length ? `; inconclusive ${inconclusive.audits.join(", ")}` : ""}; ${escapes} escapes`);
    }
    if (repo.slowestTestFiles.length) lines.push(`  Slowest test files: ${repo.slowestTestFiles.map((file) => `${file.kind} ${file.file} ${seconds(file.medianMs)}`).join("; ")}`);
    if (repo.growingTestFiles.length) lines.push(`  Growing test files: ${repo.growingTestFiles.map((file) => `${file.kind} ${file.file} ${seconds(file.earlierMedianMs)} → ${seconds(file.laterMedianMs)}`).join("; ")}`);
    if (repo.testFilesOverBudget.length) lines.push(`  Test files over budget: ${repo.testFilesOverBudget.map((file) => `${file.suite} ${file.file} ${seconds(file.medianMs)}`).join("; ")}`);
    if (repo.costCandidates.length) lines.push(`  Cost candidates: ${repo.costCandidates.length} file(s), slowest ${repo.costCandidates.slice(0, 5).map((file) => `${file.file} ${seconds(file.medianMs)}`).join("; ")}`);
  }
  lines.push(...formatBatchMetrics(metrics.batches ?? []));
  lines.push(flakeLine("Confirmed flakes", metrics.flakes.filter((candidate) => candidate.confirmed)));
  lines.push(flakeLine("Flake candidates", metrics.flakes.filter((candidate) => !candidate.confirmed)));
  lines.push(`Attempts: ${metrics.attempts.length ? metrics.attempts.map((attempt) => `${attempt.repo}/${attempt.changeId} ${attempt.attempts}${attempt.landed ? " until landed" : " open"}`).join("; ") : "none"}`);
  lines.push(`Held integrations: ${metrics.held.length ? metrics.held.map((entry) => `${entry.repo}/${entry.commitId} retries ${entry.retries}, ${entry.durationMs}ms, ${entry.published ? "published" : "unpublished"}`).join("; ") : "none"}`);
  lines.push(`Workspace starts: ${metrics.workspaceStarts.length ? metrics.workspaceStarts.map((entry) => `${entry.repo} on ${entry.machine} ${entry.starts} starts, ${entry.poolHits} from the pool, claim median ${Math.round(entry.claim.medianMs)}ms, p90 ${Math.round(entry.claim.p90Ms)}ms, median ${entry.medianSpares} spares at start${Object.keys(entry.steps).length ? ` (step medians: ${Object.entries(entry.steps).map(([step, ms]) => `${step} ${Math.round(ms)}ms`).join(", ")})` : ""}`).join("; ") : "none"}`);
  return lines.join("\n");
}

/**
 * The repositories whose landings are short: their verify-stage p90 over the budget window, read through
 * `read(since)`, is at or below `p90Ms` from at least `BUDGET_MIN_SAMPLES` samples. Keyed as `repositoryKey`.
 */
export function shortRepositories(read: (since: Date) => StoredEvent[], now: Date, p90Ms: number): ReadonlySet<string> {
  const since = new Date(now.getTime() - BUDGET_WINDOW_MS);
  const repositories = pipelineMetrics(read(since), since.toISOString(), { now: now.getTime() }).repositories;
  return new Set(repositories.filter((entry) => entry.verify && entry.verify.samples >= BUDGET_MIN_SAMPLES && entry.verify.p90Ms <= p90Ms)
    .map((entry) => repositoryKey(entry.repo)));
}
