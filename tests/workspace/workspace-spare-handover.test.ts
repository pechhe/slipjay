import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { removeWorkspace, retireWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { readySpares } from "../../src/lib/workspace/workspace-pool.ts";
import { spareRecords } from "../../src/lib/workspace/workspace-spares.ts";
import { listWorkspaces } from "../../src/lib/workspace/workspace-state.ts";
import { bunProject, refill, withMachineSpares } from "./fixtures/workspace-spare-dependencies-fixture.ts";

test("a retiring checkout's node_modules move to a new spare when the pool is short", async () => {
  const f = await bunProject();
  try {
    await withMachineSpares({ [f.repo]: 1 }, async () => {
      const created = await createWorkspace("task", f.repo);
      assert.equal(created.pooled, false, "no spare was ready");
      await writeFile(join(created.workspacePath, "node_modules", ".handover-marker"), "moved\n");

      await removeWorkspace(f.repo, created.current.name);
      assert.equal(existsSync(created.workspacePath), false);
      const [record, ...others] = await spareRecords(f.repo);
      assert.ok(record, "a spare was registered");
      assert.deepEqual(others, []);
      assert.notEqual(record.workspacePath, created.workspacePath, "the spare has its own path");

      // The refill the handover started adopts the spare and installs over the moved tree.
      await vi.waitFor(async () => assert.equal((await readySpares(f.repo)).length, 1), { timeout: 120_000, interval: 200 });
      assert.ok(existsSync(join(record.workspacePath, "node_modules", ".handover-marker")), "the spare kept the moved node_modules");
    });
  } finally {
    await f.dispose();
  }
}, 180_000);

test("a retiring checkout's node_modules are discarded when the pool is full", async () => {
  const f = await bunProject();
  try {
    await withMachineSpares({ [f.repo]: 1 }, async () => {
      const created = await createWorkspace("task", f.repo);
      await refill(f.repo);
      const [spare] = await spareRecords(f.repo);
      assert.ok(spare);

      await removeWorkspace(f.repo, created.current.name);
      assert.deepEqual((await spareRecords(f.repo)).map((record) => record.workspaceName), [spare.workspaceName], "no spare was added");
    });
  } finally {
    await f.dispose();
  }
}, 180_000);

test("a checkout whose forget fails keeps its node_modules", async () => {
  const f = await bunProject();
  try {
    await withMachineSpares({ [f.repo]: 1 }, async () => {
      const created = await createWorkspace("task", f.repo);
      const marker = join(created.workspacePath, "node_modules", ".handover-marker");
      await writeFile(marker, "kept\n");
      const forget = async () => { throw new Error("refused"); };

      await assert.rejects(retireWorkspace(f.repo, { name: created.current.name, root: created.workspacePath }, { forget }), /refused/);
      assert.ok(existsSync(marker), "the retained checkout has its dependencies back");
      assert.ok((await listWorkspaces(f.repo)).some((workspace) => workspace.name === created.current.name), "the checkout is still registered");
      // The spare made for the handover is handed to a refill, which prepares it from scratch.
      await vi.waitFor(async () => assert.equal((await readySpares(f.repo)).length, 1), { timeout: 120_000, interval: 200 });
    });
  } finally {
    await f.dispose();
  }
}, 180_000);
