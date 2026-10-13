/** The one runner for a landing's `requiredLandingVerification`, used by the CLI, Pi and the host. */
import { realpath } from "node:fs/promises";
import { runBoundedProcess } from "./bounded-process.ts";
import { checkoutCwd } from "./checkout-cwd.ts";
import { truncateUtf8 } from "./utf8.ts";
import { redactVerificationOutput, summarizeVerificationFailure } from "./verification-failure.ts";
import { classifyCapabilityProbe, normalizeVerificationDeclaration, runVerificationStages, verificationEvidence, verificationGap } from "./verification-policy.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "./bounded-process.ts";
import type { VerificationDeclaration, VerificationEvidence } from "./verification-policy.ts";

const CHECK_TIMEOUT_MS = 60 * 60_000;
const OUTPUT_BYTES = 64 * 1024;
const TAIL_BYTES = 4 * 1024;
const COMMAND_BYTES = 1_000;

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
  finishedAt: string;
  error?: string;
};

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

function failureEvidence(result: BoundedProcessResult, checkIndex: number, command: string, root: string): RequiredVerificationFailureEvidence {
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
    ...(result.error ? { error: truncateUtf8(redactVerificationOutput(result.error, root), COMMAND_BYTES) } : {}),
  };
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
}): Promise<VerificationEvidence> {
  const { checks, onProgress = () => {}, acceptFailure, run = runBoundedProcess } = input;
  // The real root: commands run at real paths, so redaction must match them.
  const root = await realpath(input.root);
  const environment = (input.environment ?? (() => process.env))();
  const outcomes = await runVerificationStages(checks as readonly ({ concurrent?: unknown } | null)[], async (declared, index) => {
    if (!declared || typeof declared !== "object") throw new Error("The repository policy contains malformed requiredLandingVerification");
    const check: VerificationDeclaration = normalizeVerificationDeclaration(declared, "requiredLandingVerification");
    const args = check.args.map(String);
    const command = [check.executable, ...args].join(" ");
    // Both directories are contained before anything in this check runs.
    const subject = `Required verification check ${index + 1}`;
    const checkCwd = await checkoutCwd(root, check.cwd, subject);
    if (check.capability) {
      const { probe } = check.capability;
      const probeCwd = await checkoutCwd(root, probe.cwd, `${subject} capability probe ${check.capability.id}`);
      const probeResult = await run({ executable: probe.executable, args: probe.args, cwd: probeCwd,
        timeoutMs: 30_000, maxOutputBytes: OUTPUT_BYTES, env: environment });
      const probed = { ...probeResult, code: probeResult.exitCode ?? undefined };
      const availability = classifyCapabilityProbe(check.capability, probed);
      if (availability.status === "failed") throw new Error(`Capability probe failed for ${check.capability.id}: ${availability.reason}`);
      if (availability.status === "unavailable") {
        onProgress(`[verify ${index + 1}/${checks.length}] unavailable ${check.capability.id}: ${availability.reason}`);
        return { gap: verificationGap(check.capability, command, probed, availability.reason) };
      }
    }
    onProgress(`[verify ${index + 1}/${checks.length}] ${command}`);
    const started = Date.now();
    const result = await run({ executable: check.executable, args, cwd: checkCwd,
      timeoutMs: CHECK_TIMEOUT_MS, maxOutputBytes: OUTPUT_BYTES, env: environment });
    if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.signal || result.error) {
      const accepted = await acceptFailure?.({ ...check, args }, result, environment);
      if (accepted) return { passed: accepted };
      throw new RequiredVerificationError(failureEvidence(result, index, command, root), summarizeVerificationFailure({
        stdout: redactVerificationOutput(result.stdout, root), stderr: redactVerificationOutput(result.stderr, root),
        code: result.exitCode, signal: result.signal, timedOut: result.timedOut }));
    }
    onProgress(`[verify ${index + 1}/${checks.length}] passed in ${formatDuration(Date.now() - started)}`);
    return { passed: command };
  });
  const passed = outcomes.flatMap((item) => item.passed ? [item.passed] : []);
  const gaps = outcomes.flatMap((item) => item.gap ? [item.gap] : []);
  return verificationEvidence(passed, gaps, checks);
}
