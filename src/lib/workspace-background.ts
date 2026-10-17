import { spawn } from "node:child_process";
import { closeSync, openSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { workspaceContext } from "./workspace-jj.ts";
import { poolRefillLogPath, stateHome } from "./workspace-paths.ts";

const BACKGROUND_LOG_LIMIT = 1024 * 1024;

/**
 * Run one of the closure's own entries (beside this module in source and in the
 * installed bundle) as a detached, `nice`d child for the integration root,
 * appending its output to the background-work log in the state home. `started`
 * means the child spawned; its outcome is only in the log. `command` replaces the
 * spawned runner (tests); the integration root is always its last argument.
 */
export async function startBackgroundEntry(cwd: string, entry: string, options: { command?: string[] } = {}): Promise<{ started: boolean; pid?: number; logPath?: string; reason?: string }> {
  const context = await workspaceContext(cwd);
  if (!context) return { started: false, reason: "not-jj" };
  await mkdir(stateHome(), { recursive: true, mode: 0o700 });
  const logPath = poolRefillLogPath();
  let oversized = false;
  try { oversized = statSync(logPath).size > BACKGROUND_LOG_LIMIT; } catch { /* no log yet */ }
  const log = openSync(logPath, oversized ? "w" : "a", 0o600);
  try {
    const [executable, ...args] = options.command ?? ["nice", "-n", "10", process.execPath, fileURLToPath(new URL(entry, import.meta.url))];
    const child = spawn(executable!, [...args, context.integration.root], {
      cwd: context.integration.root,
      detached: true,
      stdio: ["ignore", log, log],
    });
    const spawned = await new Promise<Error | null>((resolveSpawn) => {
      child.once("spawn", () => resolveSpawn(null));
      child.once("error", (error) => resolveSpawn(error));
    });
    if (spawned) return { started: false, reason: spawned.message, logPath };
    child.unref();
    return { started: true, pid: child.pid, logPath };
  } finally {
    closeSync(log);
  }
}
