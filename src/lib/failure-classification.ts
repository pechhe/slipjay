import { OWNER_KILL_REASON, type ClassifiedFact, type OperationEvent, type RunRecord } from "./runner-contract.ts";
import { diagnostics, failingTests, outputLines } from "./verification-failure.ts";

export const FAILURE_RULE_VERSION = 1;

const MAX_ITEMS = 100;
const MAX_ITEM_CHARS = 500;
const clip = (value: string): string => value.length > MAX_ITEM_CHARS ? `${value.slice(0, MAX_ITEM_CHARS - 1)}…` : value;
const boundedUnique = (values: string[]): string[] => [...new Set(values.map(clip))].slice(0, MAX_ITEMS);

/** Parse concrete verification evidence, keeping persisted identities and diagnostics bounded. */
export function parseFailureOutput(output: string): { failingTests: string[]; diagnostics: string[]; testBodyRan: boolean } {
  const lines = outputLines({ stdout: output });
  const tests = failingTests(lines);
  const ranMarker = lines.some((line) => {
    const text = line.trim();
    return /^(?:FAIL\s+.+ > |[×✓]\s+.+(?: > |[\d.]+m?s$)|\(fail\)\s+\S|\(pass\)\s+\S|not ok \d+\s+-\s+\S|ok \d+\s+-\s+\S)/.test(text)
      || /^✖\s+.+\s+\([\d.]+m?s\)$/.test(text);
  });
  return {
    failingTests: boundedUnique(tests),
    diagnostics: boundedUnique(diagnostics(lines, MAX_ITEMS)),
    testBodyRan: ranMarker,
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
  const parsed = event.type === "failed" && event.output ? parseFailureOutput(event.output) : { failingTests: [], diagnostics: [], testBodyRan: false };
  const fact = (cause: ClassifiedFact["cause"]): ClassifiedFact => ({
    type: "classified",
    ruleVersion: FAILURE_RULE_VERSION,
    cause,
    ...(command ? { command } : {}),
    failingTests: boundedUnique([...(context.run?.failingTests ?? []), ...parsed.failingTests]),
    diagnostics: boundedUnique([...(context.run?.diagnostics ?? []), ...parsed.diagnostics]),
  });

  if (event.type === "superseded") return fact("superseded");
  if (event.type === "declined") return fact("policy");
  if (event.type === "cancelled") {
    if (event.reason === OWNER_KILL_REASON) return fact("killed");
    return fact(context.paused ? "paused_out" : "cancelled");
  }
  if (event.reason === OWNER_KILL_REASON) return fact("killed");
  if (/^(?:late-bound migration artifacts must be generated during landing|declined paths?:)/i.test(event.reason)) return fact("policy");
  if (context.held && ["integrating", "finalizing", "publishing"].includes(event.stage)) return fact("held");
  const verification = event.stage === "verifying" || context.run?.purpose === "migration_verify";
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
