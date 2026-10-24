import { project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { workspaceContext } from "../../src/lib/infra/workspace-jj.ts";
import { workspaceCoverage } from "../../src/lib/workspace/workspace-coverage.ts";
import { landedHome } from "../../src/lib/workspace/workspace-paths.ts";
import { statePath } from "../../src/lib/workspace/workspace-state.ts";
import { planDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { byName, later } from "./fixtures/workspace-retention-plan-fixture.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { landThroughTestRunner } from "../support/test-runner.ts";

// A landing that runs on a runner used to archive only in the runner's state home, so the machine
// holding the checkout could not prove the delivery and kept the workspace for ever as unlanded work.

test("a runner landing records its delivery here, naming the commit the workspace submitted", async () => {
  const f = await project();
  try {
    const workspace = await createWorkspace("delivered.txt", f.repo);
    await writeFile(join(workspace.workspacePath, "delivered.txt"), "delivered.txt\n");
    const result = await landThroughTestRunner(f, workspace.workspacePath, { keep: true });
    assert.equal(result.ok, true, result.lines.join("\n"));
    const state = JSON.parse(await readFile(statePath(workspace.current.name), "utf8")) as { artifactCommitId: string };
    const archives = await Promise.all((await readdir(landedHome())).filter((name) => name.startsWith("artifact-")).map(async (name) =>
      JSON.parse(await readFile(join(landedHome(), name), "utf8")) as Record<string, unknown>));
    const record = archives.find((archive) => archive.artifactCommitId === state.artifactCommitId);
    assert.ok(record, "the landing's record is kept where this machine's cleanup reads it");
    assert.match(String(record.publishedSource), /^[a-f0-9]{40}$/);
    const context = (await workspaceContext(workspace.workspacePath))!;
    assert.notEqual(await workspaceCoverage(context, context.current.name), "uncovered",
      "the delivery, not an absence of evidence, is what judges the workspace");
    assert.equal(byName(await planDisposableWorkspaces(f.repo, { now: later() }))[workspace.current.name]?.action, "remove");
  } finally {
    await f.dispose();
  }
}, 120_000);
