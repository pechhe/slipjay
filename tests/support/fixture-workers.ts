import { readFile, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { slipjayHome } from "../../src/lib/workspace/workspace-paths.ts";

type Worker = { pid: number; command: string[]; cwd: string };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function waitForExit(pid: number, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`process ${pid} still running after ${timeoutMs}ms`);
    await new Promise((settle) => setTimeout(settle, 50));
  }
}

/** Join exactly the fixture's registered workers, before killing anything or deleting its repo. */
export async function drainFixtureWorkers(root?: string): Promise<void> {
  const registry = process.env.SLIPJAY_BACKGROUND_WORKERS;
  if (!registry) throw new Error("Fixture worker registry is required");
  const within = (path: string, base: string) => resolve(path) === resolve(base) || resolve(path).startsWith(resolve(base) + sep);
  for (;;) {
    const workers: Array<{ file: string; worker: Worker }> = [];
    for (const file of await readdir(registry).catch(() => [])) {
      if (!file.endsWith(".json")) continue;
      const worker = await readFile(join(registry, file), "utf8").then((text) => JSON.parse(text) as Worker)
        .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (!worker) continue; // Another fixture drain may have joined shared trash deletion.
      if (!root || within(worker.cwd, root) || within(worker.cwd, slipjayHome()) || worker.command.includes(root)) workers.push({ file, worker });
    }
    if (!workers.length) return;
    // A worker can register more work before exiting. Reread until all of it is joined.
    for (const { file, worker } of workers) {
      if (process.env.SLIPJAY_TRANSACTION_DIAGNOSTICS) console.error(`[fixture worker] joining pid=${worker.pid} cwd=${worker.cwd} command=${worker.command.join(" ")}`);
      // The same budget `waitForExit` gives a landing's own housekeeping. These are the same niced sweeps: 0.15-1.5s
      // in this fixture on a quiet machine, but starved past 30s while the whole suite loads every core, which is
      // how the policy rerun failed on its drain rather than on its work.
      try { await waitForExit(worker.pid); }
      catch (error) {
        // Don't leave a timed-out fixture holding its locks into the next test.
        try { process.kill(-worker.pid, "SIGTERM"); } catch { /* already exited */ }
        try { await waitForExit(worker.pid, 1000); } catch {
          try { process.kill(-worker.pid, "SIGKILL"); } catch { /* already exited */ }
          await waitForExit(worker.pid, 1000);
        }
        throw new Error(`Fixture worker did not finish: pid=${worker.pid} cwd=${worker.cwd} command=${worker.command.join(" ")}`, { cause: error });
      }
      await rm(join(registry, file), { force: true });
    }
  }
}
