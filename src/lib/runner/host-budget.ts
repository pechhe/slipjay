/**
 * The door a heavy job passes on its way onto a shared host (SJ-212): it waits while the host's load is over budget, and
 * says what it is waiting for. It keeps no queue and no service: the kernel's load figures are the only shared state, and
 * one file's modification time, claimed under a lock, says when a job last went through, so jobs started together do
 * not all read the same quiet host. The wait happens before a job's commands start, so it never counts against their timeouts.
 */
import { spawn } from "node:child_process";

/**
 * A `gate` keeps a landing moving: it may run up to the host's CPU count and waits briefly. `background` work (a nightly
 * audit, a release check, a preview) leaves a quarter of the host free and waits far longer, so gates and agents go first.
 */
export type HostBudgetClass = "gate" | "background";

export type HostLoad = { load1: number; load5: number; cpus: number };

/** Runs a shell script on the host in question; null when it could not be reached or read. */
export type HostShell = (script: string, signal?: AbortSignal) => Promise<string | null>;

export const HOST_BUDGET_WAIT_LIMIT_MS: Readonly<Record<HostBudgetClass, number>> = { gate: 120_000, background: 30 * 60_000 };
/** How long a job's own load takes to show in the one-minute figure: long enough that audits started together do not all read a quiet host. */
const SETTLE_SECONDS = 60;
const BACKGROUND_SHARE = 0.75;
const POLL_MS = 15_000;
const ANNOUNCE_MS = 60_000;

const READ_SCRIPT = "cat /proc/loadavg; nproc";
/** Stamps a job's start. Under the lock, background work finds out whether another job started too recently, so two jobs that read the same figures cannot both go. */
const claimScript = (jobClass: HostBudgetClass) => {
  const claim = jobClass === "gate" ? `touch "$stamp"; echo claimed`
    : `if [ $(( $(date +%s) - $(stat -c %Y "$stamp" 2>/dev/null || echo 0) )) -lt ${SETTLE_SECONDS} ]; then echo taken; else touch "$stamp"; echo claimed; fi`;
  return `mkdir -p "$HOME/.slipjay" && flock "$HOME/.slipjay/host-budget.lock" sh -c 'stamp="$HOME/.slipjay/host-budget-admitted"; ${claim}'`;
};
/** A job past its wait goes whatever the host says, so it stamps as a gate does. */
const STAMP_SCRIPT = claimScript("gate");

/** Null for anything but what the script prints on Linux: such a host has no budget to keep. */
export function parseHostLoad(output: string): HostLoad | null {
  const [average, cpus] = output.trim().split("\n");
  const [load1, load5] = (average ?? "").split(" ").map(Number);
  const figures = [load1, load5, Number(cpus)];
  if (figures.some((figure) => figure === undefined || !Number.isFinite(figure)) || Number(cpus) < 1) return null;
  return { load1: load1!, load5: load5!, cpus: Number(cpus) };
}

/** What `jobClass` is waiting for on this reading; null when it may start. The larger of the two figures decides. */
export function overHostBudget(load: HostLoad, jobClass: HostBudgetClass): string | null {
  const figure = Math.max(load.load1, load.load5);
  const limit = jobClass === "gate" ? load.cpus : load.cpus * BACKGROUND_SHARE;
  return figure > limit ? `load ${figure.toFixed(1)} is over ${limit.toFixed(1)} of its ${load.cpus} CPUs` : null;
}

export type HostBudgetOutcome = {
  /** `over-limit` ran anyway, after waiting as long as this class waits: a heavy job never fails for the budget. */
  outcome: "admitted" | "over-limit" | "unread";
  /** Whether it was over budget at the door, rather than only reading the figures. */
  waited: boolean;
  waitedMs: number;
};

/** Returns once `job` may start, it has waited its limit, or `signal` aborts. It never throws for the budget. */
export async function awaitHostBudget(input: {
  shell: HostShell;
  job: string;
  host: string;
  jobClass: HostBudgetClass;
  onWait: (line: string) => void;
  signal?: AbortSignal;
  limitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<HostBudgetOutcome> {
  const { shell, job, host, jobClass, onWait, signal } = input;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? pause;
  const limitMs = input.limitMs ?? HOST_BUDGET_WAIT_LIMIT_MS[jobClass];
  const started = now();
  let announced: number | null = null;
  for (;;) {
    const output = await shell(READ_SCRIPT, signal);
    let waitedMs = now() - started;
    if (signal?.aborted) return { outcome: "unread", waited: announced !== null, waitedMs };
    const load = output === null ? null : parseHostLoad(output);
    if (load === null) return { outcome: "unread", waited: announced !== null, waitedMs };
    let over = overHostBudget(load, jobClass);
    if (over === null) {
      if ((await shell(claimScript(jobClass), signal))?.trim() !== "taken") {
        waitedMs = now() - started;
        if (announced !== null) onWait(`${job} starts on ${host} after waiting ${Math.round(waitedMs / 1000)} s for its CPU budget`);
        return { outcome: "admitted", waited: announced !== null, waitedMs };
      }
      over = "a job has just started and its load has yet to show";
    }
    if (waitedMs >= limitMs) {
      await shell(STAMP_SCRIPT, signal);
      onWait(`${job} starts on ${host} over its CPU budget after waiting ${Math.round(waitedMs / 1000)} s, its limit: ${over}`);
      return { outcome: "over-limit", waited: true, waitedMs };
    }
    if (announced === null || waitedMs - announced >= ANNOUNCE_MS) {
      announced = waitedMs;
      onWait(`${job} is waiting for ${host}'s CPU budget: ${over} (waited ${Math.round(waitedMs / 1000)} s of at most ${Math.round(limitMs / 1000)} s)`);
    }
    await sleep(input.pollMs ?? POLL_MS, signal);
  }
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

/** Runs the script on this host, or over SSH when given the arguments that reach another. Null on any failure. */
export function hostShell(ssh?: readonly string[]): HostShell {
  return (script, signal) => new Promise((resolve) => {
    const [executable, args] = ssh ? ["ssh", [...ssh, script]] as const : ["sh", ["-c", script]] as const;
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "ignore"], timeout: 30_000, ...signal ? { signal } : {} });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? stdout : null));
  });
}
