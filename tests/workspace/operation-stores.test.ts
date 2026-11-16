import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { jj, project } from "../support/workspace-project.ts";
import { operationStoreReports, OP_STORE_WARN_BYTES } from "../../src/lib/host-disk/operation-stores.ts";
import { hostDisk } from "../../src/lib/host-disk/host-disk.ts";
import { defaultDiskConfig } from "../../src/lib/host-disk/disk-config.ts";
import { readFile } from "node:fs/promises";
import { diskHeartbeatPath } from "../../src/lib/host-disk/disk-heartbeat.ts";

test("operation-store accounting warns on large and unreadable stores, once per integration root", async () => {
  const reports = await operationStoreReports(["/repo", "/repo", "/unknown"], async (path) => path.startsWith("/repo/") ? OP_STORE_WARN_BYTES : null);
  assert.equal(reports.length, 2);
  assert.match(reports[0]!.warning!, /5.0 GiB/);
  assert.match(reports[1]!.warning!, /cannot measure/);
});

test("maintain's disk pass reports op-store pressure in its heartbeat without changing jj operation identities", async () => {
  const f = await project();
  try {
    const before = jj(f.repo, ["op", "log", "--no-graph", "-T", 'id ++ "\\n"']);
    const config = defaultDiskConfig();
    config.floor = { bytes: 0, percent: 0 }; config.ballast.bytes = 0; config.scratchRoots = []; config.regenerable = [];
    const outcome = await hostDisk({ maintain: true, config, integrationRoots: async () => [f.repo], readUsage: async () => ({ percent: 1, freeBytes: 100 }),
      host: { workspaceRows: async () => [], readDir: async () => [], sizeOf: async () => OP_STORE_WARN_BYTES },
    });
    assert.ok(outcome.state === "applied");
    assert.match(outcome.notes.join("\n"), /JJ operation store.*5.0 GiB/);
    const heartbeat = JSON.parse(await readFile(diskHeartbeatPath(), "utf8")) as { operationStores: Array<{ sizeBytes: number }> };
    assert.equal(heartbeat.operationStores[0]!.sizeBytes, OP_STORE_WARN_BYTES);
    assert.equal(jj(f.repo, ["op", "log", "--no-graph", "-T", 'id ++ "\\n"']), before);
  } finally { await f.dispose(); }
});
