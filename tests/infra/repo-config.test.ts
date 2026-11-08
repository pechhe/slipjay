import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { ensureRepoConfig } from "../../src/lib/infra/workspace-jj.ts";
import { RUNNER_JJ_DEFAULTS } from "../../src/lib/runner/runner-contract.ts";

test("repo config is written only where the checkout does not already hold it, and restored after it changes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "peach-repo-config-")));
  const jj = (args: string[]) => execFileSync("jj", ["--color=never", ...args], { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    jj(["git", "init"]);
    const settings = { "snapshot.max-new-file-size": "64MiB", 'revset-aliases."trunk()"': "develop@origin" };
    await ensureRepoConfig(root, settings);
    assert.equal(jj(["config", "get", "snapshot.max-new-file-size"]), "64MiB");
    assert.equal(jj(["config", "get", 'revset-aliases."trunk()"']), "develop@origin");

    // Nothing to write: the config file is left alone.
    const path = jj(["config", "path", "--repo"]);
    const written = (await stat(path)).mtimeMs;
    await new Promise((settle) => setTimeout(settle, 20));
    await ensureRepoConfig(root, settings);
    assert.equal((await stat(path)).mtimeMs, written);

    // A setting changed since is written again; a new one is added.
    jj(["config", "set", "--repo", 'revset-aliases."trunk()"', "main@origin"]);
    await ensureRepoConfig(root, { ...settings, "user.name": "Fixture" });
    assert.equal(jj(["config", "get", 'revset-aliases."trunk()"']), "develop@origin");
    assert.equal(jj(["config", "get", "user.name"]), "Fixture");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the runner's jj defaults update a stale working copy instead of refusing it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "peach-repo-stale-")));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "peach-repo-stale-workspace-")));
  const jj = (args: string[], cwd = root) => execFileSync("jj", ["--color=never", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    jj(["git", "init", "--colocate"]);
    await writeFile(join(root, "a.txt"), "a\n");
    jj(["describe", "-m", "base"]);
    // As on a machine that reported it, a stale working copy is left for an explicit update.
    jj(["config", "set", "--repo", "snapshot.auto-update-stale", "false"]);
    jj(["workspace", "add", "--name", "spare", workspace]);
    // An operation on the shared repository moves it on without the spare's working copy, as a
    // relanding or a concurrent jj call does, leaving that workspace's last operation discarded.
    const added = jj(["op", "log", "--no-graph", "-T", 'self.id() ++ "\\t" ++ description ++ "\\n"'])
      .split("\n").find((line) => line.includes("add workspace 'spare'"))!.split("\t")[0]!;
    await writeFile(join(workspace, "b.txt"), "b\n");
    jj(["status"], workspace);
    jj(["--ignore-working-copy", "op", "restore", added]);
    assert.throws(() => jj(["status"], workspace), /working copy is stale/, "the spare is stale");

    // The runner never has a person to run `jj workspace update-stale`: its own settings update the
    // checkout instead, so no read or landing of a shared repository fails on a stale working copy.
    await ensureRepoConfig(root, RUNNER_JJ_DEFAULTS);
    assert.match(jj(["status"], workspace), /Working copy/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
