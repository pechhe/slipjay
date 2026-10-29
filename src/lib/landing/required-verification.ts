/** The one runner for a landing's `requiredLandingVerification`, used by the CLI, Pi and the host. */
import { realpath } from "node:fs/promises";
import { runBoundedProcess } from "../infra/bounded-process.ts";
import { checkoutCwd } from "../infra/checkout-cwd.ts";
import { truncateUtf8 } from "../infra/utf8.ts";
import { countFailingTests, FAILED_STREAM_BYTES, redactVerificationOutput, summarizeVerificationFailure } from "../infra/verification-failure.ts";
import { classifyCapabilityProbe, normalizeVerificationDeclaration, runVerificationStages, verificationEvidence, verificationGap } from "../policy/verification-policy.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "../infra/bounded-process.ts";
import type { VerificationDeclaration, VerificationEvidence, VerificationGap } from "../policy/verification-policy.ts";

import type { RequiredVerificationFailureEvidence, RequiredVerificationCheckOutcome, RequiredVerificationCheckRecord, RequiredVerificationCheckFailure } from "../infra/verification-evidence.ts";
export type { RequiredVerificationFailureEvidence, RequiredVerificationCheckOutcome, RequiredVerificationCheckRecord, RequiredVerificationCheckFailure } from "../infra/verification-evidence.ts";

const CHECK_TIMEOUT_MS = 60 * 60_000;
const PROBE_OUTPUT_BYTES = 64 * 1024;
const TAIL_BYTES = 4 * 1024;
const COMMAND_BYTES = 1_000;
const MESSAGE_CAP_CHARS = 24_000;

export class RequiredVerificationError extends Error {
  readonly evidence: RequiredVerificationFailureEvidence;
  /** `summary` names failing tests, the first error or diagnostics, and a short tail. */
  constructor(evidence: RequiredVerificationFailureEvidence, summary?: string) {
    super(`Required verification failed (${evidence.outcome}): ${evidence.command} (check ${evidence.checkIndex + 1})${summary ? `\n${summary}` : ""}`);
    this.name = "RequiredVerificationError";
    this.evidence = evidence;
  }
}

function utf8Tail(value: string, maxBytes: number): string {
  const source = Buffer.from(value, "utf8");
  if (source.length <= maxBytes) return value;
  return source.subarray(source.length - maxBytes).toString("utf8").replace(/^�+/u, "");
}

function outcome(result: BoundedProcessResult): RequiredVerificationFailureEvidence["outcome"] {
  if (result.cancelled) return "cancelled";
  if (result.timedOut) return "timeout";
  if (result.error && result.exitCode === null) return "spawn_failure";
  if (result.signal) return "signal";
  return "nonzero_exit";
}

function failureEvidence(result: BoundedProcessResult, checkIndex: number, command: string, root: string): Omit<RequiredVerificationFailureEvidence, "failures" | "checks"> {
  const stdout = redactVerificationOutput(result.stdout, root);
  const stderr = redactVerificationOutput(result.stderr, root);
  const stdoutTail = utf8Tail(stdout, TAIL_BYTES);
  const stderrTail = utf8Tail(stderr, TAIL_BYTES);
  return {
    kind: "required_local_verification", outcome: outcome(result), checkIndex,
    command: truncateUtf8(redactVerificationOutput(command, root), COMMAND_BYTES),
    exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, cancelled: result.cancelled,
    stdoutTail, stderrTail,
    stdoutTailTruncated: result.stdoutTruncated || Buffer.byteLength(stdoutTail, "utf8") < Buffer.byteLength(stdout, "utf8"),
    stderrTailTruncated: result.stderrTruncated || Buffer.byteLength(stderrTail, "utf8") < Buffer.byteLength(stderr, "utf8"),
    outputSha256: result.outputSha256, finishedAt: result.finishedAt,
    diagnosticCapture: result.diagnosticOutput ? result.diagnosticOutput.incomplete ? "incomplete" : "selected" : "unavailable",
    ...(result.error ? { error: truncateUtf8(redactVerificationOutput(result.error, root), COMMAND_BYTES) } : {}),
    ...(result.runId ? { runId: result.runId } : {}),
  };
}

type CheckResult = {
  record: RequiredVerificationCheckRecord;
  passed?: string;
  gap?: VerificationGap;
  failure?: RequiredVerificationCheckFailure;
  stop?: boolean;
};

