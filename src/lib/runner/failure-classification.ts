import { OWNER_KILL_REASON } from "./runner-contract.ts";
import type { ClassifiedCheck, ClassifiedFact, FailureCategory, FailureEvent, FirstError, Operation, OperationEvent, RunRecord, StoredEvent, VerificationFailureRef } from "./runner-types.ts";
import { diagnostics, failingTests, failureCauses, outputLines, withoutAliases } from "../infra/verification-failure.ts";

/** Rule 3 adds the failure category (`category`): regression, flake, infrastructure, moved base or unresolved. */
export const FAILURE_RULE_VERSION = 3;

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

/** A host's load average above this many runs per CPU, while a check ran, means timeouts there are the host's. */
export const OVERLOAD_PER_CPU = 2;

const MOVED_BASE = /\b(?:predecessor invalidated|invalidated by its predecessor|integration changed|Refusing to move bookmark|parent moved during verification)\b|stale receipt: reviewed .+ onto .+, candidate merges .+ onto /i;
// The runner, a host or a remote broke: named by what the failed event itself says, never by the stage it failed in.
const INFRASTRUCTURE = new RegExp([
  "git fetch failed", "Could not fetch", "Permission denied \\(publickey\\)", "Push of .+ failed", "Exact-parent publication failed",
  "runner restarted", "Remote executor unavailable", "executor lost", "not installed for this candidate", "database or disk is full", "Rate limit exceeded",
  "timed out after \\d+ ?ms", "Pre-verification timed out", "builder stayed paused", "failed to list workers", "transport .*Unavailable",
].join("|"), "i");

