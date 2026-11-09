import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runBoundedProcess, type BoundedProcessRequest, type BoundedProcessResult } from "../infra/bounded-process.ts";
import { collectRemoteReports, frozenInstall, receiveBuildCommit, receiveCandidate, remoteFiles, remoteCommand, shellWord, sshFailed, worktreeTree, loopbackPort, SETUP_TIMEOUT_MS, CONTROL_OUTPUT } from "./remote-attempt.ts";
export { remoteCommand, shellWord, worktreeTree, loopbackPort } from "./remote-attempt.ts";
import { TEST_REPORT_DIR_ENV } from "./test-reports.ts";
import type { MachineLease, RemoteAttempt, RemoteMachine, RemoteOpenFailure, RemoteVerification, RunnerConfig, RuntimeIdentity } from "./runner-types.ts";

/**
 * Gates on boat.dev VMs (SJ-138). Each repository verifying on boat has a pool of long-lived VMs, one per verification
 * place (`slot`), named `slipjay-<owner>-<name>-<slot>` and forked from the stopped starting sandbox `image` when missing
 * (Decision #5738: the trial allows 75 creations a day). An attempt has its VM to itself: before the gate the VM's one
 * checkout is cleaned, moved to the runner checkout's own path, given the exact candidate over SSH as a Git bundle and
 * installed against the candidate's lockfile; each gate command then runs over SSH in a systemd scope of its own, which
 * `close` stops. Nothing here falls back to the VPS: every failure to supply or reach a VM throws, naming boat.
 */

const USER_HOME = "/home/user";
/** The VM's PATH: its own bun and jj, never the runner host's toolchain paths. */
const REMOTE_PATH = `${USER_HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin`;
/**
 * How long a gate slot's disk may take to restore before the slot is forked afresh. Measured 2 Nov 2026: a fresh fork of
 * the image was ready in six to eleven minutes, while resuming a slot whose disk had grown (some 450,000 files) was still
 * restoring after fifty, so a slow slot is replaced rather than waited for (3.47.1 tried waiting fifteen minutes and every
 * screen landing then failed as infrastructure).
 */
const READY_TIMEOUT_MS = 300_000;
/**
 * A build machine's disk holds its warm Docker build cache (a 3-minute build against 20+ cold), and a resumed disk that
 * large can take longer than a gate slot's wait to restore. So a build machine waits this long and is not replaced while
 * its restore is merely slow: a fresh fork would throw away the cache the wait protects. Boat reports a restore that is
 * stuck instead of slow as `degraded`, which waiting cannot cure, so that machine is replaced like a slot. The wait also
 * bounds a replacement's own restore, which builds the whole of that large disk from the image: one took 21 minutes on
 * 31 Oct 2026, so twenty minutes failed a deploy 45 s before its disk was ready and a retry on the same VM succeeded.
 */
const BUILD_READY_TIMEOUT_MS = 30 * 60_000;
/** Bound one boat API call; opening retries share a separate budget. */
const BOAT_TIMEOUT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 120_000;
/**
 * Boat stops a VM when its lifetime runs out, snapshotting its disk for a later resume, so the lifetime is the idle
 * timer: long enough for any attempt while one runs, IDLE_LIFETIME_S once it closes. A runner restart loses no timer.
 * Fifteen minutes keeps a VM warm through a burst of landings or a retried deploy without billing a quiet hour. A build
 * machine's Docker build cache is on the disk a stop keeps, and resuming it took about 97 s with no slower a build
 * (Nov 2026), so it idles no longer than a gate VM.
 */
const ATTEMPT_LIFETIME_S = 3 * 3600;
const IDLE_LIFETIME_S = 15 * 60;
/** Boat states in which a VM holds no running machine: it resumes from its snapshot. */
const STOPPED = ["stopped", "stopping", "archived"];
/** How long recovery keeps retrying to clean the pool after a restart. */
const RECOVERY_MS = 240_000;
/** Remote paths an attempt's commands created (TMPDIR, test reports), removed by every clean. */
const SCRATCH_LIST = "~/.slipjay-scratch";
/**
 * A pool VM's name: stable per repository and slot, so a later runner process finds the same one. Numeric slots
 * belong to the authoritative lane, `<number>-screen` to screening, and other named pools to build machines. A build
 * machine's pool name starts with a letter (`deployment-policy.ts`), so neither gate form can name one.
 */
