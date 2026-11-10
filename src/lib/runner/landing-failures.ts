import { repositoryKey } from "./runner-contract.ts";
import type { ClassifiedFact, OperationEvent, StoredEvent } from "./runner-types.ts";

/**
 * Why a landing attempt failed, read across attempts (YS-1305), for someone asking whether a failure was the change's:
 * - `conflict`: the rebase onto the integration branch conflicted, the author's to resolve.
 * - `infrastructure`: the runner, a remote, a host or the base moving under the gate, never the source.
 * - `flake`: the same source landed later (the changed files' content identical, `source_identity`), or every error
 *   the gate named was a timeout and the same change landed later.
 * - `catchable`: a static check (format, lint, design lint, type check, architecture and name rules, the runner's
 *   policy refusal) failed, which a check before submission can run on the change's own files.
 * - `gate`: anything else, a defect only the gate's tests found: the gate doing its job.
 * The first that applies wins, in that order. `unnamed` marks a gate failure that names no test and no compiler or
 * lint location, which the author cannot act on without reading the log.
 */
export type LandingFailureClass = "conflict" | "infrastructure" | "flake" | "catchable" | "gate";
export const LANDING_FAILURE_CLASSES: readonly LandingFailureClass[] = ["flake", "catchable", "gate", "infrastructure", "conflict"];

export type LandingFailure = { operationId: string; changeId: string; submittedAt: string; class: LandingFailureClass; evidence: string; unnamed: boolean };
export type LandingFailureReport = {
  repo: string;
  /** Landing submissions in the window; `failed` counts those whose outcome was a failure. */
  attempts: number; landed: number; failed: number; declined: number; cancelled: number; open: number;
  firstSubmittedAt: string | null; lastSubmittedAt: string | null;
  byClass: Record<LandingFailureClass, number>;
  unnamed: number;
  /** Failures other than conflicts, as a share of attempts with an outcome. */
  failureRate: number | null;
  failures: LandingFailure[];
  /** Landing preflights recorded in the same window (by when they ran), with each refusal's last line. */
  preflight: { passed: number; refused: number; refusals: { at: string; workspace: string; commitId: string; reason: string }[] };
};

type Attempt = { id: string; repo: string; changeId: string; commitId: string; at: string; identity?: string; outcome?: OperationEvent; classified?: ClassifiedFact };

/**
 * A check that reads source without running it, named by a failed check's command or by a cause the gate named for its
 * failure (never by a logged line, which a passing check may print). Its failure is one a check before submission can see.
 */
const STATIC_CAUSE = /typecheck failed|\berror TS\d+|Formatting issues|Architecture check failed|Docs index check failed|check:[\w:-]*names\b[^\n]*exited/i;
const STATIC_COMMAND = /\b(?:lint|format|typecheck|check:(?:design|placement|landing))\b/;
const TIMEOUT = /\b(?:timed out in \d+ ?ms|TimeoutError|Hook timed out)\b/i;
const MOVED = /\bparent moved during verification\b|\bpredecessor invalidated\b/i;
/**
 * What lets an author act without the log: a location (`path:line`, `path(line,col)`; a lint report's bare `line:col  error` names no file),
 * a thrown error's message, or a rule check's named finding. The gate's own "suite failed without a named test" is none.
 */
const NAMED = /[\w./[\]-]+\.(?:[cm]?[jt]sx?|svelte|sql|json|py)(?::\d+|\(\d+,\d+\)|\b)|\b(?:[A-Z]\w*Error|error TS\d+|Error)\b: \S|failed: - \S/m;
// The gate's own count; a line that only echoes the failed command; and a lint report's bare `line:col  error` line, whose
// message may name the shared component's source but never the file the error is in.
const UNNAMED_SUMMARY = /without a named test|Related landing tests failed|^\s*(?:\$ |Required verification failed|\d+:\d+\s+error\s)/;

