import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { drainFixtureWorkers } from "./fixture-workers.ts";
import { setFixtureJjSetting } from "./jj-user-config.ts";

// Workspace fixtures create checkouts and state under `homedir()`. Under the real
// HOME they leak into ~/.pi and race live sessions, so a runner that skipped the
// hermetic setup (scripts/vitest-hermetic-env.ts) fails here before any test runs.
if (homedir() === userInfo().homedir) {
  throw new Error("Workspace fixtures need a disposable HOME; run them through `vp test` or scripts/with-hermetic-home.ts");
}

export const jj = (cwd: string, args: string[]) => execFileSync("jj", ["--color=never", ...args], { cwd, encoding: "utf8" }).trim();

// A disposable project with a bare `origin`, landing policy and a verification
// check (Node source; a landing gate never runs a shell) that records which checkout it verified.
/** Node source appending the verified checkout's path to `verified`. */
export const recordCheckout = (verified: string) => `require("node:fs").appendFileSync(${JSON.stringify(verified)}, process.cwd() + "\\n")`;

/**
 * `shallow` makes the colocated primary `.git` a depth-1 clone of `origin` (as
 * YardSmith's is); `postIntegration` declares that external-state step; `policyPath`
 * is where the policy is committed (`slipjay.json` by default; the retired path builds a refused fixture);
 * `policy` adds further declarations.
 */
export async function project(options: { ignore?: string; generatedPaths?: unknown; verify?: (verified: string) => string;
  shallow?: boolean; postIntegration?: Record<string, unknown>; policyPath?: "slipjay.json" | "slipway.json";
  policy?: Record<string, unknown> } = {}) {
  process.env.JJ_USER ??= "Fixture";
  process.env.JJ_EMAIL ??= "fixture@example.com";
  const root = await realpath(await mkdtemp(join(tmpdir(), "peach-rollover-")));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const verified = join(root, "verified.log");
  await mkdir(join(repo, dirname(options.policyPath ?? "slipjay.json")), { recursive: true });
  const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git(["init", "-q", "--bare", "-b", "main", remote], root);
  // Tests write commits straight into the remote; a host without a global git identity must not fail them.
  git(["--git-dir", remote, "config", "user.name", "Fixture"], root);
  git(["--git-dir", remote, "config", "user.email", "fixture@example.com"], root);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.com"]);
  // A shallow primary needs history below its boundary.
  if (options.shallow) git(["commit", "-q", "--allow-empty", "-m", "Before the shallow boundary"]);
  await writeFile(join(repo, "README.md"), "fixture\n");
  if (options.ignore) await writeFile(join(repo, ".gitignore"), options.ignore);
  await writeFile(join(repo, options.policyPath ?? "slipjay.json"), JSON.stringify({
    version: 1, integrationBranch: "main",
    sourcePublication: { version: 1, mode: "required", remote: "origin" },
    requiredLandingVerification: [{ executable: "node", args: ["-e", options.verify?.(verified) ?? recordCheckout(verified)] }],
    ...(options.generatedPaths === undefined ? {} : { generatedPaths: options.generatedPaths }),
    ...(options.postIntegration === undefined ? {} : { postIntegration: options.postIntegration }),
    ...options.policy,
  }));
  git(["add", "."]);
  git(["commit", "-qm", "Initial"]);
  git(["remote", "add", "origin", remote]);
  git(["push", "-q", "origin", "main"]);
  if (options.shallow) {
    await rm(repo, { recursive: true, force: true });
    git(["clone", "-q", "--depth", "1", `file://${remote}`, repo], root);
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.com"]);
  }
  jj(repo, ["git", "init", "--colocate"]);
  // Workspace commands do not see JJ_USER/JJ_EMAIL, so the author lives in repository config.
  jj(repo, ["config", "set", "--repo", "user.name", "Fixture"]);
  jj(repo, ["config", "set", "--repo", "user.email", "fixture@example.com"]);
  jj(repo, ["bookmark", "track", "main", "--remote", "origin"]);
  const remoteFile = (path: string) => execFileSync("git", ["--git-dir", remote, "show", `main:${path}`], { encoding: "utf8" });
  return { root, repo, remote, verified, remoteFile, dispose: async () => { await drainFixtureWorkers(root); await stopFixtureProcesses(root); await rm(root, { recursive: true, force: true }); } };
}

/**
 * Stop what a test left running against the fixture, such as the detached spare refill a cold
 * `slipjay start` launches, so removing the checkout does not race its writes. Waits for the
 * processes to exit, and kills what ignores the polite request.
 */
async function stopFixtureProcesses(root: string): Promise<void> {
  const running = (): number[] => {
    try {
      return execFileSync("pgrep", ["-f", root], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number).filter((pid) => pid !== process.pid);
    } catch { return []; }
  };
  const stop = (pid: number, signal: NodeJS.Signals) => { try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* already gone */ } } };
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    for (const pid of running()) stop(pid, signal);
    const deadline = Date.now() + 5_000;
    while (running().length && Date.now() < deadline) await new Promise((settle) => setTimeout(settle, 50));
    if (!running().length) return;
  }
}

/** Expose a genuine GitHub origin while JJ's Git subprocesses use the local bare fixture. Restore before disposing it. */
export async function configureLocalGithubTransport(f: { root: string; repo: string; remote: string }): Promise<{ github: string; restore(): void }> {
  // JJ's internal remote-list must see the real configured GitHub identity. Only
  // Git transport subprocesses get the local rewrite; global Git rewrites would
  // make JJ expose the resolved local URL instead. No network is used.
  const github = "https://github.com/fixture/project.git";
  const gitWrapper = join(f.root, "fixture-git");
  const previousGit = jj(f.repo, ["config", "get", "git.executable-path"]);
  const previousOrigin = execFileSync("git", ["-C", f.repo, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim();
  // A shell script, not node: JJ runs it for every fetch and push. It logs each call's arguments, space-separated.
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(gitWrapper, `#!/bin/sh
printf '%s\\n' "$*" >> ${quote(join(f.root, "git-transport.log"))}
exec git -c ${quote(`url.${f.remote}.insteadOf=${github}`)} "$@"
`);
  await chmod(gitWrapper, 0o755);
  // Source and runner clones share this test file's guarded disposable HOME.
  setFixtureJjSetting("git.executable-path", gitWrapper);
  const setOrigin = (url: string) => execFileSync("git", ["-C", f.repo, "remote", "set-url", "origin", url]);
  const restore = () => {
    try { setOrigin(previousOrigin); }
    finally { setFixtureJjSetting("git.executable-path", previousGit); }
  };
  try { setOrigin(github); }
  catch (error) { restore(); throw error; }
  return { github, restore };
}
