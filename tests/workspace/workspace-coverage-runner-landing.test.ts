import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { planDisposableWorkspaces, sweepDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { landedHome } from "../../src/lib/workspace/workspace-paths.ts";
import { byName, landed, later } from "./fixtures/workspace-retention-plan-fixture.ts";

// A landing that runs on a remote runner archives its evidence in the runner's state home, so the
// machine holding the checkout never sees an `artifact-*` record. Without one, `workspaceCoverage`
// read every landed checkout as uncovered, and the sweep pinned it as "unlanded work" for ever.

test("a workspace whose landing evidence stayed on the runner is still releasable here", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "delivered.txt");
    await rm(landedHome(), { recursive: true, force: true });
    const planned = byName(await planDisposableWorkspaces(f.repo, { now: later() }))[workspace.current.name];
    assert.equal(planned?.action, "remove", planned?.reason ?? "");
    const swept = await sweepDisposableWorkspaces(f.repo, { now: later() });
    assert.ok(swept.removed.includes(workspace.current.name), JSON.stringify(swept.skipped));
    assert.ok(!existsSync(workspace.workspacePath));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("work the landing never delivered keeps the workspace, without an archive to say otherwise", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "delivered.txt");
    await rm(landedHome(), { recursive: true, force: true });
    await writeFile(join(workspace.workspacePath, "later.txt"), "work after the landing\n");
    const planned = byName(await planDisposableWorkspaces(f.repo, { now: later() }))[workspace.current.name];
    assert.equal(planned?.action, "keep");
    const swept = await sweepDisposableWorkspaces(f.repo, { now: later() });
    assert.ok(!swept.removed.includes(workspace.current.name));
    assert.ok(existsSync(join(workspace.workspacePath, "later.txt")));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a path the integration branch already holds is not work the landing missed", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "delivered.txt");
    await rm(landedHome(), { recursive: true, force: true });
    // The branch moves on with content this checkout holds too, so the checkout's copy of it is not its work.
    await writeFile(join(f.repo, "shared.txt"), "shared.txt\n");
    jj(f.repo, ["bookmark", "set", "main", "-r", "@"]);
    await writeFile(join(workspace.workspacePath, "shared.txt"), "shared.txt\n");
    // The plan cannot snapshot, so the unwritten edit keeps it there; the sweep snapshots and judges it.
    const planned = byName(await planDisposableWorkspaces(f.repo, { now: later() }))[workspace.current.name];
    assert.equal(planned?.action, "keep");
    const swept = await sweepDisposableWorkspaces(f.repo, { now: later() });
    assert.ok(swept.removed.includes(workspace.current.name), JSON.stringify(swept.skipped));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a landed file the checkout deleted is work, even though the range's net diff hides it", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "delivered.txt");
    await rm(landedHome(), { recursive: true, force: true });
    // The deletion cancels the commit's own addition, so no diff of the range or of that commit names the path.
    await rm(join(workspace.workspacePath, "delivered.txt"));
    const swept = await sweepDisposableWorkspaces(f.repo, { now: later() });
    assert.ok(!swept.removed.includes(workspace.current.name), "a deleted delivered file must keep the workspace");
    assert.ok(existsSync(workspace.workspacePath));
    assert.ok(!existsSync(join(workspace.workspacePath, "delivered.txt")));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("an executable bit the landing never delivered is work, though the bytes match", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "delivered.script");
    await rm(landedHome(), { recursive: true, force: true });
    await chmod(join(workspace.workspacePath, "delivered.script"), 0o755);
    const swept = await sweepDisposableWorkspaces(f.repo, { now: later() });
    assert.ok(!swept.removed.includes(workspace.current.name), "a mode change must keep the workspace");
    assert.ok(existsSync(workspace.workspacePath));
  } finally {
    await f.dispose();
  }
}, 120_000);
