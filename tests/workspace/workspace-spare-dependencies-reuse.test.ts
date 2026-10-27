import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { provisionSpare } from "../../src/lib/workspace/workspace-pool.ts";
import { workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { installInputFingerprint } from "../../src/lib/workspace/install-inputs.ts";
import { write, advance, bunProject } from "./fixtures/workspace-spare-dependencies-fixture.ts";

test("a claimed spare reuses its dependencies when the refresh leaves install inputs unchanged", async () => {
  const f = await bunProject();
  try {
    const provisioned = await provisionSpare(f.repo);
    assert.equal(await f.count(), 1);
    await write(f.repo, {
      "README.md": "changed\n", "scripts/unrelated.mjs": "export const unrelated = 2;\n",
      // A release: version bumps, a new export and a new test script, none of which an install reads.
      "packages/x/package.json": JSON.stringify({ name: "x", version: "1.1.0", exports: { ".": "./index.ts" }, scripts: { test: "bun test" } }),
    });
    advance(f.repo, "Change non-install files");

    const created = await createWorkspace("task", f.repo);
    assert.equal(created.pooled, true);
    const { installAttempts, ...readiness } = created.readiness as { installAttempts?: Record<string, unknown>[] };
    assert.deepEqual(installAttempts, provisioned.installAttempts, "the claim retains its provisioning install evidence");
    assert.equal(installAttempts?.at(-1)?.outcome, "success");
    assert.deepEqual({ ...readiness, installInputs: undefined },
      { state: "ready", packageManager: "bun", installInputs: undefined, reused: true });
    assert.equal(await f.count(), 1, "no install ran on claim");
    assert.ok(existsSync(join(created.workspacePath, "node_modules", ".bun")), "the provisioned node_modules is in place");
    assert.equal(await readFile(join(created.workspacePath, "README.md"), "utf8"), "changed\n", "the claim refreshed to the integration head");
    const recorded = (await workspaceMetadata(created.current.name))?.preparedDependencies as { installInputs?: string; installAttempts?: Record<string, unknown>[] } | undefined;
    assert.deepEqual(recorded?.installAttempts, installAttempts, "the workspace keeps the evidence after assignment");
    assert.equal(recorded?.installInputs, await installInputFingerprint(created.workspacePath), "the claimed workspace records its install inputs, so it can seed others");
  } finally {
    await f.dispose();
  }
}, 120_000);

const inputChanges: Array<[string, (repo: string) => Promise<void>]> = [
  ["a nested package.json's install fields", (repo) => write(repo, { "packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0", engines: { node: ">=18" } }) })],
  ["the lockfile", async (repo) => {
    await write(repo, { "packages/y/package.json": JSON.stringify({ name: "y", version: "1.0.0", dependencies: { x: "workspace:*" } }) });
    execFileSync("bun", ["install"], { cwd: repo, stdio: "pipe" });
  }],
  ["a file the install lifecycle script imports", (repo) => write(repo, {
    "scripts/install-log.mjs": 'import { appendFileSync } from "node:fs";\nexport function record() { appendFileSync(process.env.FIXTURE_INSTALL_LOG, "v2\\n"); }\n',
  })],
];

for (const [label, change] of inputChanges) {
  test(`a claimed spare reinstalls when ${label} changed`, async () => {
    const f = await bunProject();
    try {
      await provisionSpare(f.repo);
      await change(f.repo);
      await rm(f.root + "/installs.log", { force: true });
      advance(f.repo, `Change ${label}`);

      const created = await createWorkspace("task", f.repo);
      assert.equal(created.pooled, true);
      assert.equal((created.readiness as { reused?: boolean }).reused, undefined);
      assert.equal(await f.count(), 1, "the claim installed");
    } finally {
      await f.dispose();
    }
  }, 120_000);
}
