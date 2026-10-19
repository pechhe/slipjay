import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { ensureRepoConfig } from "../../src/lib/infra/workspace-jj.ts";

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