const text = (attempt: Attempt): string => {
  const fact = attempt.classified;
  const reason = attempt.outcome?.type === "failed" ? attempt.outcome.reason : "";
  return [reason, ...fact?.failureCauses ?? [], ...fact?.diagnostics ?? [], ...(fact?.firstErrors ?? []).map(({ error }) => error)].join("\n");
};
const firstLine = (value: string): string => (value.split("\n").map((line) => line.trim()).find(Boolean) ?? "").slice(0, 300);

function classify(attempt: Attempt, landedLater: (attempt: Attempt, sameSource: boolean) => boolean): Omit<LandingFailure, "operationId" | "changeId" | "submittedAt"> {
  const fact = attempt.classified;
  const reason = attempt.outcome?.type === "failed" ? attempt.outcome.reason : "";
  const all = text(attempt);
  const named = fact?.failingTests.length ? `${fact.failingTests.length} failing: ${fact.failingTests[0]}` : firstLine(fact?.failureCauses?.[0] ?? reason);
  const unnamed = (failure: LandingFailureClass) => failure !== "conflict" && failure !== "infrastructure" && fact?.cause !== "policy"
    && !fact?.failingTests.length && !fact?.firstErrors?.length
    && ![...fact?.failureCauses ?? [], ...fact?.diagnostics ?? []].some((line) => !UNNAMED_SUMMARY.test(line) && NAMED.test(line));
  const is = (failure: LandingFailureClass, evidence: string) => ({ class: failure, evidence, unnamed: unnamed(failure) });
  if (fact?.cause === "conflict") return is("conflict", firstLine(reason));
  const migration = reason.startsWith("Migration command failed");
  if (fact?.cause === "policy") return is("catchable", firstLine(reason));
  if (fact?.cause !== "gate" && !migration) return is("infrastructure", firstLine(reason));
  if (MOVED.test(all)) return is("infrastructure", firstLine(all.match(MOVED)![0]));
  if (landedLater(attempt, true)) return is("flake", `the same source landed later; ${named}`);
  const staticCheck = (fact?.failureCauses ?? []).map((cause) => STATIC_CAUSE.exec(cause)?.[0]).find(Boolean)
    ?? [...(fact?.checks ?? []).map((check) => check.command), ...fact?.command ? [fact.command] : []].find((command) => STATIC_COMMAND.test(command));
  if (staticCheck) return is("catchable", `${staticCheck.trim()}; ${named}`);
  const errors = [...(fact?.firstErrors ?? []).map(({ error }) => error), ...fact?.failureCauses ?? []];
  if ((errors.length ? errors.every((error) => TIMEOUT.test(error)) : TIMEOUT.test(all)) && landedLater(attempt, false))
    return is("flake", `timed out, and the change landed later; ${named}`);
  return is("gate", named);
}

/**
 * Classify every landing submitted to `repo` from `since` (inclusive), until `until` (exclusive) or the first `first`
 * submissions. Evidence of a later landing is read from every event given, so a failure near the window's end is judged
 * by what happened after it.
 */
