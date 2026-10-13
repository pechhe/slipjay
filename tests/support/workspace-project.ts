import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { landThroughRunner } from "../../src/lib/runner-client.ts";
import { startRunner } from "../../src/lib/runner-service.ts";

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
  return { root, repo, remote, verified, remoteFile, dispose: () => rm(root, { recursive: true, force: true }) };
}

/**
 * Run `body` against a runner started in-process with its own home under the
 * fixture's root, stopped afterwards. `env` names it (SLIPJAY_RUNNER) and carries
 * its token, so `body` can land through the library or the CLI.
 */
export async function withTestRunner<T>(f: { root: string; repo: string; remote: string }, body: (runner: { location: string; env: NodeJS.ProcessEnv }) => Promise<T>): Promise<T> {
  // The client names the repository by its GitHub remote. Origin carries a GitHub-shaped
  // alias only while the runner is up, so nothing else a test runs reaches for GitHub.
  const github = join(f.root, "github.com", "fixture", "project.git");
  await mkdir(dirname(github), { recursive: true });
  await symlink(f.remote, github).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  // Through Git's config: jj would store the symlink's resolved path.
  const setOrigin = (url: string) => execFileSync("git", ["-C", f.repo, "remote", "set-url", "origin", url]);
  setOrigin(github);
  // A runner commits as the identity its config names for the commits it rewrites.
  const home = join(f.root, "runner");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.json"), JSON.stringify({ name: "test-runner", repos: { "fixture/project": { url: f.remote } },
    jj: { "user.name": "Fixture", "user.email": "fixture@example.com" } }));
  const runner = await startRunner({ home, env: { ...process.env, SLIPJAY_RUNNER_TOKEN: "test-token" }, port: 0 });
  try {
    return await body({ location: runner.url, env: { ...process.env, SLIPJAY_RUNNER: runner.url, SLIPJAY_RUNNER_TOKEN: "test-token" } });
  } finally {
    await runner.close();
    setOrigin(f.remote);
  }
}

/**
 * Land `cwd` the one way SlipJay lands: through a test runner (withTestRunner).
 * `keep` holds the workspace with another process while it lands, so the landing
 * keeps it as it would any workspace in use; `direct` lands the primary checkout.
 */
export function landThroughTestRunner(f: { root: string; repo: string; remote: string }, cwd: string, options: { direct?: boolean; keep?: boolean } = {}) {
  return withTestRunner(f, async ({ location, env }) => {
    // Its own process group: the landing ignores its caller's group as it would the CLI's.
    const holder = options.keep ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd, stdio: "ignore", detached: true }) : null;
    const lines: string[] = [];
    try {
      const result = await landThroughRunner(cwd, { location, env, direct: options.direct, onLine: (line) => { lines.push(line); } });
      return { ...result, lines };
    } finally {
      holder?.kill();
    }
  });
}
