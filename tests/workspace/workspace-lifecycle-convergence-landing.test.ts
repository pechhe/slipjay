import { jj, project } from "../support/workspace-project.ts";
import { landThroughTestRunner } from "../support/test-runner.ts";
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { cleanupLandedWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { renameWorkspace } from "../../src/lib/workspace/workspace-state.ts";
import { statePath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { withinWorkspaceStorage } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { landedHome } from "../../src/lib/workspace/workspace-paths.ts";
import { runCli } from "./fixtures/workspace-lifecycle-convergence-fixture.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";

async function landed(f: Awaited<ReturnType<typeof project>>, file: string) {
  const workspace = await createWorkspace(file, f.repo);
  await writeFile(join(workspace.workspacePath, file), `${file}\n`);
  // Held while it lands, so the landing keeps it for the test.
  const result = await landThroughTestRunner(f, workspace.workspacePath, { keep: true });
  assert.equal(result.ok, true, result.lines.join("\n"));
  return workspace;
}

const landedPath = (name: string) => join(landedHome(), `${name}.json`);

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

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

test("cleanup retries pending housekeeping before releasing a landed workspace", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "pending.txt");
    const state = await readJson(statePath(workspace.current.name));
    await writeFile(statePath(workspace.current.name), JSON.stringify({ ...state, cleanupPending: true, cleanupError: "interrupted" }));
    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: true });
    assert.equal(existsSync(workspace.workspacePath), false);
  } finally {
    await f.dispose();
  }
}, 120_000);

test("cleanup refuses a checkout outside workspace storage", async () => {
  const f = await project();
  try {
    const outside = join(f.root, "outside");
    jj(f.repo, ["workspace", "add", "--name", "outside", outside]);
    await writeFile(join(outside, "outside.txt"), "outside\n");
    jj(outside, ["describe", "-m", "Add outside"]);
    assert.equal((await landThroughTestRunner(f, outside)).ok, true);
    assert.equal(await withinWorkspaceStorage(outside), false);
    assert.deepEqual(await cleanupLandedWorkspace(outside), { cleaned: false, reason: "outside-workspace-storage" });
    assert.ok(existsSync(join(outside, "outside.txt")));
  } finally {
    await f.dispose();
  }
}, 120_000);
