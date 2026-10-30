import { OWNER_KILL_REASON } from "./runner-contract.ts";
import type { ClassifiedCheck, ClassifiedFact, FailureEvent, FirstError, Operation, OperationEvent, RunRecord, StoredEvent, VerificationFailureRef } from "./runner-types.ts";
import { diagnostics, failingTests, failureCauses, outputLines, withoutAliases } from "../infra/verification-failure.ts";

export const FAILURE_RULE_VERSION = 2;

const MAX_ITEMS = 100;
const MAX_ITEM_CHARS = 500;
const clip = (value: string): string => value.length > MAX_ITEM_CHARS ? `${value.slice(0, MAX_ITEM_CHARS - 1)}…` : value;
const boundedUnique = (values: string[]): string[] => [...new Set(values.map(clip))].slice(0, MAX_ITEMS);
/** Failing tests merged from several sources (a run's output, its event's, other checks') name each test once. */
const boundedTests = (values: string[]): string[] => boundedUnique(withoutAliases(values));
const boundedErrors = (values: FirstError[]): FirstError[] => {
  const seen = new Set<string>();
  return values.map(({ test, error }) => ({ test: clip(test), error: clip(error) }))
    .filter(({ test }) => !seen.has(test) && Boolean(seen.add(test))).slice(0, MAX_ITEMS);
};
/** The new fields only when present, so a failure that names neither keeps rule 1's shape. */
const named = (firstErrors: FirstError[], failureCauses: string[]) => ({
  ...firstErrors.length ? { firstErrors: boundedErrors(firstErrors) } : {},
  ...failureCauses.length ? { failureCauses: boundedUnique(failureCauses) } : {},
});

/**
 * A gate's own failure summary (README, **Naming a failure**): a `FAIL <file> > <test>` line directly followed by
 * `  first error: <line>` pairs a test with its first error, and `Failure cause: <text>` names a cause that is not a test.
 */
export function failureSummary(lines: string[]): { firstErrors: FirstError[]; failureCauses: string[] } {
  const firstErrors: FirstError[] = [];
  for (const [index, line] of lines.entries()) {
    const test = /^\s*FAIL\s+(.+)$/.exec(line)?.[1];
    const error = test ? /^\s+first error: (.+)$/.exec(lines[index + 1] ?? "")?.[1] : undefined;
    if (test && error) firstErrors.push({ test: test.trim(), error: error.trim() });
  }
  return { firstErrors, failureCauses: failureCauses(lines) };
}

/** Parse concrete verification evidence, keeping persisted identities and diagnostics bounded. */
export function parseFailureOutput(output: string): { failingTests: string[]; diagnostics: string[]; testBodyRan: boolean; firstErrors?: FirstError[]; failureCauses?: string[] } {
  const lines = outputLines({ stdout: output });
  const tests = failingTests(lines);
  const summary = failureSummary(lines);
  const ranMarker = lines.some((line) => {
    const text = line.trim();
    return /^(?:FAIL\s+.+ > |[×✓]\s+.+(?: > |[\d.]+m?s$)|\(fail\)\s+\S|\(pass\)\s+\S|not ok \d+\s+-\s+\S|ok \d+\s+-\s+\S)/.test(text)
      || /^✖\s+.+\s+\([\d.]+m?s\)$/.test(text);
  });
  return {
    failingTests: boundedUnique(tests),
    diagnostics: boundedUnique(diagnostics(lines, MAX_ITEMS)),
    testBodyRan: ranMarker,
    ...named(summary.firstErrors, summary.failureCauses),
  };
}

export type FailureCommandKind = "test" | "lint" | "typecheck" | "install" | "fetch";