export const poolName = (repo: string, slot: number | string): string => `slipjay-${repo.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${slot}`;
/** Whether `name` is one of `repo`'s gate slot VMs, which restart recovery cleans; a build machine is not. */
export const isSlotVm = (repo: string, name: string): boolean => {
  const prefix = poolName(repo, "");
  return name.startsWith(prefix) && /^\d+(?:-screen)?$/.test(name.slice(prefix.length));
};
/**
 * Ends every SSH login of an earlier lease still open on a build machine (a runner that died mid-command, a lost
 * connection), with the commands and reverse tunnels it held, so a new lease never shares the machine with it. Only
 * seatless sessions other than this one go: the VM's desktop session stays, and the builder's containers and cache are
 * not sessions, so they survive. A session still open ten seconds after its terminate is killed outright (a timed-out
 * build's commands can ignore the polite signal). A session that has already gone needs no ending; one still open after a minute fails
 * the lease, so the machine is never handed over while an earlier lease may still hold it. It never calls `exit`: under
 * `set -e` a login shell that does runs the VM's ~/.bash_logout, whose failing clear_console would replace its status.
 */
export const FENCE_SCRIPT = `others() { loginctl list-sessions --no-legend | awk -v me="$XDG_SESSION_ID" '$3 == "user" && $4 == "-" && $1 != me { print $1 }'; }
for session in $(others); do loginctl terminate-session "$session" 2>/dev/null || true; done
for _ in $(seq 1 10); do [ -n "$(others)" ] || break; sleep 1; done
for session in $(others); do loginctl kill-session --signal=SIGKILL "$session" 2>/dev/null || true; done
for _ in $(seq 1 50); do [ -n "$(others)" ] || break; sleep 1; done
open=$(others | tr '\\n' ' ')
[ -z "$open" ] || { echo "sessions of an earlier lease are still open: $open" >&2; false; }`;
/** Where a build machine keeps the commits it is sent: a bare repository of its own, apart from any gate checkout. */
const MACHINE_GIT_DIR = `${USER_HOME}/slipjay-machine.git`;

/**
 * Removes every container on the VM but the image's own: a stopped `keep-*` one holding a Docker image the gate uses, or
 * one labelled `slipjay.keep=true`, such as a database service the gate expects under a fixed name.
 */
export const REMOVE_CONTAINERS = `docker ps -a --format '{{.Names}} {{.Label "slipjay.keep"}}' | awk '$1 !~ /^keep-/ && $2 != "true" { print $1 }' | xargs -r docker rm -f >/dev/null 2>&1 || true`;

/**
 * Starts every `slipjay.keep=true` container that is not running. Boat's snapshot restore can recreate one without
 * starting it, and a database service the gate reaches by name then has no address, so every attempt on that VM fails.
 */
export const START_KEPT_CONTAINERS = `docker ps -a --filter label=slipjay.keep=true --filter status=created --filter status=exited --format '{{.Names}}' | xargs -r docker start >/dev/null 2>&1 || true`;

type Vm = { id: string; name: string; state: string; host: string; port: number; size: string; hydrated: boolean; health: string; healthReason: string };

export type BoatVerifierOptions = NonNullable<RunnerConfig["boat"]> & {
  /** Runs the boat CLI and ssh; tests replace it. */
  run?: (request: BoundedProcessRequest) => Promise<BoundedProcessResult>;
  /** Where local scratch (bundles) goes. */
  scratch?: string;
  /** A directory holding one file per VM forked but not yet named into its pool, so a restart can delete it. */
  pending?: string;
  /** How long recovery retries; tests shorten it. */
  recoveryMs?: number;
  /** Total API retry budget while opening a VM, and initial backoff; tests shorten them. */
  openRetryMs?: number;
  openRetryDelayMs?: number;
  /** How long to wait for a VM's disk to restore and ssh to answer; tests shorten it. */
  readyTimeoutMs?: number;
};

