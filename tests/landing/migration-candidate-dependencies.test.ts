import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { advance, write, fixture, append } from "./fixtures/migration-candidate-fixture.ts";

test("the runner prepares dependency drift from final rebase before generating and verifying", async () => {
  const f = await fixture('import { marker } from "fixture-dependency"; if(marker!==42)throw Error("dependency wrong");' + append);
  try {
    await write(f.repo, "package.json", JSON.stringify({ name: "fixture", private: true, packageManager: "bun@1.4.2", workspaces: ["packages/*"], dependencies: { "fixture-dependency": "workspace:*" } }));
    await write(f.repo, "packages/dependency/package.json", JSON.stringify({ name: "fixture-dependency", version: "1.0.0", type: "module", exports: "./index.js" }));
    await write(f.repo, "packages/dependency/index.js", "export const marker=42;");
    execFileSync("bun", ["install"], { cwd: f.repo, stdio: "pipe" });
    advance(f.repo, "Dependency introduced after allocation");
    assert.equal(existsSync(join(f.workspace, "node_modules/fixture-dependency")), false);
    const landed = await f.land();
    assert.equal(landed.ok, true, landed.output);
    assert.equal(f.remoteFile("migrations/0001.sql"), "generated");
    assert.equal(await readFile(join(f.root, "migration-verified"), "utf8"), "yes");
    assert.ok(existsSync(f.verified), "the landing gate ran");
    assert.equal(existsSync(f.workspace), false, "the landed workspace was released");
  } finally { await f.dispose(); }
}, 60000);

test("a frozen preparation failure prevents generation and integration and retains semantic source", async () => {
  const f = await fixture(append);
  try {
    await write(f.repo, "package.json", JSON.stringify({ name: "fixture", packageManager: "bun@1.4.2", dependencies: { missing: "file:./does-not-exist" } }));
    advance(f.repo, "Uninstallable final graph");
    const base = f.remoteMain();
    const result = await f.land();
    assert.equal(result.ok, false);
    assert.match(result.output, /bun install/);
    assert.doesNotMatch(result.output, /rollback requires reconciliation/);
    assert.equal(existsSync(join(f.root, "migration-verified")), false);
    assert.equal(f.remoteMain(), base);
    assert.equal(await readFile(join(f.workspace, "schema/source"), "utf8"), "new");
  } finally { await f.dispose(); }
}, 60000);

test("installation source drift is fenced before generation and restored without integration", async () => {
  const f = await fixture(append);
  try {
    await write(f.repo, "package.json", JSON.stringify({ name: "fixture", packageManager: "bun@1.4.2", scripts: { postinstall: 'node -e \"require(\\\"node:fs\\\").writeFileSync(\\\"schema/source\\\",\\\"tampered\\\")\"' } }));
    execFileSync("bun", ["install"], { cwd: f.repo, stdio: "pipe" });
    await write(f.repo, "schema/source", "old");
    advance(f.repo, "Install script changes source");
    const base = f.remoteMain();
    const out = await f.land();
    assert.equal(out.ok, false);
    assert.match(out.output, /Dependency preparation changed the landing candidate's source/);
    assert.equal(f.remoteMain(), base);
  } finally { await f.dispose(); }
}, 60000);
