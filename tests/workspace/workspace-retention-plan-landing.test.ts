import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { planDisposableWorkspaces, sweepDisposableWorkspaces } from "../../src/lib/workspace/workspace-sweep.ts";
import { landedHome } from "../../src/lib/workspace/workspace-paths.ts";
import { statePath } from "../../src/lib/workspace/workspace-state.ts";
import { cli, later, byName, landed } from "./fixtures/workspace-retention-plan-fixture.ts";

test("a landed workspace with pending housekeeping is planned as kept, without finishing it", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "pending.txt");
    const path = statePath(workspace.current.name);
    const state = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...state, cleanupPending: true, cleanupError: "interrupted" }));
    const before = await readFile(path, "utf8");
    const plan = byName(await planDisposableWorkspaces(f.repo));
    assert.equal(plan[workspace.current.name]?.action, "keep");
    assert.equal(plan[workspace.current.name]?.reason, "housekeeping-pending");
    assert.equal(await readFile(path, "utf8"), before, "the plan leaves the landing's housekeeping to cleanup");
    assert.ok(existsSync(workspace.workspacePath));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a landing record naming another delivery's archived artifact is kept, with the same reason by plan and sweep", async () => {
  const f = await project({ ignore: "*.local\n" });
  try {
    const workspace = await landed(f, "copied.txt");
    const state = JSON.parse(await readFile(statePath(workspace.current.name), "utf8"));
    // The artifact's archive names another workspace's delivery: the landing archived it here under
    // that name, as a delivery archived on another machine would when this one reads it.
    const archived = await Promise.all((await readdir(landedHome())).map(async (name) => ({ name, record: JSON.parse(await readFile(join(landedHome(), name), "utf8")) as Record<string, unknown> })));
    const own = archived.find((entry) => entry.record.artifactCommitId === state.artifactCommitId);
    assert.ok(own, "the landing archived its own delivery first");
    await writeFile(join(landedHome(), own.name), JSON.stringify({ ...own.record, workspaceName: "earlier-delivery" }));
    const planned = byName(await planDisposableWorkspaces(f.repo, { now: later() }))[workspace.current.name];
    assert.equal(planned?.action, "keep");
    assert.match(planned?.reason ?? "", /already archived as workspace earlier-delivery's landing.*slipjay remove /);
    const swept = await sweepDisposableWorkspaces(f.repo, { now: later() });
    assert.ok(!swept.removed.includes(workspace.current.name));
    assert.equal(swept.skipped.find((entry) => entry.name === workspace.current.name)?.reason, planned?.reason);
    assert.ok(existsSync(workspace.workspacePath));
    // The removal the reason suggests works: the checkout is judged as one that never landed,
    // so a file no history holds still keeps it.
    const remove = () => new Promise<{ code: number; stderr: string }>((resolveRun) => {
      execFile("bun", [cli, "remove", workspace.workspacePath], { cwd: f.repo }, (error, _stdout, stderr) =>
        resolveRun({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stderr }));
    });
    const notes = join(workspace.workspacePath, "notes.local");
    await writeFile(notes, "only here\n");
    const kept = await remove();
    assert.equal(kept.code, 1);
    assert.match(kept.stderr, /holds files cleanup will not delete: notes\.local/);
    assert.ok(existsSync(notes));
    await rm(notes);
    const removed = await remove();
    assert.equal(removed.code, 0, removed.stderr);
    assert.ok(!existsSync(workspace.workspacePath));
    assert.ok(!jj(f.repo, ["workspace", "list", "-T", 'name ++ "\\n"']).includes(workspace.current.name));
  } finally {
    await f.dispose();
  }
}, 120_000);
