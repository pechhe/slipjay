import { spawn } from "node:child_process";
import { runBoundedProcess, sanitizedProcessEnv } from "./bounded-process.mjs";

/** Credential keys jj, git and gh need to reach a remote (D5), plus where jj's own
 *  configuration lives, which decides the author it records; nothing else of the user env. */
const PASSED_KEY = /^(SSH_AUTH_SOCK|GIT_SSH.*|GH_.*|GITHUB_TOKEN|JJ_CONFIG|XDG_CONFIG_HOME)$/;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** The environment for workspace and publication commands (jj, git, gh): the
 *  sanitized allowlist plus remote credentials. Verification is the caller's
 *  concern and gets the full user environment instead. */
export function landingCommandEnvironment(source = process.env) {
  const env = sanitizedProcessEnv(source);
  for (const [key, value] of Object.entries(source)) if (value && PASSED_KEY.test(key)) env[key] = value;
  return env;
}

/** A hung command (an unreachable remote, a stuck lock) must not hold the landing slot. */
function commandTimeoutMs(options) {
  return options.timeoutMs ?? (Number(process.env.SLIPJAY_COMMAND_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
}

/**
 * Run one workspace command with a timeout and an output bound. Resolves with
 * `{ code, signal, stdout, stderr, timedOut, truncated }`; a timeout or spawn
 * failure is a nonzero `code` with the reason in `stderr`. `inherit` streams to
 * this terminal unbounded in time, for interactive dependency installation.
 */
export async function runWorkspaceCommand(command, args, options = {}) {
  if (options.inherit) return runInherited(command, args, options);
  const timeoutMs = commandTimeoutMs(options);
  const result = await runBoundedProcess({
    executable: command, args, cwd: options.cwd ?? process.cwd(), timeoutMs,
    maxOutputBytes: 2 * MAX_OUTPUT_BYTES, maxOutputBytesPerStream: MAX_OUTPUT_BYTES,
    env: options.env ?? landingCommandEnvironment(),
  });
  const failure = result.timedOut ? `${command} ${args.slice(0, 3).join(" ")} timed out after ${Math.round(timeoutMs / 1000)}s`
    : result.error ? `${command} could not start: ${result.error}` : "";
  return {
    code: failure ? 1 : result.exitCode ?? 1,
    signal: result.signal,
    stdout: result.stdout,
    stderr: failure ? [result.stderr.trim(), failure].filter(Boolean).join("\n") : result.stderr,
    timedOut: result.timedOut,
    truncated: result.stdoutTruncated || result.stderrTruncated,
  };
}

function runInherited(command, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveRun({ code: code ?? 1, signal, stdout: "", stderr: "", timedOut: false, truncated: false }));
  });
}
