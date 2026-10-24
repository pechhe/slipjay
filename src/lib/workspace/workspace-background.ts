import { spawn } from "node:child_process";
import { closeSync, openSync, statSync } from "node:fs";
import { appendFile, mkdir, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceContext } from "../infra/workspace-jj.ts";
import { poolRefillLogPath, stateHome } from "./workspace-paths.ts";

const BACKGROUND_LOG_LIMIT = 1024 * 1024;

/**
 * Run one of the package's own entries (`src/launcher/*`, in source and in the
 * installed package) as a detached, `nice`d child for the integration root,
 * appending its output to the background-work log in the state home. `started`
 * means the child spawned; its outcome is only in the log. `command` replaces the
 * spawned runner (tests); `args` come before the integration root, which is always the last argument.
 * A caller that just resolved a workspace context can supply its integration root without rereading policy.
 */
export async function startBackgroundEntry(cwd: string, entry: string, options: { command?: string[]; args?: string[]; integrationRoot?: string } = {}): Promise<{ started: boolean; pid?: number; logPath?: string; reason?: string }> {
  const root = options.integrationRoot ?? (await workspaceContext(cwd))?.integration.root;
  if (!root) return { started: false, reason: "not-jj" };
  const command = options.command ?? ["nice", "-n", "10", process.execPath, fileURLToPath(new URL(entry, import.meta.url))];
  return await spawnDetached([...command, ...options.args ?? [], root], root);
}

/** Spawn `command` detached in `cwd`, appending its output to the background-work log. */
export async function spawnDetached(command: string[], cwd: string): Promise<{ started: boolean; pid?: number; logPath?: string; reason?: string }> {
  await mkdir(stateHome(), { recursive: true, mode: 0o700 });
  const logPath = poolRefillLogPath();
  let oversized = false;
  try { oversized = statSync(logPath).size > BACKGROUND_LOG_LIMIT; } catch { /* no log yet */ }
  const log = openSync(logPath, oversized ? "w" : "a", 0o600);
  try {
    const [executable, ...args] = command;
    const child = spawn(executable!, args, {
      cwd,
      detached: true,
      stdio: ["ignore", log, log],
    });
    const spawned = await new Promise<Error | null>((resolveSpawn) => {
      child.once("spawn", () => resolveSpawn(null));
      child.once("error", (error) => resolveSpawn(error));
    });
    if (spawned) return { started: false, reason: spawned.message, logPath };
    // A fixture/host that must join detached work supplies its own registry.
    // Inherited by children, so housekeeping's trash/refill workers register too.
    const registry = process.env.SLIPJAY_BACKGROUND_WORKERS;
    if (registry) {
      await mkdir(registry, { recursive: true });
      const record = join(registry, randomUUID());
      await writeFile(record + ".tmp", JSON.stringify({ pid: child.pid, command, cwd }), { mode: 0o600 });
      await rename(record + ".tmp", record + ".json");
    }
    child.unref();
    return { started: true, pid: child.pid, logPath };
  } finally {
    closeSync(log);
  }
}

/** Append one outcome line (timestamp, then JSON) to the pool-refill log, in the format the refill child writes. Never throws: a log failure must not fail the work it records. */
export async function appendPoolRefillLog(outcome: object): Promise<void> {
  try {
    await mkdir(stateHome(), { recursive: true, mode: 0o700 });
    await appendFile(poolRefillLogPath(), `${new Date().toISOString()} ${JSON.stringify(outcome)}\n`, { mode: 0o600 });
  } catch { /* the log is diagnostic */ }
}
