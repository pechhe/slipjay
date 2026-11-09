import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoundedProcessRequest, BoundedProcessResult } from "../infra/bounded-process.ts";
import { SYSTEMD_SLICE_ENV } from "./runner-contract.ts";
import { TEST_REPORT_DIR_ENV } from "./test-reports.ts";
const USER_HOME = "/home/user";
const REMOTE_PATH = `${USER_HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin`;
const SCRATCH_LIST = "~/.slipjay-scratch";
const HOST_ONLY = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", SYSTEMD_SLICE_ENV]);
const CONTROL_TIMEOUT_MS = 120_000;
/**
 * The checkout's files as a tree, read through a throwaway index so neither Git's nor jj's state moves: what the gate
 * actually ran against. The index starts from the candidate's `tree`, so a tracked file that matches an ignore rule
 * stays in it, and `add -A` then records every change, deletion and untracked file that is not ignored.
 *
 * That index keeps the file stat information of every entry whose content matches the worktree, so `add -A` rehashes
 * only the files whose stat changed rather than every file in the tree (12 s against 0.2 s on the YardSmith checkout,
 * 3 Nov 2026), and Git rehashes any file whose stat it cannot trust, so the tree written is the same. `add -A` runs
 * before the merge for that reason: `read-tree -m` refuses to replace an entry the worktree no longer matches
 * ("Entry … not uptodate. Cannot merge"), which would send every file back through a rehash. Without a usable index it
 * starts from `tree` alone, as before.
 *
 * `cache` is where an earlier read left its refreshed index: copying it is what makes a later read of the same
 * checkout cheap. The checkout's own index cannot serve that purpose there: jj writes a colocated repository's index
 * from trees alone, with no file stat information at all (measured: every one of the YardSmith checkout's 13,269
 * entries zeroed), so it never saves a rehash. A read that finds no cache yet hashes every file once, then leaves one.
 */
export const worktreeTree = (tree: string, cache?: string) => `index=$(mktemp); trap 'rm -f "$index"' EXIT
${cache ? `{ cp ${shellWord(cache)} "$index"; } 2>/dev/null || true
` : ""}[ -s "$index" ] || cp "$(git rev-parse --git-path index)" "$index" 2>/dev/null || true
if [ -s "$index" ]; then
  GIT_INDEX_FILE="$index" git add -A . || exit 1
  GIT_INDEX_FILE="$index" git read-tree -m ${shellWord(tree)} 2>/dev/null || { : > "$index"; GIT_INDEX_FILE="$index" git read-tree ${shellWord(tree)}; }
else
  GIT_INDEX_FILE="$index" git read-tree ${shellWord(tree)} || exit 1
fi
GIT_INDEX_FILE="$index" git add -A . && tree=$(GIT_INDEX_FILE="$index" git write-tree) || exit 1${cache ? `
{ cp "$index" ${shellWord(cache)}.new && mv ${shellWord(cache)}.new ${shellWord(cache)}; } 2>/dev/null || true` : ""}
echo "$tree"`;
export const SETUP_TIMEOUT_MS = 900_000;
export const CONTROL_OUTPUT = 1024 * 1024;

/** Quotes `value` as one POSIX shell word. */
export const shellWord = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The remote script for `request`: in the checkout path, under a scope `close` can stop, with the command's own
 * environment and the VM's PATH and HOME. TMPDIR and the test-report directory exist before it starts.
 */
export function remoteCommand(request: Pick<BoundedProcessRequest, "executable" | "args" | "cwd" | "env">, unit: string, machine?: { home: string; account: string; slice: string }): string {
  const env = Object.entries(request.env ?? {}).filter(([key, value]) => value !== undefined && !HOST_ONLY.has(key)) as [string, string][];
  const directories = [request.env?.TMPDIR, request.env?.[TEST_REPORT_DIR_ENV]].filter((value): value is string => Boolean(value));
  return [
    ...directories.length ? [...!machine ? [`printf '%s\\n' ${directories.map(shellWord).join(" ")} >> ${SCRATCH_LIST}`] : [], `mkdir -p ${directories.map(shellWord).join(" ")}`] : [],
    `cd ${shellWord(request.cwd)}`,
    ["exec systemd-run --user --scope --quiet --collect", `--unit=${shellWord(unit)}`, ...machine ? [`--slice=${shellWord(machine.slice)}`] : [], "env -i",
      ...[["HOME", machine?.home ?? USER_HOME], ["USER", machine?.account ?? "user"], ["PATH", machine ? `${machine.home}/.bun/bin:/usr/local/bin:/usr/bin:/bin` : REMOTE_PATH], ...env, ...machine ? [[SYSTEMD_SLICE_ENV, machine.slice]] : []].map(([key, value]) => shellWord(`${key}=${value}`)),
      shellWord(request.executable), ...request.args.map(shellWord)].join(" "),
  ].join(" && ");
}

