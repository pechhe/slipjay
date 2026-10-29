import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runBoundedProcess, type BoundedProcessRequest, type BoundedProcessResult } from "../infra/bounded-process.ts";
import { SYSTEMD_SLICE_ENV } from "./runner-contract.ts";
import { TEST_REPORT_DIR_ENV } from "./test-reports.ts";
import type { RemoteAttempt, RemoteMachine, RemoteOpenFailure, RemoteVerification, RunnerConfig, RuntimeIdentity } from "./runner-types.ts";

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
/** Runner-host variables that describe the host, not the command, so they never reach the VM. */
const HOST_ONLY = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", SYSTEMD_SLICE_ENV]);
const READY_TIMEOUT_MS = 300_000;
/** Each boat API call: an unreachable API fails the attempt well inside a minute. */
const BOAT_TIMEOUT_MS = 30_000;
const CONTROL_TIMEOUT_MS = 120_000;
/**
 * Boat stops a VM when its lifetime runs out, snapshotting its disk for a later resume, so the lifetime is the idle
 * timer: long enough for any attempt while one runs, IDLE_LIFETIME_S once it closes. A runner restart loses no timer.
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
 * The checkout's files as a tree, read through a throwaway index so neither Git's nor jj's state moves: what the gate
 * actually ran against. The index starts from the candidate's `tree`, so a tracked file that matches an ignore rule
 * stays in it, and `add -A` then records every change, deletion and untracked file that is not ignored.
 */
export const worktreeTree = (tree: string) => `index=$(mktemp); trap 'rm -f "$index"' EXIT
GIT_INDEX_FILE="$index" git read-tree ${shellWord(tree)} && GIT_INDEX_FILE="$index" git add -A . && GIT_INDEX_FILE="$index" git write-tree`;
const SETUP_TIMEOUT_MS = 900_000;
const CONTROL_OUTPUT = 1024 * 1024;

/** Quotes `value` as one POSIX shell word. */
export const shellWord = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** A pool VM's name: stable per repository and slot, so a later runner process finds the same one. */
export const poolName = (repo: string, slot: number): string => `slipjay-${repo.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${slot}`;

/**
 * The remote script for `request`: in the checkout path, under a scope `close` can stop, with the command's own
 * environment and the VM's PATH and HOME. TMPDIR and the test-report directory exist before it starts.
 */
export function remoteCommand(request: Pick<BoundedProcessRequest, "executable" | "args" | "cwd" | "env">, unit: string): string {
  const env = Object.entries(request.env ?? {}).filter(([key, value]) => value !== undefined && !HOST_ONLY.has(key)) as [string, string][];
  const directories = [request.env?.TMPDIR, request.env?.[TEST_REPORT_DIR_ENV]].filter((value): value is string => Boolean(value));
  return [
    ...directories.length ? [`printf '%s\\n' ${directories.map(shellWord).join(" ")} >> ${SCRATCH_LIST}`, `mkdir -p ${directories.map(shellWord).join(" ")}`] : [],
    `cd ${shellWord(request.cwd)}`,
    ["exec systemd-run --user --scope --quiet --collect", `--unit=${shellWord(unit)}`, "env -i",
      ...[["HOME", USER_HOME], ["USER", "user"], ["PATH", REMOTE_PATH], ...env].map(([key, value]) => shellWord(`${key}=${value}`)),
      shellWord(request.executable), ...request.args.map(shellWord)].join(" "),
  ].join(" && ");
}

/** An SSH failure, as opposed to the remote command's own exit status: ssh exits 255 for its own errors. */
const sshFailed = (result: BoundedProcessResult) => result.exitCode === 255 && /^(?:ssh|kex_exchange|Connection (?:closed|reset|timed out|refused)|client_loop)\b|\bssh: /m.test(result.stderr);

type Vm = { id: string; name: string; state: string; host: string; port: number; size: string };

/** A loopback port in `url`, which a remote command reaches through a reverse tunnel to the runner host. */
export const loopbackPort = (url: string | undefined): number | undefined => {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) return undefined;
    return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  } catch { return undefined; }
};

export type BoatVerifierOptions = NonNullable<RunnerConfig["boat"]> & {
  /** Runs the boat CLI and ssh; tests replace it. */
  run?: (request: BoundedProcessRequest) => Promise<BoundedProcessResult>;
  /** Where local scratch (bundles) goes. */
  scratch?: string;
  /** A directory holding one file per VM forked but not yet named into its pool, so a restart can delete it. */
  pending?: string;
  /** How long recovery retries; tests shorten it. */
  recoveryMs?: number;
};

