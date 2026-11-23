/**
 * The batch check of a promotion (SJ-192), apart from where its commands run. `runBatchCheck` runs the complete
 * release verification on the frozen head; a failure is rerun once on the same head, narrowed to what failed, to tell
 * a flaky test from a regression. A regression is the same failure twice: a rerun that fails only tests the first run
 * passed shows the suites unstable, not broken (a loaded machine fails a different timing test each time), so it is
 * flaky too, when both runs name their failing tests and neither list is at its bound. Diagnosis bisects the landings
 * for each key still failing at the head, sharing probes and running only keys whose search windows include the probe.
 * It finds the failing boundary for each key, not every break and repair. A missing suite keeps its earlier state;
 * a probe lost to infrastructure is retried once and, if lost again, leaves the probed keys unknown there.
 *
 * Production's prebuild, when a fixed machine builds for it, is one more suite, `PREBUILD_KEY`: the head's images are
 * built beside its checks, and a failed build is rebuilt once and, if still broken, bisected like any other suite.
 * A prebuild-only probe skips the checks. Unlike a missing test suite, an inconclusive build is unknown: a failed build
 * whose rebuild could not run is `infrastructure`, never flaky, and a green check whose head could not build proves
 * nothing about the build, so the runner never starts a diagnosis after it.
 *
 * Infrastructure (a machine, setup or tooling failure) is never a regression: the check ends `infrastructure` and
 * nothing is diagnosed or routed. Diagnosis never authorises a promotion: its only offer is `shorterCandidate`, the
 * landing before the earliest possible culprit, which the runner promotes only after its own complete batch check passes.
 */

/** A suite's verdict in one run; `missing` when the run's selection does not hold it at that revision. */
export type SuiteState = "passed" | "failed" | "missing";

/** What to rerun: the checks (by index in `requiredReleaseVerification`) that failed and, within them, the failing suites. */
export type BatchScope = { checks: number[]; suites: string[] };

/** One run of the release checks at one commit. */
export type BatchRun =
  | { status: "passed"; suites: Record<string, SuiteState>; setupMs?: number }
  | { status: "failed"; failedChecks: number[]; command: string | null; suites: Record<string, SuiteState>; failingTests: string[]; output: string; prebuildOutput?: string; setupMs?: number }
  | { status: "infrastructure"; reason: string; setupMs?: number };

/** A landing of the batch, in landing order: its published commit and its landing operation. */
export type BatchLanding = { commitId: string; operationId: string };

export type BatchCulprit = BatchLanding & {
  /** The suites (or `check <n>` when the command names none) that started failing at this landing. */
  keys: string[];
  failingTests: string[]; command: string | null; output: string;
};

export type BatchOutcome =
  | { outcome: "green" }
  | { outcome: "flaky"; keys: string[]; failingTests: string[];
      /** Whether the rerun passed and reported every key that failed as passed, rather than failing other tests or skipping one. */
      rerunPassed: boolean }
  | { outcome: "infrastructure"; reason: string }
  | { outcome: "red"; culprits: BatchCulprit[]; shorterCandidate: string | null; keys: string[]; diagnosis: "complete" | "incomplete"; reason?: string;
      /** Failures first seen after a landing diagnosis could not run at: their culprit is one of the landings since `after`. */
      unattributed: { keys: string[]; after: string | null; firstFailing: string }[] };

/** What each run was, for the ledger. */
export type BatchRunRecord = { phase: "complete" | "rerun" | "diagnosis"; commit: string; run: BatchRun; durationMs: number };

const CHECK_KEY = /^check (\d+)$/;
/** The suite key of production's prebuild: whether the commit's deploy can build what it ships. */
export const PREBUILD_KEY = "prebuild";
const checkKey = (index: number) => `check ${index + 1}`;

