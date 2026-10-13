import { existsSync } from "node:fs";
import { readExecutionPolicy } from "./execution-policy.mjs";
import { runWorkspaceCommand } from "./workspace-command.mjs";

/** A teardown that outlives this is killed and logged; it never holds a removal. */
export const TEARDOWN_TIMEOUT_MS = 30_000;

/**
 * Run the repository's declared `workspaceTeardown` (`slipjay.json`) in a workspace
 * before it is removed. Best effort: a missing policy, checkout, executable, a
 * non-zero exit, a timeout or an unreadable policy is logged and never throws, so
 * it can never block the removal. `integrationRoot` supplies the policy (its working
 * file, as cleanup's `generatedPaths` do). Returns `{ ran, ok }` for tests and hosts.
 */
export async function runWorkspaceTeardown(integrationRoot, workspace, options = {}) {
  const label = `[teardown] ${workspace.name}`;
  try {
    const teardown = (await readExecutionPolicy(integrationRoot))?.workspaceTeardown;
    if (!teardown) return { ran: false, ok: true };
    if (!workspace.root || !existsSync(workspace.root)) return { ran: false, ok: true };
    const result = await runWorkspaceCommand(teardown.executable, teardown.args, {
      cwd: workspace.root,
      timeoutMs: options.timeoutMs ?? TEARDOWN_TIMEOUT_MS,
      env: { ...process.env, SLIPJAY_WORKSPACE_NAME: workspace.name, SLIPJAY_WORKSPACE_PATH: workspace.root },
    });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" | ");
      console.error(`${label}: ${teardown.executable} failed (exit ${result.code}${result.timedOut ? ", timed out" : ""}); continuing${detail ? `: ${detail}` : ""}`);
      return { ran: true, ok: false };
    }
    return { ran: true, ok: true };
  } catch (error) {
    console.error(`${label}: skipped (${error instanceof Error ? error.message : String(error)}); continuing`);
    return { ran: false, ok: false };
  }
}
