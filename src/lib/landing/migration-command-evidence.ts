import { redactVerificationOutput } from "../infra/verification-failure.ts";
import { truncateUtf8 } from "../infra/utf8.ts";

/** Redact complete captured streams before clipping. A truncated capture can
 * start halfway through a credential, so withhold that stream rather than guess. */
export function redactMigrationOutput(value: string | undefined, root: string, environment: NodeJS.ProcessEnv = process.env): string {
  let safe = String(value ?? "");
  for (const [key, secret] of Object.entries(environment)) {
    if (secret && /TOKEN|SECRET|PASSWORD|PASSWD|KEY|DATABASE|CREDENTIAL/i.test(key))
      safe = safe.split(secret).join("[REDACTED]");
  }
  safe = safe.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]");
  return redactVerificationOutput(safe, root);
}

/** Build a redacted failure with bounded command evidence attached. */
export function migrationCommandFailure(command: string, result: {
  exitCode?: number | null; code?: number; signal?: string | null;
  timedOut?: boolean; cancelled?: boolean; error?: string;
  stdout?: string; stderr?: string; stdoutTruncated?: boolean; stderrTruncated?: boolean; truncated?: boolean;
}, root: string, environment: NodeJS.ProcessEnv = process.env, subject: string = "Migration"): Error & { evidence: Record<string, unknown> } {
  const redact = (value: string | undefined): string => redactMigrationOutput(value, root, environment);
  const reason = result.cancelled ? "cancelled" : result.timedOut ? "timeout"
    : result.error ? "spawn_failure" : result.signal ? "signal" : "nonzero_exit";
  const evidence: { command: string; outcome: string; exitCode: number | null; signal: string | null; timedOut: boolean; cancelled: boolean; stdoutTruncated: boolean; stderrTruncated: boolean; stdout: string; stderr: string; error?: string; [key: string]: unknown } = {
    command: truncateUtf8(redact(command), 1000), outcome: reason,
    exitCode: result.exitCode ?? result.code ?? null, signal: result.signal ?? null,
    timedOut: result.timedOut === true, cancelled: result.cancelled === true,
    stdoutTruncated: result.stdoutTruncated === true || result.truncated === true,
    stderrTruncated: result.stderrTruncated === true || result.truncated === true,
    stdout: "", stderr: "",
    ...(result.error ? { error: truncateUtf8(redact(result.error), 1000) } : {}),
  };
  for (const stream of ["stdout", "stderr"] satisfies ("stdout" | "stderr")[]) {
    evidence[stream] = evidence[stream + "Truncated"] ? "[truncated output withheld]" : truncateUtf8(redact(result[stream]), 4096);
    if (Buffer.byteLength(redact(result[stream]), "utf8") > 4096) evidence[stream + "Truncated"] = true;
  }
  const error = new Error(`${subject} command failed (${reason}): ${evidence.command}\n${JSON.stringify(evidence)}`) as Error & { evidence: Record<string, unknown> };
  error.evidence = evidence;
  return error;
}