export function boatVerification(options: BoatVerifierOptions): RemoteVerification {
  const run = options.run ?? runBoundedProcess;
  const cli = options.cli ?? join(homedir(), ".ascii/bin/boat");
  const key = options.sshKey ?? join(homedir(), ".ssh/ascii_box_ed25519");
  const size = options.size ?? "default";
  const fail = (what: string, detail: string): never => { throw new Error(`Remote executor unavailable (boat): ${what}: ${detail.trim().slice(0, 2000)}`); };

  async function boat(args: string[], signal?: AbortSignal, timeoutMs = BOAT_TIMEOUT_MS): Promise<unknown> {
    const result = await run({ executable: cli, args: [...args, "--json", "--no-update"], cwd: tmpdir(), timeoutMs,
      maxOutputBytes: CONTROL_OUTPUT, env: process.env, ...signal ? { abortSignal: signal } : {} });
    const last = result.stdout.trim().split("\n").at(-1) ?? "";
    let parsed: unknown;
    try { parsed = last ? JSON.parse(last) : null; } catch { parsed = null; }
    if (result.timedOut) fail(`boat ${args[0]}`, `no answer from boat within ${Math.round(timeoutMs / 1000)}s`);
    if (result.exitCode !== 0 || (parsed && typeof parsed === "object" && "error" in parsed))
      fail(`boat ${args[0]}`, (parsed as { error?: string } | null)?.error ?? (result.stderr || result.stdout || `exit ${result.exitCode}`));
    return parsed;
  }
  const vmOf = (value: unknown): Vm => {
    const sandbox = ((value as { sandbox?: unknown })?.sandbox ?? value) as Record<string, unknown>;
    const endpoint = String(sandbox.sshEndpoint ?? "");
    const at = endpoint.lastIndexOf(":");
    return { id: String(sandbox.id), name: String(sandbox.name ?? ""), state: String(sandbox.state ?? ""),
      host: at > 0 ? endpoint.slice(0, at) : "", port: at > 0 ? Number(endpoint.slice(at + 1)) : 0, size: String(sandbox.type ?? size) };
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

  /** The pool VM for `repo`'s `slot`, running and reachable: forked from `image` when missing, resumed when stopped. */
  async function machine(repo: string, slot: number, signal: AbortSignal): Promise<Vm> {
    const name = poolName(repo, slot);
    // `--all`: boat lists only running sandboxes by default, and a pool VM boat stopped when idle must be resumed, not
    // forked again under the same name.
    const listed = await boat(["list", "--all"], signal) as { sandboxes?: unknown[] } | null;
    const named = (listed?.sandboxes ?? []).map(vmOf).filter((entry) => entry.name === name);
    let vm = named.find((entry) => !STOPPED.includes(entry.state)) ?? named[0];
    // A second VM under the slot's name is a leftover fork; only one may hold the slot.
    for (const extra of named) if (extra !== vm) await boat(["delete", extra.id, "--yes"], signal).catch(() => undefined);
    if (!vm) {
      vm = vmOf(await boat(["fork", options.image, "--no-env", "--no-monitoring", "--ttl", String(ATTEMPT_LIFETIME_S), "--type", size], signal));
      // Until it carries its pool name, only this file says the VM is ours: a restart in between deletes it.
      const record = options.pending ? join(options.pending, vm.id) : undefined;
      if (record) { await mkdir(options.pending!, { recursive: true }); await writeFile(record, name); }
      await boat(["rename", vm.id, name], signal);
      if (record) await unlink(record).catch(() => undefined);
      vm = { ...vm, name };
    } else if (STOPPED.includes(vm.state)) {
      await boat(["resume", vm.id], signal);
    }
    await boat(["extend", vm.id, "--ttl", String(ATTEMPT_LIFETIME_S)], signal);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      vm = { ...vmOf(await boat(["info", vm.id], signal)), name };
      if (vm.host && vm.port) {
        const probe = await run({ executable: "ssh", args: [...sshArgs(vm), "true"], cwd: tmpdir(), timeoutMs: 20_000, maxOutputBytes: 4096, env: process.env, abortSignal: signal });
        if (probe.exitCode === 0) return vm;
      }
      if (Date.now() > deadline) fail(`${name} not reachable`, `state ${vm.state} after ${READY_TIMEOUT_MS / 1000}s`);
      if (signal.aborted) fail(`${name} not reachable`, "attempt cancelled");
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  /**
   * Stops every scope an attempt started, removes every container but the image's `keep-` ones and the remote scratch
   * the attempt's commands created, and cleans the checkout's untracked files, so the next attempt starts from none of it.
   * It also drops dangling images, unused volumes and unreachable Git objects, so a long-lived VM's disk stays bounded.
   */
  const cleanScript = `systemctl --user stop 'slipjay-run-*.scope' 2>/dev/null || true
docker ps -a --format '{{.Names}}' | grep -v '^keep-' | xargs -r docker rm -f >/dev/null 2>&1 || true
if [ -f ${SCRATCH_LIST} ]; then sort -u ${SCRATCH_LIST} | while IFS= read -r path; do [ -n "$path" ] && [ "$path" != / ] && rm -rf -- "$path"; done; rm -f ${SCRATCH_LIST}; fi
docker image prune -f >/dev/null 2>&1 || true
docker volume prune -f >/dev/null 2>&1 || true
repo=$(cat ~/.slipjay-repo 2>/dev/null || echo ~/repo); [ -d "$repo" ] && { git -C "$repo" clean -ffdxq -e node_modules -e .jj; git -C "$repo" gc --auto --quiet; } || true`;
  /** The VM's billed seconds and dollars so far, as boat reports them; null when it cannot say. */
  const usage = async (vm: Vm, signal?: AbortSignal) => {
    const value = await boat(["usage", vm.id], signal).catch(() => null) as { seconds?: unknown; dollars?: unknown } | null;
    return typeof value?.seconds === "number" && typeof value.dollars === "number" ? { seconds: value.seconds, dollars: value.dollars } : null;
  };

  async function local(executable: string, args: string[], cwd: string): Promise<string> {
    const result = await run({ executable, args, cwd, timeoutMs: CONTROL_TIMEOUT_MS, maxOutputBytes: CONTROL_OUTPUT, env: process.env });
    if (result.exitCode !== 0) throw new Error(`Remote executor unavailable (setup): ${executable} ${args[0]} failed: ${result.stderr.trim().slice(-1000)}`);
    return result.stdout.trim();
  }

  return {
    async open({ repo, slot, checkout, base, candidate, integrationBranch, signal }): Promise<RemoteAttempt> {
      const vm = await machine(repo, slot, signal);
      const machineInfo: RemoteMachine = { verifier: "boat", id: vm.id, name: vm.name, size: vm.size, image: options.image };
      // Read before setup, so the attempt's spend includes the time spent preparing the VM.
      const billed = await usage(vm, signal);
      try { return await prepare(); } catch (error) {
        // A setup that fails still spent the VM's time: the failure carries a reading, so the window's spend counts it.
        throw Object.assign(error instanceof Error ? error : new Error(String(error)),
          { remote: { machine: machineInfo, usageBefore: billed, usage: await usage(vm) } satisfies RemoteOpenFailure["remote"] });
      }
      async function prepare(): Promise<RemoteAttempt> {
        await control(vm, "clean", cleanScript, { signal });
        // Send what the VM lacks of the candidate and its base, under refs of this slot.
        const heads = (await control(vm, "list commits", `repo=$(cat ~/.slipjay-repo 2>/dev/null || echo ~/repo); git -C "$repo" for-each-ref --format='%(objectname)'`, { signal }))
          .split("\n").filter((line) => /^[0-9a-f]{40}$/.test(line));
        const known: string[] = [];
        for (const head of new Set(heads)) {
          const present = await run({ executable: "git", args: ["cat-file", "-e", `${head}^{commit}`], cwd: checkout, timeoutMs: 10_000, maxOutputBytes: 1024, env: process.env });
          if (present.exitCode === 0) known.push(head);
        }
        await mkdir(options.scratch ?? tmpdir(), { recursive: true });
        const scratch = await mkdtemp(join(options.scratch ?? tmpdir(), "slipjay-boat-"));
        const ref = `refs/slipjay/boat/${slot}`;
        try {
          await local("git", ["update-ref", `${ref}/candidate`, candidate], checkout);
          await local("git", ["update-ref", `${ref}/base`, base], checkout);
          const bundle = join(scratch, "candidate.bundle");
          const bundled = await run({ executable: "git", args: ["bundle", "create", bundle, `${ref}/candidate`, `${ref}/base`, ...known.map((head) => `^${head}`)],
            cwd: checkout, timeoutMs: SETUP_TIMEOUT_MS, maxOutputBytes: CONTROL_OUTPUT, env: process.env });
          // An empty bundle means the VM already holds both commits; git refuses to write one.
          const empty = bundled.exitCode !== 0 && /empty bundle/i.test(bundled.stderr);
          if (bundled.exitCode !== 0 && !empty) throw new Error(`Remote executor unavailable (setup): git bundle failed: ${bundled.stderr.trim().slice(-1000)}`);
          if (empty) await writeFile(bundle, "");
          const tree = await local("git", ["rev-parse", `${candidate}^{tree}`], checkout);
          const observed = await control(vm, "check out the candidate", `target=${shellWord(checkout)}
  current=$(cat ~/.slipjay-repo 2>/dev/null || echo ~/repo)
  if [ "$current" != "$target" ]; then sudo mkdir -p "$(dirname "$target")"; sudo chown user "$(dirname "$target")"; rm -rf "$target"; mv "$current" "$target"; echo "$target" > ~/.slipjay-repo; fi
  cd "$target"
  cat > /tmp/slipjay-candidate.bundle
  # Forced: a slot's refs move to whatever it verifies next, which need not descend from a candidate that never landed.
  if [ -s /tmp/slipjay-candidate.bundle ]; then git fetch /tmp/slipjay-candidate.bundle ${shellWord(`+${ref}/*:${ref}/*`)}; fi
  rm -f /tmp/slipjay-candidate.bundle
  # Bookmarks, so jj sees both commits whether this bundle carried them or an earlier one did.
  git update-ref ${shellWord(`refs/heads/slipjay-boat-${slot}-candidate`)} ${shellWord(candidate)}
  git update-ref ${shellWord(`refs/heads/slipjay-boat-${slot}-base`)} ${shellWord(base)}
  [ -d .jj ] || jj git init --colocate >/dev/null 2>&1
  jj git import --quiet >/dev/null 2>&1 || true
  jj bookmark set ${shellWord(integrationBranch)} -r ${shellWord(base)} --allow-backwards --quiet
  jj edit ${shellWord(candidate)} --quiet
  git clean -ffdxq -e node_modules -e .jj
  want=$(sed -nE 's/.*"packageManager": *"bun@([0-9.]+)".*/\\1/p' package.json | head -1)
  # As on the runner host, a candidate never makes the VM download a runtime: the image provides it.
  if [ -n "$want" ] && [ "$(bun --version 2>/dev/null)" != "$want" ]; then echo "the image has bun $(bun --version 2>/dev/null || echo none), the candidate needs bun $want: refresh the image" >&2; exit 1; fi
  if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile >/tmp/slipjay-install.log 2>&1 || { tail -40 /tmp/slipjay-install.log >&2; exit 1; }; fi
  bun=$(readlink -f "$(command -v bun)")
  echo "runtime $bun $(bun --version) $(sha256sum "$bun" | cut -d' ' -f1)"
  # An assignment, so a failing git command stops the script under -e and its stderr reaches the error.
  observed=$(${worktreeTree(tree)})
  echo "tree $observed"`, { input: await readFile(bundle), timeoutMs: SETUP_TIMEOUT_MS, signal });
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
              if (reports) {
                const archive = await run({ executable: "ssh", args: [...sshArgs(vm), `tar -C ${shellWord(reports)} -cf - . 2>/dev/null | base64 -w0`], cwd: tmpdir(),
                  timeoutMs: CONTROL_TIMEOUT_MS, maxOutputBytes: 64 * 1024 * 1024, env: process.env });
                if (archive.exitCode === 0 && archive.stdout.trim()) {
                  await mkdir(reports, { recursive: true });
                  const tarball = join(scratch, `${unit}.tar`);
                  await writeFile(tarball, Buffer.from(archive.stdout.trim(), "base64"));
                  await local("tar", ["-xf", tarball, "-C", reports], scratch);
                }
              }
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
          const running = sandboxes.filter((vm) => repos.some((repo) => vm.name.startsWith(`${poolName(repo, 0).slice(0, -1)}`))
            && vm.host && !STOPPED.includes(vm.state));
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
