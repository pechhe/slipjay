import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { test } from "vite-plus/test";
import { removeWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { createWorkspace, findIssueWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { metadataHome, workspaceHome } from "../../src/lib/workspace/workspace-paths.ts";
import { metadataFile } from "./fixtures/workspace-lifecycle-convergence-fixture.ts";

for (const [historicalHome, issueNumber] of [[".pi", 96505], [".slipway", 96506]] as const) {
  test(`a missing empty Issue checkout under ${historicalHome} is safely recovered`, async () => {
    const f = await project();
    const name = `historical-${issueNumber}`;
    const storage = join(homedir(), historicalHome, "workspaces");
    const oldPath = join(storage, name);
    try {
      await mkdir(storage, { recursive: true });
      await mkdir(metadataHome(), { recursive: true });
      jj(f.repo, ["workspace", "add", "--name", name, "-r", "main", oldPath]);
      await writeFile(metadataFile(name), JSON.stringify({ version: 1, workspaceName: name, workspacePath: oldPath,
        integrationRoot: f.repo, issueNumber, task: "Historical Issue work" }));
      await rm(oldPath, { recursive: true });
      assert.equal(await findIssueWorkspace(f.repo, issueNumber), null);
      const recreated = await createWorkspace("Recovered historical work", f.repo, { issueNumber });
      assert.equal(recreated.created, true);
      assert.ok(recreated.workspacePath.startsWith(workspaceHome() + "/"));
      assert.equal((await workspaceMetadata(recreated.current.name))?.issueNumber, issueNumber);
      assert.equal(existsSync(metadataFile(name)), false, "the safe stale generation was retired");
    } finally {
      await rm(metadataFile(name), { force: true });
      await f.dispose();
    }
  }, 120_000);

  test(`an empty retained checkout under ${historicalHome} can be removed`, async () => {
    const f = await project();
    const name = `removable-${issueNumber}`;
    const storage = join(homedir(), historicalHome, "workspaces");
    const path = join(storage, name);
    try {
      await mkdir(storage, { recursive: true });
      jj(f.repo, ["workspace", "add", "--name", name, "-r", "main", path]);
      await removeWorkspace(f.repo, name);
      assert.equal(existsSync(path), false);
    } finally {
      await rm(path, { recursive: true, force: true });
      await f.dispose();
    }
  }, 120_000);
}

test("missing Issue recovery still refuses paths outside every workspace storage root", async () => {
  const f = await project();
  const name = "outside-storage";
  const outside = join(f.root, name);
  try {
    await mkdir(metadataHome(), { recursive: true });
    jj(f.repo, ["workspace", "add", "--name", name, "-r", "main", outside]);
    await writeFile(metadataFile(name), JSON.stringify({ version: 1, workspaceName: name, workspacePath: outside,
      integrationRoot: f.repo, issueNumber: 96507, task: "Unsafe stale path" }));
    await rm(outside, { recursive: true });
    await assert.rejects(findIssueWorkspace(f.repo, 96507), /unsafe stale path; preserve it for explicit recovery/);
    assert.equal(existsSync(metadataFile(name)), true);
  } finally {
    await rm(metadataFile(name), { force: true });
    await f.dispose();
  }
}, 120_000);