const OUTCOME_LABEL: Record<RequiredVerificationCheckOutcome, string> = {
  passed: "passed", failed: "failed", timed_out: "timed out", accepted_by_baseline: "accepted by baseline",
  capability_unavailable: "capability unavailable", not_run: "not run",
};

/** The redacted command of a declaration that may not have run (or even validated). */
function declaredCommand(declared: unknown, root: string): string {
  const { executable, args } = (declared && typeof declared === "object" ? declared : {}) as { executable?: unknown; args?: unknown };
  const text = [executable, ...(Array.isArray(args) ? args : [])].map(String).join(" ");
  return truncateUtf8(redactVerificationOutput(text, root), COMMAND_BYTES);
}

/** The failure reason: the first failure's line, an index of every check, then each summary, within the cap. */
function failureMessage(head: string, records: RequiredVerificationCheckRecord[], failures: RequiredVerificationCheckFailure[]): string {
  const index = records.map((record) => `${record.checkIndex + 1}. ${record.command}: ${OUTCOME_LABEL[record.outcome]}${record.failingTests ? ` (${record.failingTests} failing test${record.failingTests === 1 ? "" : "s"})` : ""}`);
  const blocks = failures.map((failure) => `Check ${failure.checkIndex + 1} (${failure.command}):\n${failure.summary}`);
  const build = (indexCount: number, blockCount: number): string => {
    const omittedLines = index.length - indexCount;
    const omittedBlocks = blocks.length - blockCount;
    const notice = [...(omittedLines ? [`${omittedLines} index ${omittedLines === 1 ? "line" : "lines"}`] : []), ...(omittedBlocks ? [`${omittedBlocks} failure ${omittedBlocks === 1 ? "summary" : "summaries"}`] : [])];
    return [head, "Checks:", ...index.slice(0, indexCount), ...blocks.slice(0, blockCount),
      ...(notice.length ? [`… omitted ${notice.join(" and ")} to stay within ${MESSAGE_CAP_CHARS} characters; the structured failure record is complete.`] : [])].join("\n");
  };
  let blockCount = blocks.length;
  while (blockCount > 0 && build(index.length, blockCount).length > MESSAGE_CAP_CHARS) blockCount -= 1;
  let indexCount = index.length;
  while (indexCount > 0 && build(indexCount, blockCount).length > MESSAGE_CAP_CHARS) indexCount -= 1;
  return build(indexCount, blockCount).slice(head.length + 1);
}