/** A loopback port in `url`, which a remote command reaches through a reverse tunnel to the runner host. */
export const loopbackPort = (url: string | undefined): number | undefined => {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) return undefined;
    return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  } catch { return undefined; }
};

/** ssh's own failure, rather than a candidate command that happens to exit 255. */
export const sshFailed = (result: BoundedProcessResult) => result.exitCode === 255 && /^(?:ssh|kex_exchange|Connection (?:closed|reset|timed out|refused)|client_loop)\b|\bssh: /m.test(result.stderr);
export type RemoteRun = (request: BoundedProcessRequest) => Promise<BoundedProcessResult>;
export function remoteFiles(run: RemoteRun) {
  async function local(executable: string, args: string[], cwd: string): Promise<string> {
    const result = await run({ executable, args, cwd, timeoutMs: CONTROL_TIMEOUT_MS, maxOutputBytes: CONTROL_OUTPUT, env: process.env });
    if (result.exitCode !== 0) throw new Error(`Remote executor unavailable (setup): ${executable} ${args[0]} failed: ${result.stderr.trim().slice(-1000)}`);
    return result.stdout.trim();
  }

  /**
   * A Git bundle of `refs` from the repository at `cwd`, without what the VM already holds: the commits among `heads` (the
   * VM's own refs) that this repository knows too. Empty when the VM lacks nothing, which git refuses to write as a bundle.
   */
  async function bundleMissing(cwd: string, refs: string[], heads: string[], bundle: string): Promise<Buffer> {
    const known: string[] = [];
    for (const head of new Set(heads)) {
      const present = await run({ executable: "git", args: ["cat-file", "-e", `${head}^{commit}`], cwd, timeoutMs: 10_000, maxOutputBytes: 1024, env: process.env });
      if (present.exitCode === 0) known.push(head);
    }
    const bundled = await run({ executable: "git", args: ["bundle", "create", bundle, ...refs, ...known.map((head) => `^${head}`)],
      cwd, timeoutMs: SETUP_TIMEOUT_MS, maxOutputBytes: CONTROL_OUTPUT, env: process.env });
    if (bundled.exitCode !== 0 && /empty bundle/i.test(bundled.stderr)) return Buffer.alloc(0);
    if (bundled.exitCode !== 0) throw new Error(`Remote executor unavailable (setup): git bundle failed: ${bundled.stderr.trim().slice(-1000)}`);
    return readFile(bundle);
  }

  return { local, bundleMissing };
}

/**
 * Puts `commitId` into a build machine's bare repository `gitDir` (made if missing), sending a bundle of what it lacks.
 * `control` runs a script on the machine. Two leases may do this at once, so the bundle's path on the machine is its own
 * and they take turns to update the ref, which would otherwise fail on git's lock.
 */
export async function receiveBuildCommit(
  control: (what: string, script: string, options?: { input?: Buffer; timeoutMs?: number }) => Promise<string>,
  files: ReturnType<typeof remoteFiles>,
  { gitDirectory, gitDir, pool, commitId, bundle }: { gitDirectory: string; gitDir: string; pool: string; commitId: string; bundle: string },
): Promise<void> {
  const dir = shellWord(gitDir);
  const ref = `refs/slipjay/machine/${pool}`;
  const heads = (await control("list commits", `git init --quiet --bare ${dir} && git --git-dir=${dir} for-each-ref --format='%(objectname)'`))
    .split("\n").filter((line) => /^[0-9a-f]{40}$/.test(line));
  await files.local("git", ["update-ref", ref, commitId], gitDirectory);
  const input = await files.bundleMissing(gitDirectory, [ref], heads, bundle);
  await control("receive the commit", `bundle=$(mktemp)
cat > "$bundle"
(
  flock 9
  if [ -s "$bundle" ]; then git --git-dir=${dir} fetch --quiet "$bundle" ${shellWord(`+${ref}:${ref}`)}; fi
  git --git-dir=${dir} update-ref ${shellWord(ref)} ${shellWord(commitId)}
) 9>>${shellWord(`${gitDir}.lock`)}
rm -f "$bundle"
git --git-dir=${dir} cat-file -e ${shellWord(`${commitId}^{commit}`)}`, { input, timeoutMs: SETUP_TIMEOUT_MS });
}

