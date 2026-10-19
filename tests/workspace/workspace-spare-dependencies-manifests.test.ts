import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { installInputFingerprint } from "../../src/lib/workspace/install-inputs.ts";
import { BUN_VERSION, write, bunProject, counts } from "./fixtures/workspace-spare-dependencies-fixture.ts";

test("the install-input fingerprint follows file: dependencies, patch paths, lifecycle flags and the install environment", async () => {
  const f = await bunProject();
  try {
    await write(f.repo, {
      "packages/v/package.json": JSON.stringify({
        name: "v", version: "1.0.0", dependencies: { foo: "file:../../vendor/foo" }, patchedDependencies: { "x@1.0.0": "tools/x.patch" },
        scripts: { prepare: "node --import=./register.mjs run.mjs" },
      }),
      "packages/v/tools/x.patch": "patch\n",
      "packages/v/register.mjs": "export {};\n",
      "packages/v/run.mjs": "export {};\n",
      "vendor/foo/package.json": JSON.stringify({ name: "foo", version: "1.0.0" }),
      "vendor/foo/index.js": "module.exports = 1;\n",
    });
    let previous = await installInputFingerprint(f.repo);
    assert.ok(previous);
    for (const path of ["vendor/foo/index.js", "packages/v/tools/x.patch", "packages/v/register.mjs"]) {
      await write(f.repo, { [path]: `${await readFile(join(f.repo, path), "utf8")}// changed\n` });
      const next = await installInputFingerprint(f.repo);
      assert.ok(next && next !== previous, `${path} is an install input`);
      previous = next;
    }
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.notEqual(await installInputFingerprint(f.repo), previous, "NODE_ENV changes what an install produces");
    } finally {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
    }
    await write(f.repo, { "packages/w/package.json": JSON.stringify({ name: "w", scripts: { prepare: "bun run --filter '*' build" } }) });
    assert.equal(await installInputFingerprint(f.repo), null, "a lifecycle script running other packages is not followed");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("lifecycle scripts of manifests outside the install's workspaces are no input, and are still hashed", async () => {
  const f = await bunProject();
  try {
    await write(f.repo, { ".repos/vendored/package.json": JSON.stringify({ name: "vendored", scripts: { prepare: "turbo run build --filter=a" } }) });
    const withVendored = await installInputFingerprint(f.repo);
    assert.ok(withVendored, "a vendored manifest outside `workspaces` does not refuse the fingerprint");
    await write(f.repo, { ".repos/vendored/package.json": JSON.stringify({ name: "vendored", version: "2.0.0" }) });
    assert.notEqual(await installInputFingerprint(f.repo), withVendored, "its manifest still counts as an install input");

    await write(f.repo, { "packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0", scripts: { prepare: "turbo run build --filter=a" } }) });
    assert.equal(await installInputFingerprint(f.repo), null, "a declared workspace member is still judged");
    await write(f.repo, { "package.json": JSON.stringify({ name: "fixture", private: true, packageManager: `bun@${BUN_VERSION}`, workspaces: ["packages/*", "!packages/x"] }) });
    assert.ok(await installInputFingerprint(f.repo), "a negated pattern leaves the member out");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a workspace list that is not read exactly is never trusted to leave a manifest out", async () => {
  const f = await project({ ignore: "node_modules\n" });
  try {
    const judged = JSON.stringify({ name: "t", scripts: { prepare: "turbo run build --filter=a" } });
    const manifest = (workspaces: unknown) => JSON.stringify({ name: "fixture", private: true, packageManager: `bun@${BUN_VERSION}`, ...(workspaces ? { workspaces } : {}) });
    const outcome = async (files: Record<string, string>) => { await write(f.repo, files); return await installInputFingerprint(f.repo); };

    assert.equal(await outcome({ "package.json": manifest(["packages/**/foo"]), "packages/foo/package.json": judged }), null, "`**` also matches no directory levels");
    await rm(join(f.repo, "packages"), { recursive: true });
    assert.ok(await outcome({ "package.json": manifest(["packages/**/foo"]), "packages/a/package.json": judged }), "a manifest the pattern cannot reach is left out");
    await rm(join(f.repo, "packages"), { recursive: true });
    assert.equal(await outcome({ "package.json": manifest(["packages/{a,b}"]), "other/package.json": judged }), null, "an unsupported pattern judges every manifest");
    assert.equal(await outcome({ "package.json": manifest(undefined), "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - >-\n    other\n" }), null, "an unsupported YAML form judges every manifest");
    assert.equal(await outcome({ "package.json": manifest(undefined), "pnpm-workspace.yaml": "packages: [apps/*]\n" }), null, "an inline YAML list judges every manifest");
    assert.ok(await outcome({ "package.json": manifest(undefined), "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - 'tools' # note\n\nallowBuilds:\n  x: true\n" }), "a plain list is read exactly");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a pnpm workspace's package list decides which manifests an install runs scripts for", async () => {
  const f = await project({ ignore: "node_modules\n" });
  try {
    await write(f.repo, {
      "package.json": JSON.stringify({ name: "fixture", private: true, packageManager: `bun@${BUN_VERSION}` }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - 'tools'  # quoted\n\nallowBuilds:\n  x: true\n",
      ".repos/vendored/package.json": JSON.stringify({ name: "vendored", scripts: { prepare: "turbo run build --filter=a" } }),
      "apps/a/package.json": JSON.stringify({ name: "a", version: "1.0.0" }),
    });
    jj(f.repo, ["file", "track", "."]);
    assert.ok(await installInputFingerprint(f.repo), "a vendored manifest outside the package list is not judged");
    await write(f.repo, { "tools/package.json": JSON.stringify({ name: "tools", scripts: { prepare: "turbo run build --filter=a" } }) });
    assert.equal(await installInputFingerprint(f.repo), null, "a listed package is judged");
    await write(f.repo, { "pnpm-workspace.yaml": "allowBuilds:\n  x: true\n" });
    assert.equal(await installInputFingerprint(f.repo), null, "with no package list every manifest is judged");
  } finally {
    await f.dispose();
  }
}, 120_000);
