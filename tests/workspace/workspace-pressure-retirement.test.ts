import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { jj, project } from "../support/workspace-project.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { recordWorkspaceActivity } from "../../src/lib/workspace/workspace-eviction.ts";
import { latestReleaseFor } from "../../src/lib/workspace/workspace-release.ts";
import { readArchive } from "../../src/lib/workspace/workspace-archive.ts";
import { hostDisk } from "../../src/lib/host-disk/host-disk.ts";
import { defaultDiskConfig } from "../../src/lib/host-disk/disk-config.ts";

test("pressure retirement preserves unlanded tracked source and ignored source through the existing archive", async () => {
  const f = await project({ ignore: "local.txt\n" });
  try {
    const w = await createWorkspace("pressure-source", f.repo);
    await writeFile(join(w.workspacePath, "README.md"), "unlanded tracked source\n");
    await writeFile(join(w.workspacePath, "local.txt"), "ignored source\n");
    await recordWorkspaceActivity(w.current.name, Date.now() - 48 * 3600_000);
    const config = defaultDiskConfig();
    config.floor = { bytes: 40, percent: 0 }; config.ballast.bytes = 0; config.scratchRoots = []; config.regenerable = [];
    const outcome = await hostDisk({ config, integrationRoots: async () => [f.repo], readUsage: async () => ({ percent: 1, freeBytes: existsSync(w.workspacePath) ? 10 : 40 }),
      host: { readDir: async () => [], sizeOf: async () => 100, workspaceRows: async () => [{ path: w.workspacePath, class: "workspace", action: "keep", reason: "no dependency trees installed", sizeBytes: 100, owner: w.current.name, retirable: true, idleSince: 0 }] },
    });
    assert.ok(outcome.state === "applied");
    assert.equal(outcome.results.find((row) => row.path === w.workspacePath)!.outcome, "removed");
    const release = await latestReleaseFor(w.workspacePath);
    assert.ok(release?.state === "retired", JSON.stringify(release));
    const archive = await readArchive(release.archiveId);
    assert.ok(archive);
    assert.equal(jj(f.repo, ["file", "show", "-r", archive.bookmark, "README.md"]), "unlanded tracked source");
    assert.ok(archive.inventory.includes("local.txt"));
    assert.ok(archive.payload);
  } finally { await f.dispose(); }
});