/** Ordered, versioned command recognition; earlier entries take precedence. */
export const FAILURE_COMMAND_PATTERNS: readonly { kind: FailureCommandKind; pattern: RegExp }[] = [
  { kind: "fetch", pattern: /^(?:git|jj(?:\s+--[\w=-]+)*\s+git)\s+fetch\b/i },
  { kind: "install", pattern: /^(?:(?:bun|npm|pnpm|yarn)\s+install|npm\s+ci)\b/i },
  { kind: "test", pattern: /\b(?:bun\s+test|npm\s+test|pnpm\s+test|yarn\s+test|vitest|vp\s+test(?:\s+run)?|node\s+--test)\b/i },
  { kind: "lint", pattern: /\b(?:oxlint|lint)\b/i },
  { kind: "typecheck", pattern: /\b(?:typecheck|tsc|svelte-check|check:svelte)\b/i },
];

const commandKind = (command?: string): FailureCommandKind | undefined => command
  ? FAILURE_COMMAND_PATTERNS.find(({ pattern }) => pattern.test(command))?.kind
  : undefined;

const isTimeout = (event: Extract<OperationEvent, { type: "failed" }>, run?: RunRecord & { testBodyRan?: boolean }): boolean =>
  Boolean(run?.timedOut || /\b(?:timed out|timeout|timedout)\b/i.test(`${event.reason}\n${event.output ?? ""}`));

const isExecutorLoss = (event: Extract<OperationEvent, { type: "failed" }>): boolean =>
  /\b(?:spawn(?:ing)?[ _](?:error|failed|failure)|enoent|executor (?:lost|unavailable|disconnected)|connection to executor (?:lost|closed)|worker exited unexpectedly|runner restarted)\b/i
    .test(`${event.reason}\n${event.output ?? ""}`);

/** Classify only facts present in the terminal event and supplied run context. */
export function classifyFailure(
  event: Extract<OperationEvent, { type: "failed" | "declined" | "cancelled" | "superseded" }>,
  context: { paused: boolean; held: boolean; run?: RunRecord & { testBodyRan?: boolean } },
): ClassifiedFact {
  const command = context.run?.command ?? (event.type === "failed" ? event.command : undefined);
  const parsed: ReturnType<typeof parseFailureOutput> = event.type === "failed" && event.output ? parseFailureOutput(event.output) : { failingTests: [], diagnostics: [], testBodyRan: false };
  const fact = (cause: ClassifiedFact["cause"]): ClassifiedFact => ({
    type: "classified",
    ruleVersion: FAILURE_RULE_VERSION,
    cause,
    ...(command ? { command } : {}),
    failingTests: boundedTests([...(context.run?.failingTests ?? []), ...parsed.failingTests]),
    diagnostics: boundedUnique([...(context.run?.diagnostics ?? []), ...parsed.diagnostics]),
    ...named([...(context.run?.firstErrors ?? []), ...(parsed.firstErrors ?? [])], [...(context.run?.failureCauses ?? []), ...(parsed.failureCauses ?? [])]),
  });

  if (event.type === "superseded") return fact("superseded");
  if (event.type === "declined") return fact("policy");
  if (event.type === "cancelled") {
    if (event.reason === OWNER_KILL_REASON) return fact("killed");
    return fact(context.paused ? "paused_out" : "cancelled");
  }
  if (event.reason === OWNER_KILL_REASON) return fact("killed");
  if (event.stage === "rebasing" && event.reason.startsWith("Could not check landing rename safety:")) return fact("infrastructure");
  if (/^(?:late-bound migration artifacts must be generated during landing|declined paths?:)/i.test(event.reason)) return fact("policy");
  if (context.held && ["integrating", "finalizing", "publishing"].includes(event.stage)) return fact("held");
  const verification = event.stage === "verifying" || event.stage === "screening" || context.run?.purpose === "migration_verify";
  if (event.stage === "fetching" || (event.stage === "installing" && !verification) || commandKind(command) === "fetch" || commandKind(command) === "install")
    return fact("infrastructure");
  if (event.stage === "rebasing")
    return fact(/\bconflict(?:s|ed|ing)?\b/i.test(`${event.reason}\n${event.output ?? ""}`) ? "conflict" : "infrastructure");
  if (verification) {
    if (isExecutorLoss(event) || (isTimeout(event, context.run) && !(context.run?.testBodyRan === true || parsed.testBodyRan))) return fact("infrastructure");
    return fact("gate");
  }
  return fact("infrastructure");
}