export function landingFailures(events: readonly StoredEvent[], repo: string, window: { since: string; until?: string; first?: number }): LandingFailureReport {
  const key = repositoryKey(repo);
  const attempts = new Map<string, Attempt>();
  const clientRepos = new Map<string, string>();
  const preflights: { at: string; fact: Extract<OperationEvent, { type: "client" }>["fact"] }[] = [];
  for (const row of [...events].sort((a, b) => a.seq - b.seq)) {
    const event = row.event;
    if (event.type === "client_operation") { clientRepos.set(row.operationId, repositoryKey(event.repo)); continue; }
    if (event.type === "client") {
      if (event.fact.kind === "preflight" && clientRepos.get(row.operationId) === key) preflights.push({ at: row.at, fact: event.fact });
      continue;
    }
    if (event.type === "submitted") {
      if ((event.kind === undefined || event.kind === "landing") && "changeId" in event && repositoryKey(event.repo) === key)
        attempts.set(row.operationId, { id: row.operationId, repo: key, changeId: event.changeId, commitId: event.commitId, at: row.at });
      continue;
    }
    const attempt = attempts.get(row.operationId);
    if (!attempt) continue;
    if (event.type === "source_identity") attempt.identity = event.digest;
    else if (event.type === "classified") attempt.classified = event;
    else if (["landed", "failed", "declined", "cancelled", "superseded"].includes(event.type)) attempt.outcome ??= event;
  }
  const ordered = [...attempts.values()].sort((a, b) => a.at.localeCompare(b.at));
  const landed = ordered.filter((attempt) => attempt.outcome?.type === "landed");
  const landedLater = (attempt: Attempt, sameSource: boolean) => landed.some((other) => other.at > attempt.at && (sameSource
    ? (attempt.identity && other.identity ? attempt.identity === other.identity : attempt.commitId === other.commitId)
    : other.changeId === attempt.changeId));
  let selected = ordered.filter((attempt) => attempt.at >= window.since && (!window.until || attempt.at < window.until));
  if (window.first !== undefined) selected = selected.slice(0, window.first);
  const count = (type: string) => selected.filter((attempt) => attempt.outcome?.type === type).length;
  const failures = selected.filter((attempt) => attempt.outcome?.type === "failed")
    .map((attempt): LandingFailure => ({ operationId: attempt.id, changeId: attempt.changeId, submittedAt: attempt.at, ...classify(attempt, landedLater) }));
  const byClass = Object.fromEntries(LANDING_FAILURE_CLASSES.map((failure) => [failure, failures.filter((entry) => entry.class === failure).length])) as Record<LandingFailureClass, number>;
  const inWindow = preflights.filter(({ at }) => at >= window.since && (window.until ? at < window.until : !window.first || !selected.length || at <= (selected.at(-1)?.at ?? at)));
  const refusals = inWindow.flatMap(({ at, fact }) => fact.kind === "preflight" && fact.outcome === "refused"
    ? [{ at, workspace: fact.workspace, commitId: fact.commitId, reason: fact.reason ?? "" }] : []);
  const ended = selected.filter((attempt) => attempt.outcome && attempt.outcome.type !== "superseded").length;
  return {
    repo: key, attempts: selected.length, landed: count("landed"), failed: failures.length, declined: count("declined"), cancelled: count("cancelled"),
    open: selected.filter((attempt) => !attempt.outcome).length,
    firstSubmittedAt: selected[0]?.at ?? null, lastSubmittedAt: selected.at(-1)?.at ?? null,
    byClass, unnamed: failures.filter((entry) => entry.unnamed).length,
    failureRate: ended ? (failures.length - byClass.conflict) / ended : null,
    failures,
    preflight: { passed: inWindow.length - refusals.length, refused: refusals.length, refusals },
  };
}

export function formatLandingFailures(report: LandingFailureReport): string {
  const percent = report.failureRate === null ? "no outcomes yet" : `${(report.failureRate * 100).toFixed(1)}% failed other than on a conflict`;
  return [
    `${report.repo} landings submitted ${report.firstSubmittedAt ?? "-"} to ${report.lastSubmittedAt ?? "-"}: ${report.attempts} attempts, ${report.landed} landed, ${report.failed} failed, ${report.declined} declined, ${report.cancelled} cancelled, ${report.open} still open; ${percent}`,
    `Failures by class: ${LANDING_FAILURE_CLASSES.map((failure) => `${failure} ${report.byClass[failure]}`).join(", ")}; ${report.unnamed} named no test or location`,
    `Landing preflight: ${report.preflight.passed} passed, ${report.preflight.refused} refused before submission`,
    ...report.preflight.refusals.map((refusal) => `  ${refusal.at} preflight refused ${refusal.commitId.slice(0, 12)} in ${refusal.workspace}: ${refusal.reason}`),
    ...report.failures.map((failure) => `  ${failure.submittedAt} ${failure.operationId} ${failure.class}${failure.unnamed ? " (unnamed)" : ""}: ${failure.evidence}`),
  ].join("\n");
}