/**
 * `git clean`'s exclusions: always `node_modules` and `.jj`, plus `retain`, the untracked paths a fixed place keeps
 * between gates (`placeRetainedPaths`, read from the integration branch's policy, never the candidate's).
 */
export const cleanExclusions = (retain: readonly string[] = []) =>
  ["node_modules", ".jj", ...retain].map((pattern) => `-e ${shellWord(pattern)}`).join(" ");

/** Receive the bundle on stdin and expose precisely the candidate and base to colocated jj. Cwd is the checkout. */
export function receiveCandidate(input: { bundle: string; ref: string; candidate: string; base: string; integrationBranch: string; bookmarkPrefix: string; retain?: readonly string[]; workingCopy?: "candidate" | "child" }): string {
  const { bundle, ref, candidate, base, integrationBranch, bookmarkPrefix, retain } = input;
  // A gate's selection reads the candidate as the working copy (`jj edit`), so git's HEAD is its parent. A release
  // check or audit verifies an exact commit and refuses a checkout git reports as changed, so it works in an empty
  // child (`jj new`): HEAD is the commit, the index its tree, and `git status` is clean.
  const checkout = input.workingCopy === "child" ? `jj new ${shellWord(candidate)} --quiet` : `jj edit ${shellWord(candidate)} --quiet`;
  return `cat > ${shellWord(bundle)}
if [ -s ${shellWord(bundle)} ]; then git fetch ${shellWord(bundle)} ${shellWord(`+${ref}/*:${ref}/*`)}; fi
rm -f ${shellWord(bundle)}
git update-ref ${shellWord(`refs/heads/${bookmarkPrefix}-candidate`)} ${shellWord(candidate)}
git update-ref ${shellWord(`refs/heads/${bookmarkPrefix}-base`)} ${shellWord(base)}
[ -d .jj ] || jj git init --colocate >/dev/null 2>&1
jj git import --quiet >/dev/null 2>&1 || true
jj bookmark set ${shellWord(integrationBranch)} -r ${shellWord(base)} --allow-backwards --quiet
${checkout}
git clean -ffdxq ${cleanExclusions(retain)}`;
}

/** Candidate-controlled files never choose a runtime download or a mutable dependency resolution. */
export const frozenInstall = (log: string, subject: "image" | "machine" = "image") => `want=$(sed -nE 's/.*"packageManager": *"bun@([0-9.]+)".*/\\1/p' package.json | head -1)
if [ -n "$want" ] && [ "$(bun --version 2>/dev/null)" != "$want" ]; then echo "the ${subject} has bun $(bun --version 2>/dev/null || echo none), the candidate needs bun $want: refresh the ${subject}" >&2; exit 1; fi
if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile >${shellWord(log)} 2>&1 || { tail -40 ${shellWord(log)} >&2; exit 1; }; fi
bun=$(readlink -f "$(command -v bun)")
echo "runtime $bun $(bun --version) $(sha256sum "$bun" | cut -d' ' -f1)"`;

/** Copy the gate's report archive back to the evidence directory on the runner. */
export async function collectRemoteReports(run: RemoteRun, ssh: string[], remote: string, reports: string, scratch: string, unit: string, transport: (script: string) => string = (script) => script, strict = false) {
  const archive = await run({ executable: "ssh", args: [...ssh, transport(`tar -C ${shellWord(remote)} -cf - . 2>/dev/null | base64 -w0`)], cwd: tmpdir(),
    timeoutMs: CONTROL_TIMEOUT_MS, maxOutputBytes: 64 * 1024 * 1024, env: process.env });
  if (strict && (sshFailed(archive) || archive.timedOut)) throw new Error("executor lost: ssh during report collection");
  if (archive.exitCode === 0 && archive.stdout.trim()) {
    await mkdir(reports, { recursive: true });
    const tarball = join(scratch, `${unit}.tar`);
    await writeFile(tarball, Buffer.from(archive.stdout.trim(), "base64"));
    await remoteFiles(run).local("tar", ["-xf", tarball, "-C", reports], scratch);
  }
}
