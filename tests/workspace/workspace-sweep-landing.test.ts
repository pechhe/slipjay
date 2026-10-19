import { project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "vite-plus/test";
import { attachWorkspaceIssue } from "../../src/lib/workspace/workspace-state.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { occupy, land } from "./fixtures/workspace-sweep-fixture.ts";

test("landing anywhere releases other delivered checkouts, but not one still in use", async () => {
  const f = await project();
  let release = () => {};
  try {
    // Held while it lands, so it outlives its own landing as a delivered checkout.
    const first = await createWorkspace("first", f.repo);
    await land(f, first.workspacePath, "first.txt", { keep: true });
    assert.ok(existsSync(first.workspacePath));
    const issue = await createWorkspace("issue", f.repo);
    await attachWorkspaceIssue(issue.workspacePath, 41);
    const landed = await land(f, issue.workspacePath, "issue.txt");
    assert.equal(landed.housekeeping?.started, true, "its housekeeping runs after the verdict, detached");
    assert.ok(landed.lines.includes(`Removed workspace: ${first.current.name}`), `the next landing releases the delivered checkout and reports it: ${landed.lines.join("\n")}`);
    assert.equal(existsSync(first.workspacePath), false);
    assert.equal(existsSync(issue.workspacePath), false, "the landing releases its own checkout");
    const busy = await createWorkspace("busy", f.repo);
    await land(f, busy.workspacePath, "busy.txt", { keep: true });
    release = occupy(busy.workspacePath);
    const last = await createWorkspace("last", f.repo);
    const kept = (await land(f, last.workspacePath, "last.txt")).lines.filter((line) => line.startsWith("Kept landed workspace"));
    assert.equal(kept.length, 1, kept.join("\n"));
    assert.match(kept[0]!, new RegExp(`^Kept landed workspace ${busy.current.name}: `), "the landing reports the delivered checkout it kept");
    assert.ok(existsSync(busy.workspacePath), "a delivered checkout with a live process is kept");
    assert.equal(f.remoteFile("last.txt"), "last.txt\n");
  } finally {
    release();
    await f.dispose();
  }
}, 180_000);
