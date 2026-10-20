import { project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { cleanupLandedWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { renameWorkspace } from "../../src/lib/workspace/workspace-state.ts";
import { statePath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { landedHome } from "../../src/lib/workspace/workspace-paths.ts";
import { landed, readJson, runCli } from "./fixtures/workspace-lifecycle-convergence-fixture.ts";

const landedPath = (name: string) => join(landedHome(), `${name}.json`);


test("attaching an Issue to a landed workspace is refused", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "attach.txt");
    const result = await runCli(workspace.workspacePath, ["attach-issue", "77"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /has landed, so it is read-only/);
    assert.equal((await workspaceMetadata(workspace.current.name))?.issueNumber, undefined);
  } finally {
    await f.dispose();
  }
}, 120_000);

test("rename preserves landing state in both locations with its history", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "rename.txt");
    const oldName = workspace.current.name;
    // A legacy landing record lives under landed/ beside the current top-level one.
    await mkdir(join(landedPath(oldName), ".."), { recursive: true });
    await copyFile(statePath(oldName), landedPath(oldName));

    const { name } = await renameWorkspace(workspace.workspacePath, "renamed task");
    assert.equal(name, "renamed-task");
    for (const path of [statePath(name), landedPath(name)]) {
      const state = await readJson(path);
      assert.equal(state.workspaceName, name);
      assert.deepEqual(state.previousWorkspaceNames, [oldName]);
    }
    assert.equal(existsSync(statePath(oldName)), false);
    assert.equal(existsSync(landedPath(oldName)), false);
    const metadata = await workspaceMetadata(name);
    assert.deepEqual(metadata?.previousWorkspaceNames, [oldName]);
    assert.equal((metadata?.workspaceRenameEpochs as Array<{ toName: string }> | undefined)?.at(-1)?.toName, name);
    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: true });
  } finally {
    await f.dispose();
  }
}, 120_000);
