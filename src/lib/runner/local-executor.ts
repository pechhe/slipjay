import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { runBoundedProcess, sanitizedProcessEnv } from "../infra/bounded-process.ts";
import { RUNNER_DEFAULT_LIMITS, RUNNER_SLICE, SYSTEMD_SLICE_ENV } from "./runner-contract.ts";
import type { Executor, RunnerLimits } from "./runner-contract.ts";

/** Where a runner keeps commands and their budget: see `localExecutor`. */
export type LocalExecutorOptions = {
  host?: string; env?: NodeJS.ProcessEnv; limits?: RunnerLimits;
  /**
   * The runner home that owns the commands. A later process with the same home stops whatever an
   * earlier one left running (`recover`); without one, nothing outlives this process's knowledge.
   */
  home?: string;
  /** The systemd slice whose `limits` bound every run (RUNNER_SLICE); tests use a disposable one. */
  slice?: string;
};

/**
 * Runs commands on this host. Each run's process group is killed on abort or
 * timeout, but a gate's own tools may start further groups (setsid) or systemd
 * scopes that a group signal never reaches. Under a systemd user manager each
 * run therefore gets a slice of its own beneath its owner's slice, its command
 * runs in a scope there, and killing the slice kills everything in it, on abort
 * and after every run; the owner's slice itself is stopped whenever no run is in progress. Commands learn their slice from SYSTEMD_SLICE_ENV; a
 * command that starts its own systemd user scope passes it as `--slice`, so the
 * scope stays inside the run and its limits. The owner's slice is named from
 * `home`, so a later process of the same runner can stop whatever an earlier one
 * left running (`recover`) without touching other units. Every slice sits beneath
 * `slice`, whose `limits` bound all runs together: the workers' gates, deploys and
 * every process they start, however they nest. Memory beyond `memoryHigh` is
 * throttled; `memoryMax` is the hard ceiling. A run that is itself a SlipJay
 * command nests beneath its own slice instead, inside the limits already set
 * above it.
 *
 * Elsewhere there is no combined budget, so the executor runs one command at a
 * time, kills the command's process group after it, and records the group under
 * `home` while it runs so `recover` can stop it after a crash. Tools that leave
 * the group are out of reach there.
 *
 * Either way, a run whose processes cannot be shown stopped makes every later run
 * fail until they are, so nothing reuses a checkout they may still hold.
 */
export function localExecutor({ host = hostname(), env = process.env, limits = {}, home, slice: budget = RUNNER_SLICE }: LocalExecutorOptions = {}): Executor {
  const runtimeDir = process.platform === "linux" ? env.XDG_RUNTIME_DIR : undefined;
  const { settled, contained } = runContainment();
  if (!runtimeDir) return groupExecutor(host, home, { settled, contained });
  const systemctl = (args: string[]) => new Promise<{ failure: string | null; stdout: string }>((resolve) =>
    execFile("systemctl", ["--user", ...args], { env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir } }, (error, stdout, stderr) =>
      resolve({ failure: error ? (stderr.trim() || error.message) : null, stdout: stdout.trim() })));
  const parent = env[SYSTEMD_SLICE_ENV];
  const nested = parent !== undefined && /^[0-9a-z]+(?:-[0-9a-z]+)*\.slice$/.test(parent);
  const ownerSlice = `${(nested ? parent : budget).slice(0, -".slice".length)}-${createHash("sha256").update(home ?? randomUUID()).digest("hex").slice(0, 12)}.slice`;
  /** Kill everything in `slice` and its children, then wait for systemd to stop them. */
  const quiesce = async (slice: string) => {
    await systemctl(["kill", "--signal=SIGKILL", slice]);
    await systemctl(["stop", slice]);
    const { failure, stdout } = await systemctl(["show", "--property=ActiveState", "--value", slice]);
    return failure ?? (stdout === "inactive" ? null : `${slice} is ${stdout}`);
  };
  const { memoryHigh, memoryMax, cpuQuota, tasksMax } = { ...RUNNER_DEFAULT_LIMITS, ...limits };
  // Runtime properties: they last until the user manager restarts, and each runner start sets them again.
  // Refuse execution if the shared budget cannot be enforced; never run uncapped.
  let sliced: Promise<void> | undefined;
  const enforce = () => sliced ??= (nested ? Promise.resolve({ failure: null }) : systemctl(["set-property", "--runtime", budget,
    `MemoryHigh=${memoryHigh}`, `MemoryMax=${memoryMax}`, `CPUQuota=${cpuQuota}`, `TasksMax=${tasksMax}`])).then(({ failure }) => {
    if (failure === null) return;
    sliced = undefined;
    throw new Error(`SlipJay runner: could not enforce the limits of ${budget}: ${failure}`);
  });
  // The owner's slice is stopped whenever its last run ends, so no empty slice outlives the runs.
  // A run that starts meanwhile waits for that stop, so the stop never reaches it. A stop that
  // leaves the slice active is retried, with backoff, for as long as no run is in progress.
  let active = 0;
  let released: Promise<unknown> = Promise.resolve();
  let retry: ReturnType<typeof setTimeout> | undefined;
  const release = (delayMs = 1_000) => {
    released = systemctl(["stop", ownerSlice]).then(async () => {
      const { failure, stdout } = await systemctl(["show", "--property=ActiveState", "--value", ownerSlice]);
      if ((failure === null && stdout === "inactive") || active > 0) return;
      retry = setTimeout(() => { retry = undefined; if (active === 0) release(Math.min(delayMs * 2, 60_000)); }, delayMs);
      retry.unref();
    });
  };
  return {
    host,
    combinedLimits: true,
    ...home === undefined ? {} : { async recover() {
      const failure = await quiesce(ownerSlice);
      if (failure) throw new Error(`SlipJay runner: could not stop the commands an earlier runner left in ${ownerSlice}: ${failure}`);
    } },
    async run(request) {
      await enforce();
      active += 1;
      clearTimeout(retry);
      try {
        await released;
        await settled();
        const id = randomUUID().replaceAll("-", "");
        const runSlice = `${ownerSlice.slice(0, -".slice".length)}-${id}.slice`;
        const stop = () => { void quiesce(runSlice); };
        request.abortSignal?.addEventListener("abort", stop, { once: true });
        return await contained(runSlice, () => runBoundedProcess({
          ...request, executable: "systemd-run",
          args: ["--user", "--scope", "--quiet", "--collect", `--slice=${runSlice}`, `--unit=slipjay-run-${id}.scope`, "--", request.executable, ...request.args],
          env: { ...request.env ?? sanitizedProcessEnv(), XDG_RUNTIME_DIR: runtimeDir, [SYSTEMD_SLICE_ENV]: runSlice },
        }).finally(() => request.abortSignal?.removeEventListener("abort", stop)), () => quiesce(runSlice));
      } finally {
        active -= 1;
        if (active === 0) release();
      }
    },
  };
}

