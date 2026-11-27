import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "vite-plus/test";
import { project } from "../support/workspace-project.ts";
import { provisionSpare } from "../../src/lib/workspace/workspace-pool.ts";
import { spareRecords } from "../../src/lib/workspace/workspace-spares.ts";
import { machineConfigPath } from "../../src/lib/workspace/workspace-paths.ts";
import { hostDisk } from "../../src/lib/host-disk/host-disk.ts";
import { defaultDiskConfig } from "../../src/lib/host-disk/disk-config.ts";

test("pressure actually removes a pool spare above the configured allowance", async () => {
  const f = await project({ policy: { spares: 2 } });
  const original = await readFile(machineConfigPath(), "utf8");
  try {
    assert.equal((await provisionSpare(f.repo)).provisioned, true);
    assert.equal((await provisionSpare(f.repo)).provisioned, true);
    await writeFile(machineConfigPath(), JSON.stringify({ ...JSON.parse(original) as object, spares: { [f.repo]: 1 } }));
    const config = defaultDiskConfig();
    config.floor = { bytes: 40, percent: 0 }; config.ballast.bytes = 0; config.scratchRoots = []; config.regenerable = [];
    const records = await spareRecords(f.repo);
    const outcome = await hostDisk({ config, integrationRoots: async () => [f.repo],
      readUsage: async () => ({ percent: 1, freeBytes: (await spareRecords(f.repo)).length > 1 ? 10 : 40 }),
      host: { dockerVolumes: async () => [], loopImages: async () => [], readDir: async () => [], sizeOf: async () => 100, workspaceRows: async () => records.map((record) => ({ path: record.workspacePath, class: "workspace", action: "keep", reason: "a pool spare", owner: record.workspaceName, sizeBytes: 100, spare: true, repository: f.repo })) },
    });
    assert.ok(outcome.state === "applied");
    assert.equal((await spareRecords(f.repo)).length, 1);
    assert.equal(outcome.results.filter((row) => row.outcome === "removed").length, 1);
    assert.match(outcome.results.find((row) => row.outcome === "removed")!.detail, /df delta 30/);
  } finally { await writeFile(machineConfigPath(), original); await f.dispose(); }
});
