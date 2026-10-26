/** The redacted, bounded record of a failed required check, kept as landing evidence. */
export type RequiredVerificationFailureEvidence = {
  kind: "required_local_verification";
  outcome: "nonzero_exit" | "timeout" | "cancelled" | "signal" | "spawn_failure";
  checkIndex: number;
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Last bytes of redacted stdout; `stdoutTailTruncated` says whether earlier output was dropped. */
  stdoutTail: string;
  stderrTail: string;
  stdoutTailTruncated: boolean;
  stderrTailTruncated: boolean;
  outputSha256: string;
  diagnosticCapture: "selected" | "incomplete" | "unavailable";
  finishedAt: string;
  error?: string;
  /** The runner run that executed this check; absent outside the runner. */
  runId?: string;
  /** Every failed check in declaration order (SJ-51); the first is the one these top-level fields describe. */
  failures: RequiredVerificationCheckFailure[];
  /** Every declared check in declaration order, with what became of it. */
  checks: RequiredVerificationCheckRecord[];
};

/** What became of one declared check in a verification that failed (SJ-51). */
export type RequiredVerificationCheckOutcome = "passed" | "failed" | "timed_out" | "accepted_by_baseline" | "capability_unavailable" | "not_run";

export type RequiredVerificationCheckRecord = {
  checkIndex: number;
  command: string;
  outcome: RequiredVerificationCheckOutcome;
  runId?: string;
  /** Failing tests the summary found, when the check failed and any were found. */
  failingTests?: number;
};

/** One failed check: its own redacted evidence and bounded summary. */
export type RequiredVerificationCheckFailure = Omit<RequiredVerificationFailureEvidence, "failures" | "checks"> & { summary: string };