/** Compare what broke, not the BuildKit step, chunk hash, or measured bundle size. */
export function prebuildFailureSignature(output: string): { target?: string; causes: string[] } | null {
  const target = /\bthe (\S+) image build failed\b/.exec(output)?.[1];
  const causes = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim().replace(/^exited \d+:\s*/, "").replace(/^#\d+\s+[\d.]+\s+/, "");
    if (/^(?:#\d+\s+ERROR:|ERROR: failed to build\b|error: (?:script )?"[^"]+" exited with code|the build's plain-progress output|at\s|Bun v)/.test(line)) continue;
    if (!/\s->\s|\b(?:error(?: TS\d+)?|\w*Error):/i.test(line)) continue;
    const cause = line.replace(/-[A-Za-z0-9_-]{6,}\.js\b/g, "-*.js")
      .replace(/\b\d+(?:[.,]\d+)*\s*(?=(?:[kMGT]i?B|bytes?)\b)/gi, "<n> ")
      .replace(/:\d+(?::\d+)?(?=[:)\s]|$)/g, ":<n>")
      .replace(/\(\d+,\d+\)(?=:\s*error)/g, "(<n>)");
    causes.add(cause);
  }
  return causes.size ? { ...(target ? { target } : {}), causes: [...causes] } : null;
}

export function prebuildFailuresMatch(headOutput: string, probeOutput: string): boolean {
  const head = prebuildFailureSignature(headOutput);
  const probe = prebuildFailureSignature(probeOutput);
  if (!head || !probe) return true; // Old or opaque build logs only have the prebuild verdict.
  return !(head.target && probe.target && head.target !== probe.target)
    && head.causes.every((cause) => probe.causes.includes(cause));
}

/** What failed, as keys a later run can be compared on: the failing suites, else the failing checks themselves. */
export function failureKeys(run: Extract<BatchRun, { status: "failed" }>): string[] {
  const suites = Object.entries(run.suites).filter(([suite, state]) => state === "failed" && suite !== PREBUILD_KEY).map(([suite]) => suite).sort();
  const checks = suites.length ? suites : run.failedChecks.map(checkKey);
  return run.suites[PREBUILD_KEY] === "failed" ? [...checks, PREBUILD_KEY] : checks;
}

/** The scope a rerun of `keys` needs: the checks that failed, narrowed to the failing suites when there are any. */
export function scopeOf(run: Extract<BatchRun, { status: "failed" }>, keys: string[]): BatchScope {
  return { checks: [...run.failedChecks], suites: keys.filter((key) => !CHECK_KEY.test(key)) };
}

/** `key`'s state in `run`: a suite by its own outcome, a check by whether it failed. */
function stateOf(run: Exclude<BatchRun, { status: "infrastructure" }>, key: string): SuiteState {
  const check = CHECK_KEY.exec(key);
  if (check) return run.status === "failed" && run.failedChecks.includes(Number(check[1]) - 1) ? "failed" : "passed";
  return run.suites[key] ?? "missing";
}

export async function runBatchCheck(input: {
  head: string;
  landings: readonly BatchLanding[];
  run: (commit: string, scope: BatchScope | null, phase: BatchRunRecord["phase"]) => Promise<BatchRun>;
  onRun?: (record: BatchRunRecord) => void;
  now?: () => number;
  diagnosisSignal?: AbortSignal;
  diagnosisStopReason?: () => string | null;
  onDiagnosisStart?: () => void;
}): Promise<BatchOutcome> {
  const now = input.now ?? Date.now;
  const timed = async (phase: BatchRunRecord["phase"], commit: string, scope: BatchScope | null): Promise<BatchRun> => {
    const started = now();
    const run = await input.run(commit, scope, phase);
    input.onRun?.({ phase, commit, run, durationMs: now() - started });
    return run;
  };
  const complete = await timed("complete", input.head, null);
  if (complete.status === "passed") return { outcome: "green" };
  if (complete.status === "infrastructure") return { outcome: "infrastructure", reason: complete.reason };
  const keys = failureKeys(complete);
  const scope = scopeOf(complete, keys);
  const rerun = await timed("rerun", input.head, scope);
  if (rerun.status === "infrastructure") return { outcome: "infrastructure", reason: rerun.reason };
  // Whether a test failed in both runs; unknowable, so assumed, when either run names none or either list is at its bound.
  // It is decided for the batch, not per suite: a run names its failing tests without their suites, so one repeated
  // test keeps every suite that failed twice, as before.
  const comparable = (tests: readonly string[]) => tests.length > 0 && tests.length < FAILING_TESTS_LIMIT;
  const repeated = rerun.status !== "failed" || !comparable(complete.failingTests) || !comparable(rerun.failingTests)
    || rerun.failingTests.some((test) => complete.failingTests.includes(test));
  // A build is not a test: a build that fails twice is broken whatever the tests beside it did.
  const still = keys.filter((key) => stateOf(rerun, key) === "failed" && (repeated || key === PREBUILD_KEY));
  // A rebuild that could not run says nothing, so a build that failed once and was not rebuilt is not known to be flaky.
  if (!still.length && keys.includes(PREBUILD_KEY) && stateOf(rerun, PREBUILD_KEY) === "missing")
    return { outcome: "infrastructure", reason: `${PREBUILD_KEY} failed at ${input.head.slice(0, 12)} and its rebuild could not run, so whether it is broken or flaky is unknown` };
  // A suite the rerun did not report (missing) was never run again, so it says nothing: only every failed key passing counts.
  if (rerun.status !== "failed" || !still.length) return { outcome: "flaky", keys, failingTests: complete.failingTests,
    rerunPassed: rerun.status === "passed" && keys.every((key) => stateOf(rerun, key) === "passed") };
  const { landings, head } = input;
  type Unattributed = Extract<BatchOutcome, { outcome: "red" }>["unattributed"][number];
  if (!landings.length) return { outcome: "red", culprits: [], keys: still, diagnosis: "complete", unattributed: [], shorterCandidate: null };

  // The served base passed; the head failed. If the head has no final landing record, use it only as a failing bound.
  const headIndex = landings.at(-1)?.commitId === head ? landings.length - 1 : landings.length;
  const searches = still.map((key) => ({
    key, lo: 0, hi: headIndex, unknowns: new Set<number>(), failingRun: rerun,
  }));
  let incomplete: string | undefined;
  let stopped = false;
  const diagnosisStopped = () => {
    if (!input.diagnosisSignal?.aborted) return false;
    stopped = true;
    incomplete = input.diagnosisStopReason?.() ?? "diagnosis stopped";
    return true;
  };
  input.onDiagnosisStart?.();
  while (!diagnosisStopped()) {
    // Prefer the widest unresolved key (first in key order on ties).
    let widest: typeof searches[number] | undefined;
    let remaining = 0;
    for (const search of searches) {
      const count = search.hi - search.lo - search.unknowns.size;
      if (count > remaining) { widest = search; remaining = count; }
    }
    if (!widest) break;

    const { lo, hi, unknowns } = widest;
    const midpoint = Math.floor((lo + hi - 1) / 2);
    let p = midpoint;
    for (let distance = 0; unknowns.has(p);) {
      distance++;
      const lower = midpoint - distance;
      const upper = midpoint + distance;
      if (lower >= lo && !unknowns.has(lower)) { p = lower; break; }
      if (upper < hi && !unknowns.has(upper)) { p = upper; break; }
    }
    const active = searches.filter((search) => search.lo <= p && p < search.hi && !search.unknowns.has(p));
    const commit = landings[p]!.commitId;
    const probeScope = {
      checks: active.every(({ key }) => key === PREBUILD_KEY) ? [] : scope.checks,
      suites: active.map(({ key }) => key).filter((key) => !CHECK_KEY.test(key)),
    };
    let run = await timed("diagnosis", commit, probeScope);
    if (diagnosisStopped()) break;
    if (run.status === "infrastructure") {
      run = await timed("diagnosis", commit, probeScope);
      if (diagnosisStopped()) break;
    }
    if (run.status === "infrastructure") {
      incomplete ??= `diagnosis could not run at ${commit.slice(0, 12)}: ${run.reason}`;
      for (const search of active) search.unknowns.add(p);
      continue;
    }
    for (const search of active) {
      const verdict = stateOf(run, search.key);
      if (verdict === "failed" && run.status === "failed") {
        if (search.key === PREBUILD_KEY && !prebuildFailuresMatch(rerun.prebuildOutput ?? rerun.output, run.prebuildOutput ?? run.output)) {
          search.lo = p + 1;
        } else {
          search.hi = p;
          search.failingRun = run;
        }
      } else if (verdict === "passed" || (verdict === "missing" && search.key !== PREBUILD_KEY
        && ![...search.unknowns].some((index) => index < p))) {
        search.lo = p + 1;
      } else {
        search.unknowns.add(p);
      }
      for (const index of search.unknowns) if (index < search.lo || index >= search.hi) search.unknowns.delete(index);
    }
  }

  const byLanding = new Map<number, BatchCulprit>();
  const ranges = new Map<string, Unattributed>();
  let earliest = Infinity;
  for (const { key, lo, hi, failingRun } of searches) {
    earliest = Math.min(earliest, lo);
    const landing = landings[hi];
    if (lo < hi || !landing) {
      const after = landings[lo - 1]?.commitId ?? null;
      const firstFailing = landing?.commitId ?? head;
      if (!landing && lo === hi) incomplete ??= `failing head ${head.slice(0, 12)} has no landing record`;
      else if (key === PREBUILD_KEY) incomplete ??= `prebuild was inconclusive at ${landings[lo]!.commitId.slice(0, 12)}`;
      const rangeKey = JSON.stringify([after, firstFailing]);
      const range = ranges.get(rangeKey) ?? { keys: [], after, firstFailing };
      range.keys.push(key);
      ranges.set(rangeKey, range);
    } else {
      const { failingTests, command, output } = failingRun;
      const culprit = byLanding.get(hi) ?? { ...landing, keys: [], failingTests: [], command, output };
      culprit.keys.push(key);
      culprit.failingTests = [...new Set([...culprit.failingTests, ...failingTests])];
      byLanding.set(hi, culprit);
    }
  }
  const culprits = [...byLanding.entries()].sort(([left], [right]) => left - right).map(([, culprit]) => {
    culprit.keys.sort();
    return culprit;
  });
  const unattributed = [...ranges.values()];
  return { outcome: "red", culprits, keys: still, diagnosis: incomplete ? "incomplete" : "complete", unattributed,
    shorterCandidate: !stopped && Number.isFinite(earliest) && earliest > 0 ? input.landings[earliest - 1]!.commitId : null, ...incomplete ? { reason: incomplete } : {} };
}

/**
 * Whether a flaky check verifies its head under `batchVerification.promoteFlaky`: its rerun passed every key that
 * failed, and its images built (in the complete run, or on the rebuild a failed build is given), unless no build
 * belongs to the check. An inconclusive build in the complete run (`complete` undefined) proves nothing, so it refuses.
 */
export function flakyVerifies(outcome: Extract<BatchOutcome, { outcome: "flaky" }>, build: { ran: boolean; complete: SuiteState | undefined }): boolean {
  return outcome.rerunPassed && (!build.ran || build.complete === "passed" || outcome.keys.includes(PREBUILD_KEY));
}

/** Forge's `recordBatchCheck` input: one culprit of one batch, keyed by both, so a replay records nothing twice. */
export type BatchCheckRecord = {
  repository: string; batchId: string; occurredAt: string; startedAt: string; endedAt: string;
  base: string; head: string; culprit: BatchLanding;
  failingTests: string[]; failedSuites: string[]; command: string | null; output: string;
};

/** Forge's bounds on a batch-check record. */
export const BATCH_OUTPUT_BYTES = 16 * 1024;
const bounded = (values: readonly string[], count: number, length: number) => [...new Set(values.map((value) => value.slice(0, length)))].slice(0, count);
/** The last `BATCH_OUTPUT_BYTES` of `output`, where a failure is. */
export function boundedOutput(output: string): string {
  const bytes = Buffer.from(output, "utf8");
  return bytes.byteLength <= BATCH_OUTPUT_BYTES ? output : bytes.subarray(bytes.byteLength - BATCH_OUTPUT_BYTES).toString("utf8").replace(/^�+/, "");
}
/**
 * The most failing tests a `BatchRun` keeps: a list this long may leave tests out. Each run's list is already capped at
 * `failure-classification.ts`'s `MAX_ITEMS` (100), so this must not exceed it, or a list the parser cut short would read
 * as complete and a repeated failure it dropped would make a regression `flaky`.
 */
export const FAILING_TESTS_LIMIT = 100;
export const boundedTests = (tests: readonly string[]) => bounded(tests, FAILING_TESTS_LIMIT, 500);
export const boundedKeys = (keys: readonly string[]) => bounded(keys, 100, 200);