const formatDuration = (ms: number): string => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`);

/**
 * Run the declared checks in the checkout, bounded in time and output. `acceptFailure` may classify a failed check as
 * passing (the host's opt-in unchanged-input baseline); otherwise a failure throws
 * `RequiredVerificationError` with redacted evidence.
 */
export async function runRequiredVerification(input: {
  root: string;
  checks: readonly unknown[];
  environment?: () => NodeJS.ProcessEnv;
  onProgress?: (line: string) => void;
  acceptFailure?: (check: VerificationDeclaration, failure: BoundedProcessResult, environment: NodeJS.ProcessEnv) => Promise<string | null>;
  /** Where each command runs; defaults to a local bounded process. */
  run?: (request: BoundedProcessRequest) => Promise<BoundedProcessResult>;
  /** Once it fires, no later stage is scheduled: a killed check is never followed by another. */
  abortSignal?: AbortSignal;
}): Promise<VerificationEvidence> {
  const { checks, onProgress = () => {}, acceptFailure, run = runBoundedProcess } = input;
  // The real root: commands run at real paths, so redaction must match them.
  const root = await realpath(input.root);
  const environment = (input.environment ?? (() => process.env))();
  const outcomes = await runVerificationStages<{ concurrent?: unknown } | null, CheckResult>(checks as readonly ({ concurrent?: unknown } | null)[], async (declared, index) => {
    if (!declared || typeof declared !== "object") throw new Error("The repository policy contains malformed requiredLandingVerification");
    const check: VerificationDeclaration = normalizeVerificationDeclaration(declared, "requiredLandingVerification");
    const args = check.args.map(String);
    const command = [check.executable, ...args].join(" ");
    const recordCommand = truncateUtf8(redactVerificationOutput(command, root), COMMAND_BYTES);
    // Both directories are contained before anything in this check runs.
    const subject = `Required verification check ${index + 1}`;
    const checkCwd = await checkoutCwd(root, check.cwd, subject);
    if (check.capability) {
      const { probe } = check.capability;
      const probeCwd = await checkoutCwd(root, probe.cwd, `${subject} capability probe ${check.capability.id}`);
      const probeResult = await run({ executable: probe.executable, args: probe.args, cwd: probeCwd,
        timeoutMs: 30_000, maxOutputBytes: PROBE_OUTPUT_BYTES, env: environment });
      const probed = { ...probeResult, code: probeResult.exitCode ?? undefined };
      const availability = classifyCapabilityProbe(check.capability, probed);
      if (availability.status === "failed") throw new Error(`Capability probe failed for ${check.capability.id}: ${availability.reason}`);
      if (availability.status === "unavailable") {
        onProgress(`[verify ${index + 1}/${checks.length}] unavailable ${check.capability.id}: ${availability.reason}`);
        return { gap: verificationGap(check.capability, command, probed, availability.reason),
          record: { checkIndex: index, command: recordCommand, outcome: "capability_unavailable" } };
      }
    }
    onProgress(`[verify ${index + 1}/${checks.length}] ${command}`);
    const started = Date.now();
    const result = await run({ executable: check.executable, args, cwd: checkCwd,
      // A failed check keeps this much of each stream, so the capture is sized for it; a passing one retains today's 8 KiB.
      timeoutMs: CHECK_TIMEOUT_MS, maxOutputBytes: 2 * FAILED_STREAM_BYTES, maxOutputBytesPerStream: FAILED_STREAM_BYTES, env: environment, captureDiagnostics: true });
    const runId = result.runId ? { runId: result.runId } : {};
    if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.signal || result.error) {
      const accepted = await acceptFailure?.({ ...check, args }, result, environment);
      if (accepted) return { passed: accepted, record: { checkIndex: index, command: recordCommand, outcome: "accepted_by_baseline", ...runId } };
      const evidence = failureEvidence(result, index, command, root);
      const output = {
        stdout: redactVerificationOutput(`${result.diagnosticOutput?.stdout ?? ""}\n${result.stdout}`, root),
        stderr: redactVerificationOutput(`${result.diagnosticOutput?.stderr ?? ""}\n${result.stderr}`, root),
        code: result.exitCode, signal: result.signal, timedOut: result.timedOut };
      const summary = `${summarizeVerificationFailure(output)}\nDiagnostic capture: ${evidence.diagnosticCapture}; selected diagnostics and bounded output only.`;
      const failure: RequiredVerificationCheckFailure = { ...evidence, summary };
      const failingTests = countFailingTests(output);
      const record: RequiredVerificationCheckRecord = { checkIndex: index, command: evidence.command,
        outcome: result.timedOut ? "timed_out" : "failed", ...runId, ...(failingTests ? { failingTests } : {}) };
      // A cancelled or unspawnable check is not a finished failure: it ends verification at once.
      if (evidence.outcome === "cancelled" || evidence.outcome === "spawn_failure") {
        throw new RequiredVerificationError({ ...evidence, failures: [failure], checks: [record] }, summary);
      }
      return { failure, record, stop: check.stopOnFailure === true };
    }
    onProgress(`[verify ${index + 1}/${checks.length}] passed in ${formatDuration(Date.now() - started)}`);
    return { passed: command, record: { checkIndex: index, command: recordCommand, outcome: "passed", ...runId } };
  }, (item) => item.stop === true || input.abortSignal?.aborted === true);
  const failures = outcomes.flatMap((item) => item.failure ? [item.failure] : []);
  if (failures.length) {
    const records = checks.map((declared, index): RequiredVerificationCheckRecord =>
      outcomes[index]?.record ?? { checkIndex: index, command: declaredCommand(declared, root), outcome: "not_run" });
    const first = failures[0]!;
    const { summary: _summary, ...top } = first;
    const head = `Required verification failed (${first.outcome}): ${first.command} (check ${first.checkIndex + 1})`;
    throw new RequiredVerificationError({ ...top, failures, checks: records }, failureMessage(head, records, failures));
  }
  const passed = outcomes.flatMap((item) => item.passed ? [item.passed] : []);
  const gaps = outcomes.flatMap((item) => item.gap ? [item.gap] : []);
  return verificationEvidence(passed, gaps, checks);
}
