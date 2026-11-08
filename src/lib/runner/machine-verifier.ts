import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runBoundedProcess, type BoundedProcessRequest, type BoundedProcessResult } from "../infra/bounded-process.ts";
import { cleanExclusions, collectRemoteReports, frozenInstall, loopbackPort, receiveCandidate, remoteCommand, remoteFiles, shellWord, sshFailed, worktreeTree, type RemoteRun } from "./remote-attempt.ts";
import { TEST_REPORT_DIR_ENV } from "./test-reports.ts";
import type { GateMachineConfig, MachineVerification, RemoteAttempt, RemoteMachine } from "./runner-types.ts";

/**
 * Read from inside a scope of the attempt, while its slice exists: the attempt slice's memory peak, and the out-of-memory
 * kill count of its parent (`slipjay-attempt.slice`), which carries the machine's limit and so records the kills that
 * limit makes anywhere beneath it. One gate holds the place at a time, so the count's change across the attempt is its own.
 */
const memoryReading = `cg=$(cut -d: -f3 /proc/self/cgroup); slice="/sys/fs/cgroup$(dirname "$cg")"; parent=$(dirname "$slice")
echo "memory $(cat "$slice/memory.peak" 2>/dev/null || echo -) $(awk '$1 == "oom_kill" {print $2}' "$parent/memory.events" 2>/dev/null || echo -) $(awk '$1 == "usage_usec" {print $2}' "$slice/cpu.stat" 2>/dev/null || echo -)"`;
const parseMemory = (reading: string): { peakBytes: number; limitKills: number; cpuUsec?: number } | undefined => {
  const [peak, kills, cpu] = reading.split(" ").map(Number);
  return Number.isFinite(peak) && Number.isFinite(kills) ? { peakBytes: peak!, limitKills: kills!, ...Number.isFinite(cpu) ? { cpuUsec: cpu! } : {} } : undefined;
};

/**
 * `placeRetainedPaths` from `slipjay.json` at `base` (the integration branch the candidate rebased onto): gitignore-style
 * patterns of untracked state a fixed place keeps between gates, such as keyed generated output. Anything malformed,
 * absolute or climbing out of the checkout is refused, so it only ever narrows the clean.
 */
