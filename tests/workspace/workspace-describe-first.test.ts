import { jj, project } from "../support/workspace-project.ts";
import { landOnTestRunner, withTestRunner } from "../support/test-runner.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { provisionSpare } from "../../src/lib/workspace/workspace-pool.ts";
import { landingGuardDecision } from "../../src/lib/landing/landing-guard.ts";

const description = (cwd: string) => jj(cwd, ["log", "-r", "@", "--no-graph", "-T", "description"]);
const remoteMessage = (remote: string) => execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%B", "main"], { encoding: "utf8" }).trim();
const guard = (cwd: string, command: string) => landingGuardDecision({ tool_name: "Bash", cwd, tool_input: { command } });
const reason = (decision: Awaited<ReturnType<typeof guard>>) => decision?.hookSpecificOutput.permissionDecisionReason ?? "";

test("start describes an empty change with its task and Issue, for new, claimed and resumed workspaces", async () => {
  const f = await project();
  try {
    const fresh = await createWorkspace("Add widgets", f.repo);
    assert.equal(description(fresh.workspacePath).trim(), "wip: Add widgets");

    const issue = await createWorkspace("Add gadgets", f.repo, { issueNumber: 55 });
    assert.equal(description(issue.workspacePath).trim(), "wip: Add gadgets (#55)");

    const fromIssueOnly = await createWorkspace("Issue #56", f.repo, { issueNumber: 56 });
    assert.equal(description(fromIssueOnly.workspacePath).trim(), "wip: Issue #56");

    await provisionSpare(f.repo);
    const claimed = await createWorkspace("Claimed task", f.repo);
    assert.equal(claimed.pooled, true);
    assert.equal(description(claimed.workspacePath).trim(), "wip: Claimed task");

    // A resumed workspace keeps whatever its change already says, even nothing.
    jj(issue.workspacePath, ["describe", "-m", "Real words"]);
    await createWorkspace("Add gadgets", f.repo, { issueNumber: 55 });
    assert.equal(description(issue.workspacePath).trim(), "Real words");
    jj(fromIssueOnly.workspacePath, ["describe", "-m", ""]);
    await writeFile(join(fromIssueOnly.workspacePath, "work.txt"), "work\n");
    await createWorkspace("Issue #56", f.repo, { issueNumber: 56 });
    assert.equal(description(fromIssueOnly.workspacePath).trim(), "", "a change holding work is never given a placeholder");
  } finally {
    await f.dispose();
  }
}, 180_000);

test("landing replaces the generated wip placeholder with the task, keeps a hand-written wip: description, and refuses a placeholder lower in a stack", async () => {
  const f = await project();
  try {
    await withTestRunner(f, async (runner) => {
      const generated = await createWorkspace("Add widgets", f.repo);
      await writeFile(join(generated.workspacePath, "widgets.txt"), "w\n");
      assert.equal(description(generated.workspacePath).trim(), "wip: Add widgets");
      const landed = await landOnTestRunner(runner, generated.workspacePath);
      assert.equal(landed.ok, true);
      assert.equal(remoteMessage(f.remote), "Add widgets");

      const manual = await createWorkspace("Add gadgets", f.repo);
      await writeFile(join(manual.workspacePath, "gadgets.txt"), "g\n");
      jj(manual.workspacePath, ["describe", "-m", "wip: spike the widget cache"]);
      const manualLanded = await landOnTestRunner(runner, manual.workspacePath);
      assert.equal(manualLanded.ok, true);
      assert.equal(remoteMessage(f.remote), "wip: spike the widget cache");

      const stacked = await createWorkspace("Add stack", f.repo);
      await writeFile(join(stacked.workspacePath, "a.txt"), "a\n");
      jj(stacked.workspacePath, ["new"]);
      await writeFile(join(stacked.workspacePath, "b.txt"), "b\n");
      jj(stacked.workspacePath, ["describe", "-m", "Add b"]);
      await assert.rejects(landOnTestRunner(runner, stacked.workspacePath), /real description for commit \w+.*jj describe -r/s);
    });
  } finally {
    await f.dispose();
  }
}, 120_000);

test("the guard refuses to move off or forget undescribed work, and allows it once described, empty or integrated", async () => {
  const f = await project();
  try {
    const workspace = await createWorkspace("Guarded", f.repo);
    const cwd = workspace.workspacePath;
    const moving = ["jj new main", "jj edit @-", `jj workspace forget ${workspace.current.name}`];

    for (const command of moving) assert.equal(await guard(cwd, command), null, `${command} on an empty change`);

    await writeFile(join(cwd, "a.txt"), "a\n");
    for (const command of moving) assert.match(reason(await guard(cwd, command)), /jj describe/, `${command} on work described only wip:`);
    assert.match(reason(await guard(f.repo, `jj -R ${cwd} new main`)), /jj describe/, "-R is judged by the repository it targets");
    for (const command of ["jj new --no-edit main", "jj status", "jj describe -m 'Add a'", "slipjay land"]) {
      assert.equal(await guard(cwd, command), null, command);
    }

    // Forgetting another workspace holding undescribed work is refused; forgetting an empty current workspace is allowed.
    const other = await createWorkspace("Other", f.repo);
    assert.match(reason(await guard(other.workspacePath, `jj workspace forget ${workspace.current.name}`)), /jj describe/);
    assert.equal(await guard(other.workspacePath, `jj workspace forget ${other.current.name}`), null, "the empty current workspace may be forgotten");

    // Trailer-only and empty descriptions count as undescribed.
    jj(cwd, ["--config", 'templates.commit_trailers=\'""\'', "describe", "-m", "Issue: #57"]);
    assert.equal(description(cwd), "Issue: #57");
    assert.match(reason(await guard(cwd, "jj new main")), /no description/);

    jj(cwd, ["describe", "-m", ""]);
    assert.match(reason(await guard(cwd, "jj new main")), /no description/);

    jj(cwd, ["describe", "-m", "Add a"]);
    for (const command of moving) assert.equal(await guard(cwd, command), null, `${command} once described`);
    assert.equal(await guard(other.workspacePath, `jj workspace forget ${workspace.current.name}`), null);

    // Work reachable from the integration branch is not orphaned even without a description.
    jj(cwd, ["describe", "-m", ""]);
    assert.match(reason(await guard(cwd, "jj new main")), /no description/);
    jj(cwd, ["bookmark", "set", "main", "-r", "@", "--allow-backwards"]);
    assert.equal(await guard(cwd, "jj new main"), null, "work reachable from the integration branch is not orphaned");

    // The primary checkout's own changes are its owner's business, and an ungoverned directory is untouched.
    await writeFile(join(f.repo, "primary.txt"), "p\n");
    assert.equal(await guard(f.repo, "jj new main"), null);
    assert.equal(await guard(f.root, "jj new main"), null);
  } finally {
    await f.dispose();
  }
}, 120_000);
