import { project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { onTestFailed, test } from "vite-plus/test";
import { attachWorkspaceIssue } from "../../src/lib/workspace/workspace-state.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { occupy, land } from "./fixtures/workspace-sweep-fixture.ts";

/**
 * Two landings, each starting an in-process runner and joining the detached
 * housekeeping it starts, plus the fixture's project setup. The former single
 * test gave four landings 180 s (45 s each); 150 s here gives each landing 75 s.
 * `onTestFailed` names the landing in flight when a host stalls, instead of
 * leaving only the vitest timeout; a failure inside a landing keeps that landing's
 * name even though cleanup then runs.
 */
const twoLandingBudgetMs = 150_000;

test("landing releases another delivered checkout and its own", async () => {
  let phase = "fixture setup";
  let stalled: string | undefined;
  onTestFailed(() => { process.stderr.write(`workspace sweep landing stalled during: ${stalled ?? phase}\n`); });
  const f = await project();
  try {
    phase = "landing the first delivered checkout";
    // Held while it lands, so it outlives its own landing as a delivered checkout.
    const first = await createWorkspace("first", f.repo);
    await land(f, first.workspacePath, "first.txt", { keep: true });
    assert.ok(existsSync(first.workspacePath));

    phase = "landing the issue checkout";
    const issue = await createWorkspace("issue", f.repo);
    await attachWorkspaceIssue(issue.workspacePath, 41);
    const landed = await land(f, issue.workspacePath, "issue.txt");
    assert.equal(landed.housekeeping?.started, true, "its housekeeping runs after the verdict, detached");
    assert.ok(landed.lines.includes(`Removed workspace: ${first.current.name}`), `the next landing releases the delivered checkout and reports it: ${landed.lines.join("\n")}`);
    assert.equal(existsSync(first.workspacePath), false);
    assert.equal(existsSync(issue.workspacePath), false, "the landing releases its own checkout");
  } catch (error) {
    stalled = phase;
    throw error;
  } finally {
    phase = "fixture cleanup";
    await f.dispose();
  }
}, twoLandingBudgetMs);

test("landing keeps another delivered checkout that is still in use", async () => {
  let phase = "fixture setup";
  let stalled: string | undefined;
  onTestFailed(() => { process.stderr.write(`workspace sweep landing stalled during: ${stalled ?? phase}\n`); });
  const f = await project();
  let release = () => {};
  try {
    phase = "landing the busy delivered checkout";
    const busy = await createWorkspace("busy", f.repo);
    await land(f, busy.workspacePath, "busy.txt", { keep: true });
    release = occupy(busy.workspacePath);

    phase = "landing the next checkout";
    const last = await createWorkspace("last", f.repo);
    const kept = (await land(f, last.workspacePath, "last.txt")).lines.filter((line) => line.startsWith("Kept landed workspace"));
    assert.equal(kept.length, 1, kept.join("\n"));
    assert.match(kept[0]!, new RegExp(`^Kept landed workspace ${busy.current.name}: `), "the landing reports the delivered checkout it kept");
    assert.ok(existsSync(busy.workspacePath), "a delivered checkout with a live process is kept");
    assert.equal(f.remoteFile("last.txt"), "last.txt\n");
  } catch (error) {
    stalled = phase;
    throw error;
  } finally {
    phase = "fixture cleanup";
    release();
    await f.dispose();
  }
}, twoLandingBudgetMs);