async function retainedPaths(run: RemoteRun, checkout: string, base: string): Promise<string[]> {
  const shown = await run({ executable: "git", args: ["show", `${base}:slipjay.json`], cwd: checkout, env: process.env, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
  if (shown.exitCode !== 0) return [];
  let declared: unknown;
  try { declared = (JSON.parse(shown.stdout) as { placeRetainedPaths?: unknown }).placeRetainedPaths; } catch { return []; }
  if (!Array.isArray(declared)) return [];
  // Each pattern names a path at least two segments deep and every segment carries a literal character, so a typo such
  // as `*` or `apps` can never keep all untracked state; tracked files are cleaned and tree-checked regardless.
  const kept = declared.filter((pattern): pattern is string => {
    if (typeof pattern !== "string" || !/^[A-Za-z0-9_.*/-]+$/.test(pattern) || pattern.startsWith("/") || pattern.startsWith("-")) return false;
    const segments = pattern.split("/").filter(Boolean);
    return segments.length >= 2 && segments.every((segment) => segment !== ".." && segment !== "." && /[A-Za-z0-9_-]/.test(segment.replaceAll("*", "")));
  });
  // A refused pattern only narrows what the place keeps, so it never makes a gate unsound, but its warm state is lost:
  // say so rather than drop it silently.
  const refused = declared.filter((pattern) => !kept.includes(pattern as string));
  if (refused.length) console.error(`[runner] machine place ignores placeRetainedPaths ${refused.map((pattern) => JSON.stringify(pattern)).join(", ")} in ${base}'s slipjay.json: each must be at least two path segments deep, and every segment must name something`);
  return kept;
}

/** A shared SSH machine. No provider lifecycle or VM-wide cleanup belongs here. */
export function machineVerification(name: string, config: GateMachineConfig, options: { run?: RemoteRun; scratch?: string; place?: number; check?: boolean } = {}): MachineVerification {
  const run = options.run ?? runBoundedProcess;
  const { local, bundleMissing } = remoteFiles(run);
  const ssh = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3", "-l", config.account, config.ssh];
  // A machine with several places (SJ-200) keeps place 0 at its root, so its warm checkout survives, and place N in
  // `place-N` under it. The bounded filesystem, its quota-ready marker and the install cache stay machine-wide.
  const machineRoot = config.root.replace(/\/$/, "");
  // The release-check place (SJ-202) lives in `check`, apart from the gate places, and its slices are `release-check-*`,
  // which the machine gives idle CPU priority, rather than the gates' `slipjay-attempt-*`.
  const check = options.check === true;
  const place = options.place ?? 0;
  const root = check ? `${machineRoot}/check` : place ? `${machineRoot}/place-${place}` : machineRoot;
  const sliceOf = (id: string) => `${check ? "release-check" : "slipjay-attempt"}-${id}.slice`;
  const holder = `${root}/holder`;
  const repo = `${root}/checkout`;
  let busy = false;
  let quarantine = "runner restart: recovery has not confirmed the place clean";
  let recovering: Promise<void> | undefined;
  const machine: RemoteMachine = { verifier: "machine", name, id: check ? `${name}/check` : place ? `${name}/${place}` : name, size: "machine", image: "fixed SSH machine" };
  const fail = (reason: string) => new Error(`Remote executor unavailable (machine ${name}): ${reason}`);
  async function control(script: string, signal?: AbortSignal, input?: Buffer, timeoutMs = 120_000): Promise<string> {
    const result = await run({ executable: "ssh", args: [...ssh, `bash -lc ${shellWord(`set -euo pipefail\nexport PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"\n${script}`)}`],
      cwd: tmpdir(), env: process.env, maxOutputBytes: 1024 * 1024, timeoutMs, ...signal ? { abortSignal: signal } : {}, ...input ? { input } : {} });
    if (sshFailed(result) || result.timedOut || result.cancelled) {
      quarantine = `SSH session lost or interrupted: ${result.stderr.trim().slice(-500)}`;
      throw Object.assign(fail(quarantine), { connectionLost: true });
    }
    if (result.exitCode !== 0) throw fail(result.stderr.trim().slice(-2000) || `control exited ${result.exitCode}`);
    return result.stdout.trim();
  }
  /** The untracked paths the place last kept (`placeRetainedPaths`); after a restart, none until a gate reads them again. */
  let retain: string[] = [];
  /** Exact holder ids, never container or scope name patterns. Stop descendants before deleting paths. */
  function clean(id: string): string {
    const slice = sliceOf(id);
    return `state=$(systemctl --user show ${shellWord(slice)} --property=LoadState --value 2>/dev/null || true)
if [ "$state" != not-found ]; then
  [ "$state" = loaded ]
  systemctl --user stop ${shellWord(slice)}
  cgroup=$(systemctl --user show ${shellWord(slice)} --property=ControlGroup --value)
  if [ -n "$cgroup" ] && [ -d "/sys/fs/cgroup$cgroup" ]; then
    [ "$(awk '$1 == "populated" {print $2}' "/sys/fs/cgroup$cgroup/cgroup.events")" = 0 ]
  fi
fi
containers=$(docker ps -aq --filter ${shellWord(`label=slipjay.attempt=${id}`)})
if [ -n "$containers" ]; then docker rm -f -v $containers >/dev/null; fi
volumes=$(docker volume ls -q --filter ${shellWord(`label=slipjay.attempt=${id}`)})
if [ -n "$volumes" ]; then docker volume rm $volumes >/dev/null; fi
networks=$(docker network ls -q --filter ${shellWord(`label=slipjay.attempt=${id}`)})
if [ -n "$networks" ]; then docker network rm $networks >/dev/null; fi
[ -z "$(docker ps -aq --filter ${shellWord(`label=slipjay.attempt=${id}`)})" ]
[ -z "$(docker volume ls -q --filter ${shellWord(`label=slipjay.attempt=${id}`)})" ]
[ -z "$(docker network ls -q --filter ${shellWord(`label=slipjay.attempt=${id}`)})" ]
if git -C ${shellWord(repo)} rev-parse --git-dir >/dev/null 2>&1; then
  git -C ${shellWord(repo)} clean -ffdxq ${cleanExclusions(retain)}
fi
rm -rf -- ${shellWord(`${root}/${id}`)}
rm -rf -- ${shellWord(holder)}`;
  }
  async function recover(): Promise<void> {
    if (busy) return;
    recovering ??= (async () => {
      try {
        await control(`mkdir -p ${shellWord(root)}
exec 9>${shellWord(`${root}/control.lock`)}
flock -n 9
if [ -d ${shellWord(holder)} ]; then
  id=$(cat ${shellWord(`${holder}/id`)})
  [[ "$id" =~ ^[0-9a-f]{32}$ ]]
  ${clean("HOLDERID").replaceAll("HOLDERID", '\'"${id}"\'')}
fi`);
        quarantine = "";
      } catch (error) { quarantine = String(error); }
    })().finally(() => { recovering = undefined; });
    await recovering;
  }
  return {
    available: () => !busy && !quarantine,
    reason: () => busy ? "machine place busy" : quarantine,
    recover,
    async open({ checkout, candidate, base, integrationBranch, environment, signal }): Promise<RemoteAttempt> {
      if (busy) throw fail("machine place busy");
      await recover();
      if (busy || quarantine) throw fail(quarantine || "machine place busy");
      busy = true;
      const id = randomUUID().replaceAll("-", "");
      const path = `${root}/${id}`;
      const slice = sliceOf(id);
      // Which of the machine's places this gate holds, so a repository can spread its CPU pinning across places (SJ-200).
      const attemptEnv = { TMPDIR: `${path}/scratch`, BUN_INSTALL_CACHE_DIR: `${machineRoot}/bun-cache`, SLIPJAY_GATE_MACHINE: name,
        // A release check is pinned to no gate place's CPUs; it says it is a check instead (SJ-202).
        ...check ? { SLIPJAY_RELEASE_CHECK: "1" } : { SLIPJAY_GATE_PLACE: String(place), SLIPJAY_GATE_PLACES: String(config.places ?? 1) },
        SLIPJAY_ATTEMPT_ID: id, SLIPJAY_RESOURCE_PREFIX: `sj_${id}`, SLIPJAY_DOCKER_LABEL: `slipjay.attempt=${id}` };
      let scratch: string | undefined;
      let socket: string | undefined;
      let acquired = false;
      const stopping = new AbortController();
      const commands = new Set<Promise<BoundedProcessResult>>();
      const close = async () => {
        stopping.abort();
        // Nothing may start a new scope or a forward after cleanup has proved the place empty.
        await Promise.allSettled([...commands]);
        try {
          // Tunnel shutdown and remote cleanup are both required before reuse.
          if (socket) await local("ssh", ["-S", socket, "-O", "exit", ...ssh], tmpdir());
          if (acquired) await control(`exec 9>${shellWord(`${root}/control.lock`)}\nflock -n 9\n[ "$(cat ${shellWord(`${holder}/id`)})" = ${shellWord(id)} ]\n${clean(id)}`);
          if (acquired) quarantine = "";
        } catch (error) { quarantine = `cleanup unconfirmed: ${String(error)}`; throw fail(quarantine); }
        finally { busy = false; if (scratch) await rm(scratch, { recursive: true, force: true }); }
      };
      try {
        // mkdir is atomic; a crash before the atomic id rename leaves a quarantined marker, with no work started.
        quarantine = "holder acquisition unconfirmed";
        const home = await control(`exec 9>${shellWord(`${root}/control.lock`)}
flock -n 9
mkdir ${shellWord(holder)}
printf '%s\\n' ${shellWord(id)} > ${shellWord(`${holder}/id.new`)}
mv ${shellWord(`${holder}/id.new`)} ${shellWord(`${holder}/id`)}
echo "$HOME"`, signal);
        acquired = true;
        await control(`mkdir -p ${shellWord(`${path}/scratch`)}
# Installer attests an enforced filesystem quota, bounding the dedicated root.
[ -f ${shellWord(`${machineRoot}/quota-ready`)} ] || { echo 'gate root needs filesystem quota and quota-ready marker' >&2; exit 1; }`, signal);
        await mkdir(options.scratch ?? tmpdir(), { recursive: true });
        scratch = await mkdtemp(join(options.scratch ?? tmpdir(), "slipjay-machine-"));
        const scoped = (script: string, unit: string) => remoteCommand({ executable: "bash", args: ["-c", `set -euo pipefail\n${script}`], cwd: path, env: attemptEnv }, unit, { home, account: config.account, slice });
        const resetCheckout = `rm -rf -- ${shellWord(repo)}\ngit init --quiet ${shellWord(repo)}`;
        // Untracked state the place keeps between gates, from the base's policy so a candidate cannot widen it.
        retain = await retainedPaths(run, checkout, base);
        const heads = (await control(scoped(`mkdir -p ${shellWord(`${machineRoot}/bun-cache`)}
if ! git -C ${shellWord(repo)} rev-parse --git-dir >/dev/null 2>&1 || ! git -C ${shellWord(repo)} for-each-ref --format='%(objectname)' >/dev/null 2>&1; then
  ${resetCheckout}
fi
git -C ${shellWord(repo)} clean -ffdxq ${cleanExclusions(retain)}
git -C ${shellWord(repo)} for-each-ref --format='%(objectname)'`, `slipjay-prepare-${id}`), signal))
          .split("\n").filter((head) => /^[0-9a-f]{40}$/.test(head));
        const ref = `refs/slipjay/machine/${id}`;
        const transfer = async (known: string[]) => {
          await local("git", ["update-ref", `${ref}/candidate`, candidate], checkout);
          await local("git", ["update-ref", `${ref}/base`, base], checkout);
          try {
            const bundle = await bundleMissing(checkout, [`${ref}/candidate`, `${ref}/base`], known, join(scratch!, "candidate.bundle"));
            await control(scoped(`cd ${shellWord(repo)}
${receiveCandidate({ bundle: `${path}/candidate.bundle`, ref, candidate, base, integrationBranch, bookmarkPrefix: "slipjay", retain, workingCopy: check ? "child" : "candidate" })}
git update-ref -d ${shellWord(`${ref}/candidate`)}
git update-ref -d ${shellWord(`${ref}/base`)}`, `slipjay-receive-${id}`), signal, bundle, 900_000);
          } finally {
            await local("git", ["update-ref", "-d", `${ref}/candidate`], checkout);
            await local("git", ["update-ref", "-d", `${ref}/base`], checkout);
          }
        };
        try { await transfer(heads); }
        catch (error) {
          signal.throwIfAborted();
          if ((error as { connectionLost?: boolean }).connectionLost) throw error;
          // An unusable object store or checkout is setup infrastructure. Retry once with a fresh place checkout;
          // install and gate failures never take this path, and the shared Bun cache remains warm.
          await control(scoped(resetCheckout, `slipjay-reinitialise-${id}`), signal);
          await transfer([]);
        }
        const tree = await local("git", ["rev-parse", `${candidate}^{tree}`], checkout);
        const observed = await control(scoped(`cd ${shellWord(repo)}
${frozenInstall(`${path}/install.log`, "machine")}
observed=$(${worktreeTree(tree, `${root}/tree-index`)})
echo "tree $observed"
${memoryReading}`, `slipjay-setup-${id}`), signal, undefined, 900_000);
        const line = (label: string) => observed.split("\n").findLast((entry) => entry.startsWith(`${label} `))?.slice(label.length + 1) ?? "";
        if (line("tree") !== tree) throw fail("candidate tree changed during setup");
        const killsBefore = parseMemory(line("memory"))?.limitKills;
        const [runtimePath, version, sha256] = line("runtime").split(" ");
        const forwards = new Map<number, Promise<number>>();
        async function forward(port: number): Promise<number> {
          let pending = forwards.get(port);
          if (!pending) {
            pending = (async () => {
              if (!socket) {
                socket = join(scratch!, "tunnel.sock");
                const log = join(scratch!, "tunnel.log");
                // The master's login command belongs to the attempt slice. Recovery stopping the slice ends the
                // SSH connection and all reverse listeners, even if the runner died with its master still alive.
                const session = `systemd-run --user --scope --quiet --collect --slice=${shellWord(slice)} --unit=${shellWord(`slipjay-tunnel-${id}`)} sleep infinity`;
                const opened = await run({ executable: "bash", args: ["-c", `exec ssh -f -M -o ControlPersist=no -S ${shellWord(socket)} ${ssh.map(shellWord).join(" ")} ${shellWord(session)} </dev/null >/dev/null 2>${shellWord(log)}`], cwd: tmpdir(), env: process.env, timeoutMs: 30_000, maxOutputBytes: 1024 });
                if (opened.exitCode !== 0) throw fail(await readFile(log, "utf8").catch(() => "tunnel failed"));
              }
              // sshd allocates AND binds port zero atomically; no probe/bind race with Development.
              const allocated = await local("ssh", ["-S", socket, "-O", "forward", "-R", `127.0.0.1:0:127.0.0.1:${port}`, ...ssh], tmpdir());
              if (!/^\d+$/.test(allocated) || Number(allocated) < 1 || Number(allocated) > 65535) throw fail("SSH returned no allocated reverse-forward port");
              return Number(allocated);
            })();
            forwards.set(port, pending);
          }
          return pending;
        }
        // A failed service forward is setup infrastructure and can still fall back to boat safely.
        const build = loopbackPort(environment?.SLIPJAY_BUILD_READ_URL);
        if (build) await forward(build);
        quarantine = "";
        return {
          machine, tree, usage: null,
          executor: {
            host: `machine:${name}`,
            reportRoot: repo,
            ...runtimePath && version && sha256 ? { runtime: { name: "bun", path: runtimePath, version, sha256 } } : {},
            async run(request: BoundedProcessRequest) {
              stopping.signal.throwIfAborted();
              const execution = (async () => {
                const unit = `slipjay-command-${id}-${randomUUID()}`;
                const reports = request.env?.[TEST_REPORT_DIR_ENV];
                const remoteReports = `${path}/reports-${randomUUID()}`;
                const subdirectory = relative(checkout, request.cwd);
                if (subdirectory === ".." || subdirectory.startsWith("../")) throw fail("gate cwd is outside the candidate checkout");
                const env: NodeJS.ProcessEnv = { ...request.env, ...attemptEnv,
                  ...reports ? { [TEST_REPORT_DIR_ENV]: remoteReports } : {} };
                const port = loopbackPort(env.SLIPJAY_BUILD_READ_URL);
                if (port) { const url = new URL(env.SLIPJAY_BUILD_READ_URL!); url.port = String(await forward(port)); env.SLIPJAY_BUILD_READ_URL = url.href; }
                stopping.signal.throwIfAborted();
                request.abortSignal?.throwIfAborted();
                const abortSignal = AbortSignal.any([stopping.signal, ...request.abortSignal ? [request.abortSignal] : []]);
                const result = await run({ ...request, abortSignal, executable: "ssh", args: [...ssh, `bash -lc ${shellWord(remoteCommand({ ...request, cwd: join(repo, subdirectory), env }, unit, { home, account: config.account, slice }))}`], cwd: tmpdir(), env: process.env });
                // The local ssh client dying by a signal it did not ask for (killed, or the runner's host under pressure)
                // loses the command as surely as a dropped connection: its exit says nothing about the candidate.
                const clientKilled = result.signal !== null && !result.cancelled && !result.timedOut;
                if (sshFailed(result) || clientKilled) { quarantine = "SSH lost after gate commands started"; throw new Error(`executor lost: ssh to machine ${name}${clientKilled ? ` (ssh ended by ${result.signal})` : ""}`); }
                if (result.cancelled || result.timedOut) await control(`systemctl --user stop ${shellWord(`${unit}.scope`)}`);
                if (reports) await collectRemoteReports(run, ssh, remoteReports, reports, scratch!, unit, (script) => scoped(script, `slipjay-reports-${id}-${randomUUID()}`), true);
                return result;
              })();
              commands.add(execution);
              try { return await execution; }
              finally { commands.delete(execution); }
            },
          },
          async finish() {
            const lines = (await control(scoped(`cd ${shellWord(repo)}\n${worktreeTree(tree, `${root}/tree-index`)}\n${memoryReading}`, `slipjay-finish-${id}`))).split("\n");
            const after = lines[0] ?? "";
            const now = parseMemory(lines.findLast((entry) => entry.startsWith("memory "))?.slice("memory ".length) ?? "");
            // The attempt's slice is its own (named by the attempt) and outlives each scope, so its counter is the whole
            // attempt's CPU time, its preparation and install included.
            const cpuMs = now?.cpuUsec !== undefined ? Math.round(now.cpuUsec / 1000) : undefined;
            const memory = now && killsBefore !== undefined ? { peakBytes: now.peakBytes, oomKills: Math.max(0, now.limitKills - killsBefore), ...cpuMs === undefined ? {} : { cpuMs } } : undefined;
            return { tree: after === tree ? tree : null, trackedChanges: after === tree ? 0 : 1, usage: null, ...memory ? { memory } : {} };
          },
          close,
        };
      } catch (error) {
        const reason = error instanceof Error ? error : new Error(String(error));
        await close().catch(() => undefined);
        throw Object.assign(reason, { remote: { machine, usageBefore: null, usage: null } });
      }
    },
  };
}
