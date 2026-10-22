import { spawn } from "node:child_process";
import { runBoundedProcess, sanitizedProcessEnv } from "./bounded-process.ts";

/** Credential keys jj, git and gh need to reach a remote (D5), plus where jj's own
 *  configuration lives, which decides the author it records; nothing else of the user env. */
const PASSED_KEY = /^(SSH_AUTH_SOCK|GIT_SSH.*|GH_.*|GITHUB_TOKEN|JJ_CONFIG|XDG_CONFIG_HOME)$/;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type WorkspaceCommandResult = {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

/** The environment for workspace and publication commands (jj, git, gh): the
 *  sanitized allowlist plus remote credentials. Verification is the caller's
 *  concern and gets the full user environment instead. */
export function landingCommandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = sanitizedProcessEnv(source);
  for (const [key, value] of Object.entries(source)) if (value && PASSED_KEY.test(key)) env[key] = value;
  return env;
}

/** A hung command (an unreachable remote, a stuck lock) must not hold the landing slot. */
function commandTimeoutMs(options: { timeoutMs?: number }): number {
  return options.timeoutMs ?? (Number(process.env.SLIPJAY_COMMAND_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
}

/**
 * `env` for a jj process. Without a terminal or COLUMNS, jj runs `tput cols` and `tput lines`
 * on every call to learn a width it then does without; 80 is the width it falls back to.
 */
export function jjEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env.COLUMNS ? env : { ...env, COLUMNS: "80" };
}

/**
 * Run one workspace command with a timeout and an output bound. Resolves with
 * `{ code, signal, stdout, stderr, timedOut, truncated }`, with `input` sent to its stdin; a timeout or spawn
 * failure is a nonzero `code` with the reason in `stderr`. `inherit` streams to
 * this terminal unbounded in time, for interactive dependency installation.
 */
export async function runWorkspaceCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; inherit?: boolean; input?: string } = {},
): Promise<WorkspaceCommandResult> {
  if (options.inherit) return runInherited(command, args, options);
  const timeoutMs = commandTimeoutMs(options);
  const env = options.env ?? landingCommandEnvironment();
  const result = await runBoundedProcess({
    executable: command, args, cwd: options.cwd ?? process.cwd(), timeoutMs,
    maxOutputBytes: 2 * MAX_OUTPUT_BYTES, maxOutputBytesPerStream: MAX_OUTPUT_BYTES,
    env: command === "jj" ? jjEnvironment(env) : env,
    ...options.input === undefined ? {} : { input: options.input },
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

function runInherited(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<WorkspaceCommandResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveRun({ code: code ?? 1, signal, stdout: "", stderr: "", timedOut: false, truncated: false }));
  });
}
