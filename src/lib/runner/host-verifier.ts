import { readdir, readlink, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runBoundedProcess } from "../infra/bounded-process.ts";
import { worktreeTree } from "./boat-verifier.ts";
import type { Executor, RemoteAttempt, RemoteMachine } from "./runner-types.ts";

/** The git-dir entry holding this checkout's last refreshed tree index, outside `.git/index`, which jj rewrites. */
const TREE_INDEX = "slipjay-tree-index";

/**
 * A gate in the runner host's own gate place (SJ-189, Decision #6249): a repository whose gate otherwise runs on a
 * remote verifier runs it here, in the attempt's own runner checkout, when the place is free as its commands are about
 * to run. It does what a boat VM attempt does, on this host: it stops anything left running in the checkout, installs
 * the candidate's frozen dependencies (`install`, the runner's own install from its warm cache), proves the checkout
 * holds exactly the candidate's tree, and on `finish` reads the tree again, so a gate that changed the candidate's files
 * is no evidence for it (`closeRemote`). Its commands run through the runner's own `executor`, inside the host-wide
 * budget every run shares. It bills nothing, so its `usage` is null and metrics count no spend for it. A fault in its
 * setup fails the landing at once as infrastructure, as a setup fault on a VM boat supplied does: nothing of the
 * candidate's gate ran, and the host is the runner's own, so there is no other machine to wait for.
 */
export async function openHostAttempt(input: {
  executor: Executor; checkout: string; candidate: string;
  install: () => Promise<void>;
}): Promise<RemoteAttempt> {
  const { executor, checkout, candidate, install } = input;
  const machine = hostMachine(executor.host);
  await stopCheckoutProcesses(checkout);
  const [tree = "", index = ""] = (await gitOutput(checkout, ["rev-parse", `${candidate}^{tree}`, "--git-path", TREE_INDEX])).split("\n");
  /** Where this checkout keeps the refreshed index an earlier read left, so the second read hashes only what the gate touched. */
  const cache = index ? resolve(checkout, index) : undefined;
  try {
    await install();
    const observed = await checkoutTree(checkout, tree, cache);
    if (observed !== tree) throw new Error(`Host executor unavailable (setup): ${checkout} holds tree ${observed || "none"} after setup, not the candidate's ${tree}`);
  } catch (error) {
    await stopCheckoutProcesses(checkout).catch(() => undefined);
    throw error;
  }
  return {
    executor, machine, tree, usage: null,
    async finish() {
      const now = await checkoutTree(checkout, tree, cache);
      if (now === tree) return { tree, trackedChanges: 0, usage: null };
      const changed = (await gitOutput(checkout, ["diff", "--name-only", tree, now]).catch(() => "")).split("\n").filter(Boolean).length;
      return { tree: null, trackedChanges: Math.max(changed, 1), usage: null };
    },
    close: () => stopCheckoutProcesses(checkout),
  };
}

/** The runner host as the ledger names the machine of a gate in its gate place. */
export const hostMachine = (host: string): RemoteMachine => ({ verifier: "host", id: host, name: host, size: "host", image: "runner checkout" });

const CONTROL_TIMEOUT_MS = 120_000;
const CONTROL_OUTPUT = 1024 * 1024;

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await runBoundedProcess({ executable: "git", args, cwd, timeoutMs: CONTROL_TIMEOUT_MS, maxOutputBytes: CONTROL_OUTPUT, env: process.env });
  if (result.exitCode !== 0) throw new Error(`Host executor unavailable (setup): git ${args[0]} failed in ${cwd}: ${result.stderr.trim().slice(-1000)}`);
  return result.stdout.trim();
}

/** The checkout's files as a tree, exactly as a boat VM reads its own (`worktreeTree`). */
async function checkoutTree(checkout: string, tree: string, cache?: string): Promise<string> {
  const result = await runBoundedProcess({ executable: "bash", args: ["-c", worktreeTree(tree, cache)], cwd: checkout, timeoutMs: CONTROL_TIMEOUT_MS, maxOutputBytes: CONTROL_OUTPUT, env: process.env });
  if (result.exitCode !== 0) throw new Error(`Host executor unavailable (setup): could not read ${checkout}'s tree: ${result.stderr.trim().slice(-1000)}`);
  return result.stdout.trim().split("\n").at(-1) ?? "";
}

/**
 * Stop every process whose working directory is inside `checkout`, other than this one: a gate's tool that left its run
 * (a daemon, a detached server) would otherwise hold the checkout into the next attempt. The runner's executor already
 * stops each run's own processes; this catches what escaped them. Linux only, where `/proc` names each process's cwd.
 */
export async function stopCheckoutProcesses(checkout: string): Promise<void> {
  if (process.platform !== "linux") return;
  const root = await realpath(checkout).catch(() => checkout);
  const inside = (path: string) => path === root || path.startsWith(`${root}/`);
  for (let round = 0; round < 100; round++) {
    const left: number[] = [];
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      // A process that is gone, or a zombie, has no readable cwd: neither holds the checkout.
      const cwd = await readlink(`/proc/${name}/cwd`).catch(() => null);
      if (cwd && inside(cwd)) left.push(Number(name));
    }
    if (!left.length) return;
    for (const pid of left) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    await delay(100);
  }
  throw new Error(`Host verifier: processes left in ${checkout} survived SIGKILL; the next gate there waits until they stop`);
}