/** A failed check with the run it was matched to by `runId`. */
export type FailureRun = { failure: VerificationFailureRef; run?: RunRecord };

/**
 * Classify each failed verification check from its own run, then combine: `gate` if any check is a
 * gate failure, `infrastructure` only if all are. Tests and diagnostics merge; `checks` keeps who failed what.
 */
export function classifyVerificationFailures(
  event: Extract<OperationEvent, { type: "failed" }>,
  context: { paused: boolean; held: boolean },
  failures: readonly FailureRun[],
): ClassifiedFact {
  const checks: ClassifiedCheck[] = failures.map(({ failure, run }, position) => {
    // The event's own text names every check (the index), so only the first failure's output and a bare outcome speak for a check.
    const single: Extract<OperationEvent, { type: "failed" }> = { type: "failed", stage: event.stage, command: failure.command,
      reason: failure.outcome === "timeout" ? "timed out" : failure.outcome === "spawn_failure" ? "spawn failed" : "check failed",
      ...position === 0 && event.output ? { output: event.output } : {} };
    const fact = classifyFailure(single, { ...context, ...run ? { run: { ...run, command: failure.command } } : {} });
    return { checkIndex: failure.checkIndex, command: failure.command, cause: fact.cause, ...failure.runId ? { runId: failure.runId } : {},
      failingTests: fact.failingTests, diagnostics: fact.diagnostics, ...named(fact.firstErrors ?? [], fact.failureCauses ?? []) };
  });
  const cause = checks.find((check) => check.cause === "gate")?.cause ?? checks.find((check) => check.cause !== "infrastructure")?.cause ?? "infrastructure";
  return { type: "classified", ruleVersion: FAILURE_RULE_VERSION, cause,
    ...checks[0] ? { command: checks[0].command } : {},
    failingTests: boundedTests(checks.flatMap((check) => check.failingTests)),
    diagnostics: boundedUnique(checks.flatMap((check) => check.diagnostics)),
    ...named(checks.flatMap((check) => check.firstErrors ?? []), checks.flatMap((check) => check.failureCauses ?? [])), checks };
}

/**
 * Classify a terminal failure the way the event log records it: each failed check from the run its `runId`
 * names, otherwise the operation's run of the command (or its last). `operation` and `history` are the
 * operation as projected before the event and the operation's events, so a run's `testBodyRan` is available.
 */
export function classifyEvent(input: {
  event: FailureEvent;
  operation: Operation | null;
  history: StoredEvent[];
  paused: boolean;
  held: boolean;
}): ClassifiedFact {
  const { event, operation, history, paused, held } = input;
  const withBody = (entry: RunRecord & { testBodyRan?: boolean }) => {
    const done = history.findLast((row) => row.event.type === "run_finished" && row.event.runId === entry.runId)?.event;
    return { ...entry, ...(done?.type === "run_finished" ? { testBodyRan: done.testBodyRan } : {}) };
  };
  if (event.type === "failed" && event.failures?.length)
    return classifyVerificationFailures(event, { paused, held }, event.failures.map((failure) => {
      const found = failure.runId ? operation?.runs.find((entry) => entry.runId === failure.runId) : undefined;
      return { failure, ...(found ? { run: withBody(found) } : {}) };
    }));
  const run = operation?.runs.findLast((entry) => event.type === "failed" && entry.command === event.command) ?? operation?.runs.at(-1);
  return classifyFailure(event, { paused, held, ...(run ? { run: withBody(run) } : {}) });
}
