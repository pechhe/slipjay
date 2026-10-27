import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { runWorkspaceCommand } from "../../src/lib/infra/workspace-command.ts";
import { prepareWorkspaceDependencies } from "../../src/lib/workspace/workspace-dependencies.ts";

async function packageTarball(root: string, version: string) {
  const packageRoot = join(root, version, "package");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "sj89-fixture", version }));
  await writeFile(join(packageRoot, "value.txt"), "original\n");
  const result = await runWorkspaceCommand("tar", ["-czf", join(root, `${version}.tgz`), "-C", join(root, version), "package"]);
  assert.equal(result.code, 0, result.stderr);
}
async function install(cwd: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  const result = await runWorkspaceCommand("bun", ["install", ...args], { cwd, env });
  assert.equal(result.code, 0, result.stderr);
}
async function manifest(root: string, dependency: string, patchedDependencies?: Record<string, string>) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", packageManager: "bun@1.4.3", dependencies: { "sj89-fixture": dependency }, ...(patchedDependencies ? { patchedDependencies } : {}) }));
}

// The stale-manifest recovery is covered with a stubbed Bun in workspace-install-recovery.test.ts: against a
// local registry Bun writes each tarball URL into bun.lock, so a frozen install never reads the cached manifest.
test("a frozen Bun install applies a candidate's changed patch over reused node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "sj89-patches-"));
  try {
    await packageTarball(root, "1.0.0");
    const env = { ...process.env, BUN_INSTALL_CACHE_DIR: join(root, "cache") };
    const reused = join(root, "reused"), candidate = join(root, "candidate");
    for (const [cwd, value] of [[reused, "first"], [candidate, "second"]]) {
      const patch = `patches/${value}.patch`;
      await manifest(cwd!, "file:../1.0.0.tgz", { "sj89-fixture@../1.0.0.tgz": patch });
      await mkdir(join(cwd!, "patches"));
      await writeFile(join(cwd!, patch), `diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-original\n+${value}\n`);
      await install(cwd!, env);
    }
    assert.equal(await readFile(join(reused, "node_modules/sj89-fixture/value.txt"), "utf8"), "first\n");
    assert.notEqual(await readFile(join(reused, "bun.lock"), "utf8"), await readFile(join(candidate, "bun.lock"), "utf8"));
    for (const path of ["package.json", "bun.lock", "patches"]) await cp(join(candidate, path), join(reused, path), { recursive: true });
    const before = await readFile(join(reused, "bun.lock"), "utf8");
    const ready = await prepareWorkspaceDependencies(reused, { quiet: true, env });
    assert.equal(ready.state, "ready");
    assert.equal(await readFile(join(reused, "node_modules/sj89-fixture/value.txt"), "utf8"), "second\n");
    assert.equal(await readFile(join(reused, "bun.lock"), "utf8"), before);
    // A new candidate that names a missing patch must not inherit the old patched bytes as success.
    const manifestPath = join(reused, "package.json");
    await writeFile(manifestPath, (await readFile(manifestPath, "utf8")).replace("patches/second.patch", "patches/missing.patch"));
    await writeFile(join(reused, "bun.lock"), before.replace("patches/second.patch", "patches/missing.patch"));
    await assert.rejects(prepareWorkspaceDependencies(reused, { quiet: true, env }), /missing\.patch/);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
