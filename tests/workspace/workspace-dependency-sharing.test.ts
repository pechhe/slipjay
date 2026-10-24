import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { cloneNodeModulesCommand, dependencyInstallCommand } from "../../src/lib/workspace/workspace-dependencies.ts";

test("pnpm hard-links packages where the filesystem cannot clone", () => {
  const linux = dependencyInstallCommand("pnpm@12.14.0", "linux");
  assert.deepEqual(linux?.args.slice(-1), ["--package-import-method=hardlink"], "ext4 copies with clone-or-copy, so share the blocks instead");
  const mac = dependencyInstallCommand("pnpm@12.14.0", "darwin");
  assert.deepEqual(mac?.args.slice(-1), ["--package-import-method=clone-or-copy"], "an APFS clone is free and keeps full isolation");
  assert.equal(linux?.command, "pnpm");
  assert.ok(linux?.args.includes("--frozen-lockfile"), "the install stays lockfile-frozen");
});

test("every supported package manager keeps its own install command", () => {
  assert.equal(dependencyInstallCommand("bun@1.4.3", "linux")?.command, "bun");
  assert.equal(dependencyInstallCommand("npm@11", "linux")?.command, "npm");
  assert.equal(dependencyInstallCommand("yarn@4", "linux"), null, "an unsupported manager is not guessed at");
});

test("seeding hard-links on Linux, where --reflink=auto silently copies", () => {
  assert.deepEqual(cloneNodeModulesCommand("linux"), ["cp", "-al"]);
  assert.deepEqual(cloneNodeModulesCommand("darwin"), ["cp", "-cRP"]);
  assert.equal(cloneNodeModulesCommand("win32"), null);
});
