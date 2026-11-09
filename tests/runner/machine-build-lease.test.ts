import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { runBoundedProcess, type BoundedProcessRequest, type BoundedProcessResult } from "../../src/lib/infra/bounded-process.ts";
import { machineBuildLease } from "../../src/lib/runner/machine-verifier.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

/** A repository with one commit, and a machine whose ssh runs each remote script here under its own home. */
function stand() {
  const root = mkdtempSync(join(tmpdir(), "machine-build-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  git(root, "init", "--quiet", "repo");
  execFileSync("mkdir", ["-p", home]);
  const commit = (name: string) => {
    writeFileSync(join(repo, name), name);
    git(repo, "add", name);
    git(repo, "commit", "--quiet", "-m", name);
    return git(repo, "rev-parse", "HEAD");
  };
  const received: number[] = [];
  const state = { reachable: true };
  const run = async (request: BoundedProcessRequest): Promise<BoundedProcessResult> => {
    if (request.executable !== "ssh") return runBoundedProcess(request);
    if (!state.reachable) return { stdout: "", stderr: "ssh: connect to host peach-box port 22: Connection timed out", stdoutTruncated: false, stderrTruncated: false, exitCode: 255, signal: null, timedOut: false, finishedAt: new Date() } as unknown as BoundedProcessResult;
    if (request.input) received.push(request.input.length);
    const command = request.args.at(-1)!;
    const script = command.slice("bash -lc ".length + 1, -1).replaceAll("'\\''", "'");
    return runBoundedProcess({ ...request, executable: "bash", args: ["-c", script], env: { ...process.env, HOME: home } });
  };
  const lease = machineBuildLease("peach-box", { ssh: "peach-box", account: "ubuntu" }, { run, scratch: root });
  const request = (commitId: string) => ({ repo: "pechhe/yardsmith", pool: "images", gitDirectory: join(repo, ".git"), commitId, lifetimeS: 60 });
  return { home, commit, lease, request, received, state };
}

test("a fixed machine's lease holds the commit in its own repository and names its ssh, with nothing billed", async () => {
  const { home, commit, lease, request } = stand();
  const commitId = commit("one");
  const held = await lease(request(commitId));
  const gitDir = join(home, ".slipjay-builds", "slipjay-pechhe-yardsmith-images.git");
  assert.equal(held.env.SLIPJAY_MACHINE_GIT_DIR, gitDir);
  assert.equal(git(home, "--git-dir", gitDir, "cat-file", "-t", commitId), "commit");
  assert.equal(held.machine.name, "peach-box");
  assert.equal(held.machine.verifier, "machine");
  const ssh = held.env.SLIPJAY_MACHINE_SSH!;
  assert.match(readFileSync(ssh, "utf8"), /exec ssh .*'peach-box' "\$@"/);
  assert.equal(await held.close(), null);
  assert.ok(!existsSync(ssh), "closing removes its scratch");
});

test("a later lease sends only what the machine lacks", async () => {
  const { commit, lease, request, received } = stand();
  await (await lease(request(commit("one")))).close();
  const full = received.at(-1)!;
  await (await lease(request(commit("two")))).close();
  const second = received.at(-1)!;
  assert.ok(second > 0 && second < full + 200, `the second bundle (${second} bytes) carries one commit, not the history (${full} bytes)`);
  const same = git(join(request("x").gitDirectory, ".."), "rev-parse", "HEAD");
  await (await lease(request(same))).close();
  assert.equal(received.at(-1), 0, "a machine that holds the commit is sent nothing");
});

test("leases of one machine at once all hold their commit", async () => {
  const { commit, lease, request } = stand();
  const commitId = commit("one");
  const [first, second, ...others] = await Promise.all(Array.from({ length: 8 }, () => lease(request(commitId))));
  for (const other of others) await other!.close();
  if (!first || !second) throw new Error("expected the leases");
  assert.equal(first.env.SLIPJAY_MACHINE_GIT_DIR, second.env.SLIPJAY_MACHINE_GIT_DIR);
  assert.notEqual(first.env.SLIPJAY_MACHINE_SSH, second.env.SLIPJAY_MACHINE_SSH);
  await first.close();
  assert.ok(existsSync(second.env.SLIPJAY_MACHINE_SSH!), "closing one leaves the other's ssh");
  await second.close();
});

test("a machine that cannot be reached fails the lease, saying why", async () => {
  const { commit, lease, request, state } = stand();
  const commitId = commit("one");
  state.reachable = false;
  await assert.rejects(lease(request(commitId)), /on peach-box failed: ssh: connect to host peach-box/);
});
