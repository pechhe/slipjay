import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { provisionSpare, readySpares } from "../../src/lib/workspace/workspace-pool.ts";
import { metadataPath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { bunProject, spareName } from "./fixtures/workspace-spare-dependencies-fixture.ts";

const unprovable: Array<[string, (name: string, workspacePath: string) => Promise<void>, boolean]> = [
  ["was prepared without recorded install inputs", async (name) => {
    const { preparedDependencies: _dropped, ...metadata } = (await workspaceMetadata(name)) ?? {};
    await writeFile(metadataPath(name), JSON.stringify(metadata));
  }, true],
  ["lost its node_modules", (_name, workspacePath) => rm(join(workspacePath, "node_modules"), { recursive: true, force: true }), true],
  ["is not marked prepared", async (name) => {
    await writeFile(metadataPath(name), JSON.stringify({ ...await workspaceMetadata(name), prepared: false }));
  }, false],
];

for (const [label, degrade, claimable] of unprovable) {
  test(`a spare that ${label} is never handed out without installing`, async () => {
    const f = await bunProject();
    try {
      await provisionSpare(f.repo);
      const [spare] = await readySpares(f.repo);
      await degrade(await spareName(f.repo), spare!.root!);
      await rm(f.root + "/installs.log", { force: true });

      const created = await createWorkspace("task", f.repo);
      assert.equal(created.pooled, claimable);
      assert.equal((created.readiness as { reused?: boolean }).reused, undefined);
      assert.equal(await f.count(), 1, "the assignment installed");
      assert.ok(existsSync(join(created.workspacePath, "node_modules", ".bun")));
    } finally {
      await f.dispose();
    }
  }, 120_000);
}

test("a host readiness hook decides for itself even when the spare is reusable", async () => {
  const f = await bunProject();
  try {
    await provisionSpare(f.repo);
    const calls: string[] = [];
    const created = await createWorkspace("task", f.repo, { hooks: { prepare: async (_root, path) => { calls.push(path); return "host"; } } });
    assert.equal(created.pooled, true);
    assert.deepEqual(calls, [created.workspacePath]);
    assert.equal(created.readiness, "host");
  } finally {
    await f.dispose();
  }
}, 120_000);
