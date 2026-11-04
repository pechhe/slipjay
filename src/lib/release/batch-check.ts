/**
 * The batch check of a promotion (SJ-192), apart from where its commands run. `runBatchCheck` runs the complete
 * release verification on the frozen head; a failure is rerun once on the same head, narrowed to what failed, to tell
 * a flaky test from a regression; a regression is then diagnosed by rerunning only what failed at each landing's commit,
 * in landing order. Every landing at which a failing suite goes from passing to failing is a culprit, so a batch with
 * two independent regressions names both, and a regression a later landing repaired is still named for the landing
 * that caused it. A suite missing at a revision says nothing about it: the suite keeps the state it last had.
 * A diagnosis step lost to infrastructure is retried once; if it is lost again, every failing suite's state there is
 * unknown, and a suite next seen failing is left unattributed (never blamed on the later landing) and reported as such.
 *
 * Infrastructure (a machine, setup or tooling failure) is never a regression: the check ends `infrastructure` and
 * nothing is diagnosed or routed. Diagnosis never authorises a promotion: its only offer is `shorterCandidate`, the
 * landing before the first culprit, which the runner promotes only after its own complete batch check passes.
 */

/** A suite's verdict in one run; `missing` when the run's selection does not hold it at that revision. */
export type SuiteState = "passed" | "failed" | "missing";

/** What to rerun: the checks (by index in `requiredReleaseVerification`) that failed and, within them, the failing suites. */
export type BatchScope = { checks: number[]; suites: string[] };

/** One run of the release checks at one commit. */
export type BatchRun =
  | { status: "passed"; suites: Record<string, SuiteState>; setupMs?: number }
  | { status: "failed"; failedChecks: number[]; command: string | null; suites: Record<string, SuiteState>; failingTests: string[]; output: string; setupMs?: number }
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
  | { outcome: "flaky"; keys: string[]; failingTests: string[] }
  | { outcome: "infrastructure"; reason: string }
  | { outcome: "red"; culprits: BatchCulprit[]; shorterCandidate: string | null; keys: string[]; diagnosis: "complete" | "incomplete"; reason?: string;
      /** Failures first seen after a landing diagnosis could not run at: their culprit is one of the landings since `after`. */
      unattributed: { keys: string[]; after: string | null; firstFailing: string }[] };

/** What each run was, for the ledger. */
export type BatchRunRecord = { phase: "complete" | "rerun" | "diagnosis"; commit: string; run: BatchRun; durationMs: number };

const CHECK_KEY = /^check (\d+)$/;
const checkKey = (index: number) => `check ${index + 1}`;

/** What failed, as keys a later run can be compared on: the failing suites, else the failing checks themselves. */
export function failureKeys(run: Extract<BatchRun, { status: "failed" }>): string[] {
  const suites = Object.entries(run.suites).filter(([, state]) => state === "failed").map(([suite]) => suite).sort();
  return suites.length ? suites : run.failedChecks.map(checkKey);
}

/** The scope a rerun of `keys` needs: the checks that failed, narrowed to the failing suites when there are any. */
export function scopeOf(run: Extract<BatchRun, { status: "failed" }>, keys: string[]): BatchScope {
  return { checks: [...run.failedChecks], suites: keys.filter((key) => !CHECK_KEY.test(key)) };
}

type KeyState = SuiteState | "unknown";
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
  const still = keys.filter((key) => stateOf(rerun, key) === "failed");
  if (!still.length) return { outcome: "flaky", keys, failingTests: complete.failingTests };
  // Production's served commit passed its own batch check, so every key starts passing.
  const state = new Map<string, KeyState>(still.map((key) => [key, "passed"]));
  const culprits: BatchCulprit[] = [];
  const unattributed: Extract<BatchOutcome, { outcome: "red" }>["unattributed"] = [];
  let incomplete: string | undefined;
  let firstUnknown: number | undefined;
  /** The landing after which each key's state became unknown: the last one known to pass it, or null for the base. */
  const knownBefore = new Map<string, string | null>();
  let lastKnown: string | null = null;
  const diagnosisScope = { checks: scope.checks, suites: still.filter((key) => !CHECK_KEY.test(key)) };
  for (const [index, landing] of input.landings.entries()) {
    // The head itself was just run twice; its landing's state is the rerun's.
    let run = landing.commitId === input.head ? rerun : await timed("diagnosis", landing.commitId, diagnosisScope);
    if (run.status === "infrastructure") run = await timed("diagnosis", landing.commitId, diagnosisScope);
    if (run.status === "infrastructure") {
      incomplete ??= `diagnosis could not run at ${landing.commitId.slice(0, 12)}: ${run.reason}`;
      firstUnknown ??= index;
      for (const key of still) if (state.get(key) !== "unknown") { knownBefore.set(key, lastKnown); state.set(key, "unknown"); }
      continue;
    }
    const started: string[] = [];
    const unknownThen: string[] = [];
    for (const key of still) {
      const now = stateOf(run, key);
      if (now === "missing") continue;
      const before = state.get(key);
      if (now === "failed" && before === "passed") started.push(key);
      if (now === "failed" && before === "unknown") unknownThen.push(key);
      state.set(key, now);
    }
    if (started.length) culprits.push({ ...landing, keys: started,
      failingTests: run.status === "failed" ? run.failingTests : [], command: run.status === "failed" ? run.command : null,
      output: run.status === "failed" ? run.output : "" });
    for (const after of new Set(unknownThen.map((key) => knownBefore.get(key) ?? null)))
      unattributed.push({ keys: unknownThen.filter((key) => (knownBefore.get(key) ?? null) === after), after, firstFailing: landing.commitId });
    lastKnown = landing.commitId;
  }
  // The batch before the earliest landing that may have caused a failure: a named culprit, or one diagnosis could not see.
  const firstCulprit = culprits[0] ? input.landings.findIndex((landing) => landing.commitId === culprits[0]!.commitId) : -1;
  const earliest = Math.min(...[firstCulprit, unattributed.length ? firstUnknown ?? -1 : -1].filter((index) => index >= 0));
  return { outcome: "red", culprits, keys: still, diagnosis: incomplete ? "incomplete" : "complete", unattributed,
    shorterCandidate: Number.isFinite(earliest) && earliest > 0 ? input.landings[earliest - 1]!.commitId : null, ...incomplete ? { reason: incomplete } : {} };
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
export const boundedTests = (tests: readonly string[]) => bounded(tests, 100, 500);
export const boundedKeys = (keys: readonly string[]) => bounded(keys, 100, 200);
