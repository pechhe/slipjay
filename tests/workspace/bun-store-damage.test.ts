import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { bunStoreDamage, prepareWorkspaceDependencies } from "../../src/lib/workspace/workspace-dependencies.ts";
import { jj, project } from "../support/workspace-project.ts";

const BUN_VERSION = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();

/** A Bun project linked into an empty global store, as after `bun pm cache rm`. */
async function emptiedStore() {
  const f = await project({ ignore: "node_modules\n" });
  const cache = join(f.root, "bun-cache");
  await mkdir(join(cache, "links"), { recursive: true });
  await writeFile(join(f.repo, "package.json"), JSON.stringify({ name: "fixture", private: true, packageManager: `bun@${BUN_VERSION}`, workspaces: ["packages/*"] }));
  await mkdir(join(f.repo, "packages/app/node_modules"), { recursive: true });
  await writeFile(join(f.repo, "packages/app/package.json"), JSON.stringify({ name: "app", dependencies: { "declared-dep": "1.0.0" } }));
  jj(f.repo, ["commit", "-m", "Add packages"]);
  // A declared package and a stale one whose manifest entry is gone, both pointing into the emptied store.
  await symlink(join(cache, "links/declared-dep@1.0.0/node_modules/declared-dep"), join(f.repo, "packages/app/node_modules/declared-dep"));
  await symlink(join(cache, "links/removed-dep@1.0.0/node_modules/removed-dep"), join(f.repo, "packages/app/node_modules/removed-dep"));
  return { ...f, cache, env: { ...process.env, BUN_INSTALL_CACHE_DIR: cache } };
}

test("a declared package whose store link dangles is damage; a stale undeclared link is not", async () => {
  const f = await emptiedStore();
  try {
    const damage = await bunStoreDamage(f.repo, f.env);
    assert.ok(damage, "damage reported");
    assert.match(damage, /packages\/app\/node_modules\/declared-dep/);
    assert.doesNotMatch(damage, /removed-dep/);
    assert.match(damage, /bun install --frozen-lockfile/);
  } finally { await f.dispose(); }
});

test("a dangling transitive link is damage, and half-linked entries are named only alongside damage", async () => {
  const f = await emptiedStore();
  try {
    // The declared package is intact in the store; the dependency it links to is not.
    const entry = join(f.cache, "links/declared-dep@1.0.0/node_modules");
    await mkdir(join(entry, "declared-dep"), { recursive: true });
    await symlink("../../transitive-dep@2.0.0/node_modules/transitive-dep", join(entry, "transitive-dep"));
    await mkdir(join(f.cache, "links/@effect+tsgo@0.1.0.tmp-123abc"));
    const damage = await bunStoreDamage(f.repo, f.env) ?? "";
    assert.match(damage, /declared-dep@1\.0\.0\/node_modules\/transitive-dep/);
    assert.match(damage, /@effect\+tsgo@0\.1\.0\.tmp-123abc[\s\S]*bun add <package>@<version>/);
    await mkdir(join(f.cache, "links/transitive-dep@2.0.0/node_modules/transitive-dep"), { recursive: true });
    assert.equal(await bunStoreDamage(f.repo, f.env), null, "another project's half-linked entry is not this checkout's damage");
  } finally { await f.dispose(); }
});

test("preparing dependencies refuses a damaged store with the repair hint instead of a raw module error", async () => {
  const f = await emptiedStore();
  try {
    await assert.rejects(prepareWorkspaceDependencies(f.repo, { quiet: true, env: f.env }), /global package store is damaged[\s\S]*declared-dep/);
  } finally { await f.dispose(); }
});