/**
 * Fences runs whose processes could not be shown stopped. `contained` runs `work`, then `stop`;
 * when `stop` reports a failure the run rejects and is remembered, and `settled`, which every run
 * awaits first, retries it and rejects until it succeeds.
 */
export function runContainment() {
  const unstopped = new Map<string, () => Promise<string | null>>();
  return {
    async settled() {
      for (const [name, retry] of unstopped) {
        const failure = await retry();
        if (failure) throw new Error(`SlipJay runner: the processes of an earlier run (${name}) could not be stopped: ${failure}`);
        unstopped.delete(name);
      }
    },
    async contained<T>(name: string, work: () => Promise<T>, stop: () => Promise<string | null>): Promise<T> {
      let result: T;
      try { result = await work(); } finally {
        const failure = await stop();
        if (failure) unstopped.set(name, stop);
      }
      if (unstopped.has(name)) throw new Error(`SlipJay runner: could not stop the processes of ${name}: the next run waits until they stop`);
      return result;
    },
  };
}

/** A process group's leader start time as `ps` reports it, or null once the leader is gone. */
const processStart = (pid: number): string | null => {
  try { return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
};
const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
/** SIGKILL a process group and wait for it to be gone; the failure, or null. */
async function stopGroup(pid: number): Promise<string | null> {
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  for (let waited = 0; groupAlive(pid); waited += 50) {
    if (waited >= 10_000) return `process group ${pid} survived SIGKILL`;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/** The executor without a systemd user manager: see `localExecutor`. */
function groupExecutor(host: string, home: string | undefined, { settled, contained }: ReturnType<typeof runContainment>): Executor {
  const records = home === undefined ? undefined : join(home, "commands");
  let turn: Promise<unknown> = Promise.resolve();
  return {
    host,
    ...records === undefined ? {} : { async recover() {
      const left = await readdir(records).catch(() => [] as string[]);
      for (const name of left) {
        const file = join(records, name);
        const recorded = JSON.parse(await readFile(file, "utf8").catch(() => "null")) as { pid: number; started: string | null } | null;
        // A leader that is alive with another start time is a reused pid, not ours.
        const current = recorded && processStart(recorded.pid);
        if (recorded && groupAlive(recorded.pid) && (current === null || current === recorded.started)) {
          const failure = await stopGroup(recorded.pid);
          if (failure) throw new Error(`SlipJay runner: could not stop the command an earlier runner left: ${failure}`);
        }
        await rm(file, { force: true });
      }
    } },
    run(request) {
      const run = turn.then(async () => {
        await settled();
        const id = randomUUID();
        let pid: number | undefined;
        const record = records && join(records, `${id}.json`);
        if (records) await mkdir(records, { recursive: true });
        return contained(`command ${id}`, () => runBoundedProcess({ ...request, onSpawn: (spawned) => {
          pid = spawned;
          if (record) writeFileSync(record, JSON.stringify({ pid, started: processStart(pid) }));
          request.onSpawn?.(spawned);
        } }), async () => {
          const failure = pid === undefined ? null : await stopGroup(pid);
          if (!failure && record) await rm(record, { force: true });
          return failure;
        });
      });
      turn = run.catch(() => {});
      return run;
    },
  };
}