export function boatVerification(options: BoatVerifierOptions): RemoteVerification {
  const run = options.run ?? runBoundedProcess;
  const cli = options.cli ?? join(homedir(), ".ascii/bin/boat");
  const key = options.sshKey ?? join(homedir(), ".ssh/ascii_box_ed25519");
  const size = options.size ?? "default";
  const fail = (what: string, detail: string): never => { throw new Error(`Remote executor unavailable (boat): ${what}: ${detail.trim().slice(0, 2000)}`); };

  async function boat(args: string[], signal?: AbortSignal, timeoutMs = BOAT_TIMEOUT_MS): Promise<unknown> {
    signal?.throwIfAborted();
    const result = await run({ executable: cli, args: [...args, "--json", "--no-update"], cwd: tmpdir(), timeoutMs,
      maxOutputBytes: CONTROL_OUTPUT, env: process.env, ...signal ? { abortSignal: signal } : {} });
    const last = result.stdout.trim().split("\n").at(-1) ?? "";
    let parsed: unknown;
    try { parsed = last ? JSON.parse(last) : null; } catch { parsed = null; }
    signal?.throwIfAborted();
    if (result.timedOut) throw Object.assign(new Error(`Remote executor unavailable (boat): boat ${args[0]}: no answer from boat within ${Math.round(timeoutMs / 1000)}s`), { boatUnavailable: true });
    if (result.exitCode !== 0 || (parsed && typeof parsed === "object" && "error" in parsed)) {
      const detail = (parsed as { error?: string } | null)?.error ?? (result.stderr || result.stdout || `exit ${result.exitCode}`);
      if (/could not reach (?:the )?boat api|rate limit|too many requests|\b429\b|connection refused|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|service unavailable|bad gateway|gateway timeout|\b50[234]\b/i.test(detail))
        throw Object.assign(new Error(`Remote executor unavailable (boat): boat ${args[0]}: ${detail.trim().slice(0, 2000)}`), { boatUnavailable: true });
      fail(`boat ${args[0]}`, detail);
    }
    return parsed;
  }
  const vmOf = (value: unknown): Vm => {
    const sandbox = ((value as { sandbox?: unknown })?.sandbox ?? value) as Record<string, unknown>;
    const endpoint = String(sandbox.sshEndpoint ?? "");
    const at = endpoint.lastIndexOf(":");
    return { id: String(sandbox.id), name: String(sandbox.name ?? ""), state: String(sandbox.state ?? ""),
      host: at > 0 ? endpoint.slice(0, at) : "", port: at > 0 ? Number(endpoint.slice(at + 1)) : 0, size: String(sandbox.type ?? size),
      // Only boat's explicit word that the disk is restored makes a VM ready: a field it leaves out proves nothing.
      hydrated: sandbox.hydrated === true, health: String(sandbox.health ?? ""), healthReason: String(sandbox.healthReason ?? "") };
  };
  const sshArgs = (vm: Vm) => ["-i", key, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=8", "-p", String(vm.port), `user@${vm.host}`];
  /** Runs `script` on `vm` for the verifier's own control; a nonzero exit throws, naming `what`. */
  async function control(vm: Vm, what: string, script: string, { input, timeoutMs = CONTROL_TIMEOUT_MS, signal }: { input?: Buffer; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
    const result = await run({ executable: "ssh", args: [...sshArgs(vm), `bash -lc ${shellWord(`set -euo pipefail\nexport PATH=${REMOTE_PATH}:$PATH\n${script}`)}`], cwd: tmpdir(), timeoutMs,
      maxOutputBytes: CONTROL_OUTPUT, env: process.env, ...input ? { input } : {}, ...signal ? { abortSignal: signal } : {} });
    if (sshFailed(result) || result.timedOut) fail(`${what} on ${vm.name}`, result.stderr || "timed out");
    if (result.exitCode !== 0) throw new Error(`Remote executor unavailable (setup): ${what} on ${vm.name} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(-2000)}`);
    return result.stdout.trim();
  }

  /**
   * The pool VM for `repo`'s `slot`, running and reachable: forked from `image` when missing, resumed when stopped, and
   * given `lifetimeS` to live, after which boat stops it.
   */
  /**
   * Each build machine's acquisitions, one at a time: two acquisitions of a missing VM at once would fork it twice. A later
   * one waits for the first, then finds the VM running and only extends it.
   */
  const buildTurns = new Map<string, Promise<unknown>>();
  function buildMachine(repo: string, pool: string, signal: AbortSignal | undefined, lifetimeS: number): Promise<Vm> {
    const name = poolName(repo, pool);
    const turn = (buildTurns.get(name) ?? Promise.resolve()).catch(() => undefined).then(() => machine(repo, pool, signal, lifetimeS, false, true));
    buildTurns.set(name, turn.catch(() => undefined));
    return turn;
  }

  async function machine(repo: string, slot: number | string, signal: AbortSignal | undefined, lifetimeS = ATTEMPT_LIFETIME_S, retry = false, build = false, reuseOnly = false): Promise<Vm> {
    // Only API failures before setup are retried. The budget spans all calls in this open, with each call bounded
    // by the remaining time. Retrying an ambiguous fork could create a second VM, so a timed-out fork goes to the hold.
    let retryDeadline: number | undefined;
    let failures = 0;
    const api = async (args: string[], callSignal?: AbortSignal): Promise<unknown> => {
      let retrying = false;
      for (;;) {
        callSignal?.throwIfAborted();
        try { return await boat(args, callSignal, !retrying || retryDeadline === undefined ? BOAT_TIMEOUT_MS : Math.max(1, Math.min(BOAT_TIMEOUT_MS, retryDeadline - Date.now()))); }
        catch (error) {
          callSignal?.throwIfAborted();
          if (!retry || !(error as RemoteOpenFailure)?.boatUnavailable) throw error;
          retrying = true;
          retryDeadline ??= Date.now() + (options.openRetryMs ?? 180_000);
          const left = retryDeadline - Date.now();
          if (left <= 0 || args[0] === "fork" && /no answer from boat/.test(String(error))) throw error;
          await delay(Math.min(left, 30_000, (options.openRetryDelayMs ?? 2000) * 2 ** Math.min(failures++, 16)), undefined, { signal: callSignal });
          if (Date.now() >= retryDeadline) throw error;
        }
      }
    };
    const name = poolName(repo, slot);
    /**
     * The slot's VM, resumed when boat stopped it and forked from the image when missing. `broken` is a VM that will no
     * longer serve the slot: it is left out even while boat still lists it, so a fresh fork takes the slot's name.
     */
    const acquire = async (broken?: string): Promise<Vm> => {
      // `--all`: boat lists only running sandboxes by default, and a pool VM boat stopped when idle must be resumed, not
      // forked again under the same name.
      const listed = await api(["list", "--all"], signal) as { sandboxes?: unknown[] } | null;
      const named = (listed?.sandboxes ?? []).map(vmOf).filter((entry) => entry.name === name && entry.id !== broken);
      let found = named.find((entry) => !STOPPED.includes(entry.state)) ?? named[0];
      // A second VM under the slot's name is a leftover fork; only one may hold the slot.
      for (const extra of named) if (extra !== found) await api(["delete", extra.id, "--yes"], signal).catch(() => undefined);
      // A landing's retry spends no boat start beyond resuming: forking the slot afresh is the first attempt's alone.
      if (!found && reuseOnly) fail(`${name} not reachable`, "no VM holds the slot, and a retry forks none");
      if (!found) {
        found = vmOf(await api(["fork", options.image, "--no-env", "--no-monitoring", "--ttl", String(lifetimeS), "--type", size], signal));
        // Until it carries its pool name, only this file says the VM is ours: a restart in between deletes it.
        const record = options.pending ? join(options.pending, found.id) : undefined;
        if (record) { await mkdir(options.pending!, { recursive: true }); await writeFile(record, name); }
        await api(["rename", found.id, name], signal);
        if (record) await unlink(record).catch(() => undefined);
        found = { ...found, name };
      } else if (STOPPED.includes(found.state)) {
        await api(["resume", found.id], signal);
      }
      await api(["extend", found.id, "--ttl", String(lifetimeS)], signal);
      return found;
    };
    const readyMs = options.readyTimeoutMs ?? (build ? BUILD_READY_TIMEOUT_MS : READY_TIMEOUT_MS);
    let vm = await acquire();
    let deadline = Date.now() + readyMs;
    let replaced = false;
    for (;;) {
      vm = { ...vmOf(await api(["info", vm.id], signal)), name };
      // A resumed VM answers ssh about a minute before boat has restored its disk, and finishing the restore swaps the
      // filesystem under any running command: setup run before then loses its checkout ("not a git repository").
      if (vm.host && vm.port && vm.hydrated) {
        const probe = await run({ executable: "ssh", args: [...sshArgs(vm), "true"], cwd: tmpdir(), timeoutMs: 20_000, maxOutputBytes: 4096, env: process.env, ...signal ? { abortSignal: signal } : {} });
        if (probe.exitCode === 0) return vm;
      }
      // Boat calls a restore it cannot finish degraded, and retries it forever; waiting out the ready timeout only re-leases
      // the same dead disk on every later deploy. So a degraded VM whose disk is not restored is broken now.
      const stalled = vm.health === "degraded" && !vm.hydrated;
      if (stalled || Date.now() >= deadline) {
        const health = stalled ? `, health ${vm.health}${vm.healthReason ? ` (${vm.healthReason})` : ""}` : "";
        const detail = `state ${vm.state}${health}${vm.hydrated ? "" : ", disk still restoring"}${stalled ? "" : ` after ${readyMs / 1000}s`}`;
        // A slot whose disk boat never restores is broken, not merely slow: delete it and fork the image afresh once, so
        // every later landing on the lane does not wait on the same dead disk. A replacement that also will not restore
        // fails as infrastructure rather than forking again, since boat starts are rationed. A build machine is replaced
        // only when boat reports it degraded: while its restore is merely slow it waits BUILD_READY_TIMEOUT_MS and then
        // fails, keeping the disk its warm build cache is on.
        // Marked: boat supplied no machine for want of a restore, which a landing retries (only by waiting on the same VM,
        // `reuseOnly`); a refusal such as a plan limit is not marked and fails at once.
        if (build && !stalled || replaced || vm.hydrated || reuseOnly)
          throw Object.assign(new Error(`Remote executor unavailable (boat): ${name} not reachable: ${detail.trim()}`), { machineUnavailable: true });
        replaced = true;
        await api(["delete", vm.id, "--yes"], signal);
        vm = await acquire(vm.id);
        deadline = Date.now() + readyMs;
        continue;
      }
      if (signal?.aborted) fail(`${name} not reachable`, "attempt cancelled");
      await delay(3000, undefined, { signal });
    }
  }

  /**
   * Stops every scope an attempt started, removes every container but the image's kept ones, starts a kept one a restore left stopped, and removes the remote scratch
   * the attempt's commands created, and cleans the checkout's untracked files, so the next attempt starts from none of it.
   * It also drops dangling images, unused volumes and unreachable Git objects, so a long-lived VM's disk stays bounded.
   */
  const cleanScript = `systemctl --user stop 'slipjay-run-*.scope' 2>/dev/null || true
${REMOVE_CONTAINERS}
${START_KEPT_CONTAINERS}
if [ -f ${SCRATCH_LIST} ]; then sort -u ${SCRATCH_LIST} | while IFS= read -r path; do [ -n "$path" ] && [ "$path" != / ] && rm -rf -- "$path"; done; rm -f ${SCRATCH_LIST}; fi
docker image prune -f >/dev/null 2>&1 || true
docker volume prune -f >/dev/null 2>&1 || true
repo=$(cat ~/.slipjay-repo 2>/dev/null || echo ~/repo); [ -d "$repo" ] && { git -C "$repo" clean -ffdxq -e node_modules -e .jj; git -C "$repo" gc --auto --quiet; } || true`;
  /** The VM's billed seconds and dollars so far, as boat reports them; null when it cannot say. */
  const usage = async (vm: Vm, signal?: AbortSignal) => {
    const value = await boat(["usage", vm.id], signal).catch(() => null) as { seconds?: unknown; dollars?: unknown } | null;
    return typeof value?.seconds === "number" && typeof value.dollars === "number" ? { seconds: value.seconds, dollars: value.dollars } : null;
  };

  const { local, bundleMissing } = remoteFiles(run);

  const scratchDirectory = async () => {
    await mkdir(options.scratch ?? tmpdir(), { recursive: true });
    return mkdtemp(join(options.scratch ?? tmpdir(), "slipjay-boat-"));
  };

  return {
    async probe(signal) {
      try { await boat(["list", "--all"], signal); }
      catch (error) {
        signal.throwIfAborted();
        // An API refusal proves it answers again. The next opening reports that refusal normally, rather than
        // hiding a permanent authentication or plan problem behind an availability hold.
        if ((error as RemoteOpenFailure)?.boatUnavailable) throw error;
      }
    },
    async lease({ repo, pool, gitDirectory, commitId, lifetimeS, signal }): Promise<MachineLease> {
      // The command's own time, then the idle lifetime: a runner that dies mid-command still leaves the VM to stop.
      const vm = await buildMachine(repo, pool, signal, lifetimeS + IDLE_LIFETIME_S);
      const machineInfo: RemoteMachine = { verifier: "boat", id: vm.id, name: vm.name, size: vm.size, image: options.image };
      const billed = await usage(vm, signal);
      const scratch = await scratchDirectory();
      const idle = async () => {
        await boat(["extend", vm.id, "--ttl", String(IDLE_LIFETIME_S)]).catch(() => undefined);
        await rm(scratch, { recursive: true, force: true });
      };
      try {
        await control(vm, "end the previous lease", FENCE_SCRIPT, { signal });
        await receiveBuildCommit((what, script, options) => control(vm, what, script, { ...options, signal }), { local, bundleMissing },
          { gitDirectory, gitDir: MACHINE_GIT_DIR, pool, commitId, bundle: join(scratch, "commit.bundle") });
        // One executable the command runs ssh through, so it needs neither the key nor the VM's address.
        const ssh = join(scratch, "ssh");
        await writeFile(ssh, `#!/bin/sh\nexec ssh ${sshArgs(vm).map(shellWord).join(" ")} "$@"\n`, { mode: 0o700 });
        return {
          machine: machineInfo,
          env: { SLIPJAY_MACHINE_SSH: ssh, SLIPJAY_MACHINE_GIT_DIR: MACHINE_GIT_DIR },
          async close() {
            const after = await usage(vm);
            await idle();
            return billed && after ? { seconds: after.seconds - billed.seconds, dollars: after.dollars - billed.dollars } : null;
          },
        };
      } catch (error) {
        await idle();
        throw error;
      }
    },
    async open({ repo, slot: inputSlot, pool, screening, retrying, checkout, base, candidate, integrationBranch, signal }): Promise<RemoteAttempt> {
      const slot = pool ?? (screening ? `${inputSlot}-screen` : inputSlot);
      // A named pool (a batch check's VM, SJ-192) takes turns as a build machine does, and is never forked afresh while it is merely slow.
      const vm = pool ? await buildMachine(repo, pool, signal, ATTEMPT_LIFETIME_S) : await machine(repo, slot, signal, ATTEMPT_LIFETIME_S, true, false, retrying === true);
      const machineInfo: RemoteMachine = { verifier: "boat", id: vm.id, name: vm.name, size: vm.size, image: options.image };
      // Read before setup, so the attempt's spend includes the time spent preparing the VM.
      const billed = await usage(vm, signal);
      try { return await prepare(); } catch (error) {
        // A failed setup idles its VM as a closed attempt does, best effort, so it stops after IDLE_LIFETIME_S and not the
        // attempt's lifetime. It still spent the VM's time: the failure carries a reading, so the window's spend counts it.
        await control(vm, "clean", cleanScript).catch(() => undefined);
        await boat(["extend", vm.id, "--ttl", String(IDLE_LIFETIME_S)]).catch(() => undefined);
        throw Object.assign(error instanceof Error ? error : new Error(String(error)),
          { remote: { machine: machineInfo, usageBefore: billed, usage: await usage(vm) } satisfies RemoteOpenFailure["remote"] });
      }
      async function prepare(): Promise<RemoteAttempt> {
        await control(vm, "clean", cleanScript, { signal });
        // Send what the VM lacks of the candidate and its base, under refs of this slot.
        const heads = (await control(vm, "list commits", `repo=$(cat ~/.slipjay-repo 2>/dev/null || echo ~/repo); git -C "$repo" for-each-ref --format='%(objectname)'`, { signal }))
          .split("\n").filter((line) => /^[0-9a-f]{40}$/.test(line));
        const scratch = await scratchDirectory();
        const ref = `refs/slipjay/boat/${slot}`;
        try {
          await local("git", ["update-ref", `${ref}/candidate`, candidate], checkout);
          await local("git", ["update-ref", `${ref}/base`, base], checkout);
          const bundle = await bundleMissing(checkout, [`${ref}/candidate`, `${ref}/base`], heads, join(scratch, "candidate.bundle"));
          const tree = await local("git", ["rev-parse", `${candidate}^{tree}`], checkout);
          const observed = await control(vm, "check out the candidate", `target=${shellWord(checkout)}
  current=$(cat ~/.slipjay-repo 2>/dev/null || echo ~/repo)
  if [ "$current" != "$target" ]; then sudo mkdir -p "$(dirname "$target")"; sudo chown user "$(dirname "$target")"; rm -rf "$target"; mv "$current" "$target"; echo "$target" > ~/.slipjay-repo; fi
  cd "$target"
  ${receiveCandidate({ bundle: "/tmp/slipjay-candidate.bundle", ref, candidate, base, integrationBranch, bookmarkPrefix: `slipjay-boat-${slot}` })}
  ${frozenInstall("/tmp/slipjay-install.log")}
  # An assignment, so a failing git command stops the script under -e and its stderr reaches the error.
  observed=$(${worktreeTree(tree)})
  echo "tree $observed"`, { input: bundle, timeoutMs: SETUP_TIMEOUT_MS, signal });
          const line = (label: string) => observed.split("\n").findLast((entry) => entry.startsWith(`${label} `))?.slice(label.length + 1) ?? "";
          const observedTree = line("tree");
          if (observedTree !== tree) throw new Error(`Remote executor unavailable (setup): ${vm.name}'s checkout holds tree ${observedTree || "none"} after setup, not the candidate's ${tree}`);
          const [runtimePath = "", runtimeVersion = "", runtimeSha = ""] = line("runtime").split(" ");
          const runtime: RuntimeIdentity | undefined = runtimePath && runtimeVersion && runtimeSha ? { name: "bun", version: runtimeVersion, path: runtimePath, sha256: runtimeSha } : undefined;
          // A gate reads Build through the runner's loopback grant endpoint: the same port on the VM tunnels back here. One
          // SSH master per attempt holds every forward, so concurrent gate commands share a port rather than race for it.
          const socket = join(scratch, "tunnel.sock");
          let master: Promise<void> | undefined;
          const forwards = new Map<number, Promise<void>>();
          const forward = (port: number) => {
            let added = forwards.get(port);
            if (!added) {
              added = (async () => {
                master ??= (async () => {
                  const log = join(scratch, "tunnel.log");
                  const opened = await run({ executable: "bash", args: ["-c", `exec ssh -f -N -M -S ${shellWord(socket)} ${sshArgs(vm).map(shellWord).join(" ")} </dev/null >/dev/null 2>${shellWord(log)}`],
                    cwd: tmpdir(), timeoutMs: BOAT_TIMEOUT_MS, maxOutputBytes: CONTROL_OUTPUT, env: process.env });
                  if (opened.exitCode !== 0) fail(`open the Build tunnel to ${vm.name}`, await readFile(log, "utf8").catch(() => `exit ${opened.exitCode}`));
                })();
                await master;
                const result = await run({ executable: "ssh", args: ["-S", socket, "-O", "forward", "-R", `127.0.0.1:${port}:127.0.0.1:${port}`, `user@${vm.host}`],
                  cwd: tmpdir(), timeoutMs: BOAT_TIMEOUT_MS, maxOutputBytes: CONTROL_OUTPUT, env: process.env });
                if (result.exitCode !== 0) fail(`forward Build port ${port} to ${vm.name}`, result.stderr || `exit ${result.exitCode}`);
              })();
              forwards.set(port, added);
            }
            return added;
          };
          const executor = {
            host: `boat:${vm.name}`,
            ...runtime ? { runtime } : {},
            async run(request: BoundedProcessRequest): Promise<BoundedProcessResult> {
              const unit = `slipjay-run-${randomUUID()}`;
              const build = loopbackPort(request.env?.SLIPJAY_BUILD_READ_URL);
              if (build) await forward(build);
              const result = await run({ ...request, executable: "ssh", args: [...sshArgs(vm), `bash -lc ${shellWord(remoteCommand(request, unit))}`],
                cwd: tmpdir(), env: process.env });
              if (sshFailed(result)) throw new Error(`executor lost: ssh to boat VM ${vm.name}: ${result.stderr.trim().slice(-500)}`);
              // A cancelled or timed-out command's local ssh is gone; its remote scope is not.
              if (result.cancelled || result.timedOut) await control(vm, "stop the command", `systemctl --user stop ${shellWord(`${unit}.scope`)} 2>/dev/null || true`).catch(() => undefined);
              const reports = request.env?.[TEST_REPORT_DIR_ENV];
              if (reports) await collectRemoteReports(run, sshArgs(vm), reports, reports, scratch, unit);
              return result;
            },
          };
          return {
            executor, machine: machineInfo, tree, usage: billed,
            async finish() {
              // What the checkout holds now, against the candidate itself: colocated jj keeps Git's HEAD at its parent.
              const after = await control(vm, "read the checkout", `cd ${shellWord(checkout)}
  now=$(${worktreeTree(tree)})
  echo "tree $now"; echo "changed $(git diff --name-only ${shellWord(tree)} "$now" | wc -l)"`);
              const read = (label: string) => after.split("\n").findLast((entry) => entry.startsWith(`${label} `))?.slice(label.length + 1) ?? "";
              const changed = Number(read("changed")) || 0;
              return { tree: read("tree") === tree ? tree : null, trackedChanges: read("tree") === tree ? 0 : Math.max(changed, 1), usage: await usage(vm) };
            },
            async close() {
              if (master) await run({ executable: "ssh", args: ["-S", socket, "-O", "exit", `user@${vm.host}`], cwd: tmpdir(), timeoutMs: BOAT_TIMEOUT_MS,
                maxOutputBytes: CONTROL_OUTPUT, env: process.env }).catch(() => undefined);
              await control(vm, "clean", cleanScript).catch(() => undefined);
              await boat(["extend", vm.id, "--ttl", String(IDLE_LIFETIME_S)]).catch(() => undefined);
              await rm(scratch, { recursive: true, force: true });
            },
          };
        } catch (error) {
          await rm(scratch, { recursive: true, force: true });
          throw error;
        }
      }
    },
    async recover(repos) {
      // Each pool VM still running is cleaned, and a VM forked but never named into its pool, the runner's and no one
      // else's, is deleted, its record kept until boat confirms or no longer lists it. Both are retried, every call bounded
      // by what is left of four minutes, and every attempt cleans its VM first in any case, so nothing an earlier process
      // started can reach a later gate.
      const deadline = Date.now() + (options.recoveryMs ?? RECOVERY_MS);
      const left = (cap: number) => Math.max(1, Math.min(cap, deadline - Date.now()));
      const dirty = new Set<string>();
      for (let round = 0; ; round++) {
        // Half of what is left at most, so the retry after a wait still has time to run.
        if (round) await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, Math.max(0, (deadline - Date.now()) / 2))));
        const listed = await boat(["list", "--all"], undefined, left(BOAT_TIMEOUT_MS)).catch(() => null) as { sandboxes?: unknown[] } | null;
        if (listed) {
          const sandboxes = (listed.sandboxes ?? []).map(vmOf);
          dirty.clear();
          const running = sandboxes.filter((vm) => repos.some((repo) => isSlotVm(repo, vm.name)) && vm.host && !STOPPED.includes(vm.state));
          for (const vm of running) {
            if (deadline <= Date.now() || !await control(vm, "clean", cleanScript, { timeoutMs: left(CONTROL_TIMEOUT_MS) }).then(() => true, () => false)) dirty.add(vm.name);
          }
          for (const id of options.pending ? await readdir(options.pending).catch(() => [] as string[]) : []) {
            const gone = !sandboxes.some((vm) => vm.id === id)
              || (deadline > Date.now() && await boat(["delete", id, "--yes"], undefined, left(BOAT_TIMEOUT_MS)).then(() => true, () => false));
            if (gone) await unlink(join(options.pending!, id)).catch(() => undefined);
            else dirty.add(id);
          }
          if (!dirty.size) return;
        }
        if (Date.now() >= deadline) break;
      }
      throw new Error(`Remote executor unavailable (boat): could not ${dirty.size ? `delete or clean ${[...dirty].join(", ")}` : "list the pool VMs"} after a restart`);
    },
  };
}
