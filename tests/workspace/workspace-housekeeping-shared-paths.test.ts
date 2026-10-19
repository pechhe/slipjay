import { jj, project } from "../support/workspace-project.ts";
import { landThroughTestRunner } from "../support/test-runner.ts";
import assert from "node:assert/strict";
import { existsSync, readlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { cleanupLandedWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";

test("a workspace linked to a shared path in the primary checkout is still released by cleanup", async () => {
  const f = await project({ ignore: "artifacts/\n", policy: { sharedPaths: ["artifacts"] } });
  try {
    const workspace = await createWorkspace("shared", f.repo);
    const link = join(workspace.workspacePath, "artifacts");
    assert.equal(readlinkSync(link), join(f.repo, "artifacts"));
    await writeFile(join(link, "report.json"), "{}\n");
    await writeFile(join(workspace.workspacePath, "shared.txt"), "shared\n");
    jj(workspace.workspacePath, ["describe", "-m", "Add shared"]);
    const landed = await landThroughTestRunner(f, workspace.workspacePath, { keep: true });
    assert.equal(landed.ok, true, landed.lines.join("\n"));
    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: true });
    assert.equal(existsSync(join(f.repo, "artifacts", "report.json")), true, "the primary's artifacts outlive the workspace");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("shared paths are linked once, replace an empty directory and never clobber content", async () => {
  const f = await project({ ignore: "artifacts/\ncache/\n", policy: { sharedPaths: ["artifacts", "out/reports", "cache"] } });
  try {
    const workspace = await createWorkspace("links", f.repo);
    for (const path of ["artifacts", "out/reports", "cache"]) assert.equal(readlinkSync(join(workspace.workspacePath, path)), join(f.repo, path), path);
    assert.ok(existsSync(join(f.repo, "out", "reports")), "the target directory is created in the primary");
    const { linkSharedPaths } = await import("../../src/lib/workspace/workspace-shared-paths.ts");
    assert.deepEqual((await linkSharedPaths(f.repo, workspace.workspacePath)).map(({ status }) => status), ["linked", "linked", "linked"], "idempotent");
    // A real directory: empty is replaced, with content it is left alone.
    const other = join(f.root, "other");
    await mkdir(join(other, "artifacts"), { recursive: true });
    await mkdir(join(other, "cache"), { recursive: true });
    await writeFile(join(other, "cache", "keep.txt"), "mine\n");
    const results = await linkSharedPaths(f.repo, other);
    assert.deepEqual(Object.fromEntries(results.map(({ path, status }) => [path, status])), { artifacts: "linked", "out/reports": "linked", cache: "kept" });
    assert.equal(existsSync(join(other, "cache", "keep.txt")), true);
  } finally {
    await f.dispose();
  }
}, 120_000);
