import { runBoundedProcess } from "../infra/bounded-process.ts";
import { jj } from "../infra/workspace-jj.ts";
import { readExecutionPolicyAtCommit } from "../policy/execution-policy.ts";

/** A local convenience only: the runner's authoritative gate is unchanged. */
export async function runLandingPreflight(
  root: string,
  commitId: string,
  options: { skipPreflight?: boolean; env?: NodeJS.ProcessEnv; signal?: AbortSignal; onLine(line: string): void;
    /** Told how a preflight that ran ended, so the caller can record it; not called when there is none or it is skipped. */
    onOutcome?(outcome: { outcome: "passed" | "refused"; durationMs: number; reason?: string }): void },
): Promise<void> {
  const { policy } = await readExecutionPolicyAtCommit(root, commitId);
  if (options.skipPreflight) {
    options.onLine("[preflight] skipped (--skip-preflight)");
    return;
  }
  const preflight = policy?.landingPreflight;
  if (!preflight) return;
  const command = JSON.stringify(preflight.command);
  const timeoutMs = preflight.timeoutMs ?? 120_000;
  options.onLine(`[preflight] running ${command}`);
  const started = Date.now();
  const result = await runBoundedProcess({
    executable: preflight.command[0]!, args: preflight.command.slice(1), cwd: root,
    env: { ...process.env, ...options.env }, abortSignal: options.signal, timeoutMs,
    maxOutputBytes: 16 * 1024,
  });
  if (result.timedOut || result.cancelled || result.error || result.exitCode !== 0) {
    for (const output of [result.stdout, result.stderr]) {
      const tail = output.trim().split("\n").slice(-20).join("\n");
      if (tail) options.onLine(tail);
    }
    const reason = result.timedOut ? `timed out after ${timeoutMs}ms`
      : result.cancelled ? "cancelled"
      : result.error ? `could not start: ${result.error.replace(/[\r\n]/g, " ")}`
      : result.signal ? `killed by ${result.signal}` : `exited ${result.exitCode}`;
    // The command's own last word on why (YardSmith's names the checks that failed), else how it ended.
    const lastLine = (output: string) => output.trim().split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
    const last = lastLine(result.stderr) ?? lastLine(result.stdout);
    options.onOutcome?.({ outcome: "refused", durationMs: Date.now() - started, reason: (last ?? reason).slice(0, 300) });
    throw new Error(`Landing refused: preflight ${command} ${reason}; nothing submitted`);
  }
  // Checks must inspect the submitted tree, including when @ is an empty child of it.
  if (await jj(root, ["diff", "--from", commitId, "--to", "@", "--summary"]))
    throw new Error(`Landing refused: preflight ${command} changed tracked source; review the changes and rerun land; nothing submitted`);
  options.onOutcome?.({ outcome: "passed", durationMs: Date.now() - started });
  options.onLine("[preflight] passed");
}