/** What the runner itself wrote about a failure: the reason without the captured-output sections (`Failing tests`, `First error`, `Output tail`...) of each check, which a check's own text fills. */
const runnerText = (reason: string): string => {
  let captured = false;
  return reason.split("\n").filter((line) => {
    if (/^Check \d+ \(/.test(line)) captured = false;
    else if (/^(?:Failing tests \(|First error:|First diagnostics:|Locations:|Output tail \()/.test(line)) captured = true;
    return !captured;
  }).join("\n");
};

const firstLine = (text: string): string => clip(text.split("\n").map((line) => line.trim()).find(Boolean) ?? "");
/**
 * Whether an error line is the failing check's own, not a logged line from elsewhere in its output. A summary written
 * before rule 3 printed the first error anywhere in the output, so only a thrown error's `SomeError: message` form is
 * trusted there; rule 3 summaries print the failing test's own block, so any line with words in it is.
 */
const attributable = (line: string, ruleVersion: number): boolean =>
  ruleVersion >= 3 ? /\w{3}.*\w{3}/.test(line) && !/[{[(]$/.test(line) : /^[A-Z]\w*(?:Error|Exception)\b|\berror TS\d+/.test(line);

/** What a failed check's summary names as its error: the line after `First error:`, or after `Failure cause:`. */
export const namedError = (reason: string): string | undefined => {
  const lines = reason.split("\n");
  const at = lines.findIndex((line) => line.trim() === "First error:");
  return at >= 0 ? lines[at + 1]?.trim() || undefined : lines.find((line) => line.startsWith("Failure cause: "))?.slice("Failure cause: ".length).trim();
};

/** A static check (lint, type, build or repository rule) whose own script exited non-zero: `error: script "check:x" exited with code 1`. */
const failedStaticScript = (reason: string): string | undefined => /^error: script "((?:check|lint|typecheck|build)[^"]*)" exited with code (\d+)/m.exec(reason)?.slice(1).join(" exited ");

/**
 * Decide a failed landing's or audit's category (rule 3) from what its own failed event, classification and host
 * load say; anything the evidence does not decide is `unresolved`, never a guess. First match wins:
 * a batch check's own flake finding; a base that moved (rebase conflict, invalidation; the event store adds an earlier
 * pass of the same commit at another base); the runner
 * or a remote breaking (named in the event); tests that timed out on a host loaded past `OVERLOAD_PER_CPU` runs per CPU;
 * a check that fails naming a test, an error or a diagnostic (regression); else unresolved.
 */
export function failureCategory(input: { reason: string; fact: ClassifiedFact; load?: { load1: number; cpus: number } }): FailureCategory {
  const { reason, fact, load } = input;
  const head = firstLine(reason.replace(/^Required verification failed[^\n]*\n(?:Checks:\n(?:\d+\. .*\n?)+)?/, ""));
  const is = (kind: FailureCategory["kind"], evidence: string): FailureCategory => ({ kind, evidence: clip(evidence) });
  if (/\bwas flaky\b/i.test(reason)) return is("flake", firstLine(reason));
  if (fact.cause === "conflict") return is("moved_base", `the rebase onto the moved integration branch conflicted: ${firstLine(reason.split("\n").slice(1).join("\n")) || firstLine(reason)}`);
  if (MOVED_BASE.test(reason)) return is("moved_base", firstLine(reason));
  if (INFRASTRUCTURE.test(runnerText(reason))) return is("infrastructure", firstLine(reason));
  if (fact.cause === "gate") {
    const timedOut = /^Failure: [a-z ]*timeout/m.test(reason);
    const tests = fact.failingTests.length;
    const pick = (line: string | undefined) => line && attributable(line, fact.ruleVersion) ? line : undefined;
    const evidence = (fact.firstErrors?.[0] ? `${fact.firstErrors[0].test}: ${fact.firstErrors[0].error}` : undefined)
      ?? fact.failureCauses?.[0] ?? pick(namedError(reason)) ?? (tests ? undefined : pick(fact.diagnostics[0]) ?? failedStaticScript(reason));
    if (timedOut) {
      return load && load.load1 >= OVERLOAD_PER_CPU * load.cpus
        ? is("infrastructure", `host load ${load.load1.toFixed(1)} on ${load.cpus} CPUs while it verified; ${fact.failingTests.length || "its"} tests timed out`)
        : is("unresolved", `${fact.failingTests.length} tests timed out and the host was not overloaded${load ? ` (load ${load.load1.toFixed(1)} on ${load.cpus} CPUs)` : ""}`);
    }
    if (evidence) return is("regression", evidence);
    return is("unresolved", tests ? `${tests} test${tests === 1 ? "" : "s"} failed and no error is attributable to them` : "a check failed without naming a test, an error or a diagnostic");
  }
  return is("unresolved", head || "the failure names no cause");
}

/** The host load a check ran under: the last health reading taken as verification began. */
export function verifyingLoad(history: readonly StoredEvent[]): { load1: number; cpus: number } | undefined {
  const row = history.findLast((entry) => entry.event.type === "stage" && (entry.event.stage === "verifying" || entry.event.stage === "screening") && entry.event.health);
  return row?.event.type === "stage" && row.event.health ? { load1: row.event.health.load1, cpus: row.event.health.cpus } : undefined;
}

/**
 * The category of an operation's failure: the one its classification recorded (rule 3 on), else the one the rule
 * gives the recorded failure now, so a failure recorded under an earlier rule version reads the same way.
 * Undefined when the operation did not fail or recorded no classification.
 */
export function failureCategoryOf(events: readonly StoredEvent[]): FailureCategory | undefined {
  const failed = events.findLast((row) => row.event.type === "failed")?.event;
  const fact = events.findLast((row) => row.event.type === "classified")?.event;
  if (failed?.type !== "failed" || fact?.type !== "classified") return undefined;
  const load = verifyingLoad(events);
  return fact.category ?? failureCategory({ reason: failed.reason, fact, ...load ? { load } : {} });
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

/** A failed event's classification with its category; declined, cancelled and superseded events are not failures and carry none. */
const categorized = (event: FailureEvent, history: readonly StoredEvent[], fact: ClassifiedFact): ClassifiedFact =>
  event.type === "failed" ? { ...fact, category: failureCategory({ reason: event.reason, fact, load: verifyingLoad(history) }) } : fact;

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
    return categorized(event, history, classifyVerificationFailures(event, { paused, held }, event.failures.map((failure) => {
      const found = failure.runId ? operation?.runs.find((entry) => entry.runId === failure.runId) : undefined;
      return { failure, ...(found ? { run: withBody(found) } : {}) };
    })));
  const run = operation?.runs.findLast((entry) => event.type === "failed" && entry.command === event.command) ?? operation?.runs.at(-1);
  return categorized(event, history, classifyFailure(event, { paused, held, ...(run ? { run: withBody(run) } : {}) }));
}
