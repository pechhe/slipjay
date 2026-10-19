import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import { test } from "vite-plus/test";
import { landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { candidateBookmark } from "../../src/lib/runner/runner-contract.ts";
import { jj, project } from "../support/workspace-project.ts";
import { fixture, waitFor } from "./fixtures/runner-client-fixture.ts";

test("rerunning after an unfollowed landing reattaches to it and finishes housekeeping without resubmitting", async () => {
  const f = await fixture();
  try {
    const submitted = { type: "submitted" as const, repo: "fixture/project", changeId: f.change, commitId: f.commit, bookmark: candidateBookmark(f.change), submittedBy: "earlier" };
    f.append("op_landed", submitted);
    // The earlier run published the candidate and landed it on main.
    jj(f.cwd, ["git", "push", "--remote", "origin", "--named", `${candidateBookmark(f.change)}=${f.commit}`]);
    jj(f.cwd, ["bookmark", "forget", candidateBookmark(f.change)]);
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "refs/heads/main", f.commit]);
    f.append("op_landed", { type: "landed", base: "fixture-base", commitId: f.commit, branch: "main", remote: "origin" });
    const result = await landThroughRunner(f.cwd, f.options);
    assert.equal(result.ok, true);
    assert.equal(result.operation.id, "op_landed");
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1);
    await assert.rejects(access(f.cwd), { code: "ENOENT" });
  } finally { await f.dispose(); }
});

test("a reland after the change landed, with an empty working copy on an immutable integrated parent, submits nothing", async () => {
  const f = await fixture();
  try {
    const base = jj(f.cwd, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
    const baseChange = jj(f.cwd, ["log", "-r", "@-", "--no-graph", "-T", "change_id"]);
    f.append("op_landed", { type: "submitted", repo: "fixture/project", changeId: f.change, commitId: f.commit, bookmark: candidateBookmark(f.change), submittedBy: "earlier" });
    jj(f.cwd, ["git", "push", "--remote", "origin", "--named", `${candidateBookmark(f.change)}=${f.commit}`]);
    jj(f.cwd, ["bookmark", "forget", "--include-remotes", candidateBookmark(f.change)]);
    // The runner rebased the candidate, so main holds a different commit of the same change.
    const landed = execFileSync("git", ["--git-dir", f.remote, "commit-tree", `${f.commit}^{tree}`, "-p", base, "-m", "Implement candidate (landed)"], { encoding: "utf8" }).trim();
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "refs/heads/main", landed]);
    f.append("op_landed", { type: "landed", base, commitId: landed, branch: "main", remote: "origin" });
    // As after a concurrent fetch hid the candidate: an empty working copy on the old base, now immutable.
    jj(f.cwd, ["abandon", f.commit]);
    jj(f.cwd, ["git", "fetch", "--remote", "origin", "--branch", "main"]);
    assert.equal(jj(f.cwd, ["log", "-r", "@", "--no-graph", "-T", "empty"]), "true");
    assert.equal(jj(f.cwd, ["log", "-r", "@-", "--no-graph", "-T", "immutable"]), "true");
    const result = await landThroughRunner(f.cwd, f.options);
    assert.equal(result.ok, true);
    assert.equal(result.operation.id, "op_landed");
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1);
    assert.throws(() => execFileSync("git", ["--git-dir", f.remote, "rev-parse", "--verify", `refs/heads/${candidateBookmark(baseChange)}`], { stdio: "ignore" }));
    await assert.rejects(access(f.cwd), { code: "ENOENT" });
  } finally { await f.dispose(); }
});

test("an empty working copy on another workspace's landed change submits nothing and reports no landing, even when the local bookmark lags", async () => {
  const f = await fixture();
  try {
    const base = jj(f.cwd, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
    // Another workspace's change landed on main, rebased by the runner into a new commit.
    const other = execFileSync("git", ["--git-dir", f.remote, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "Other change"], { encoding: "utf8" }).trim();
    const submittedOther = execFileSync("git", ["--git-dir", f.remote, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "Other change (submitted)"], { encoding: "utf8" }).trim();
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "refs/heads/main", other]);
    // This workspace's own edit never happened: its working copy is empty on that change.
    jj(f.cwd, ["abandon", f.commit]);
    jj(f.cwd, ["git", "fetch", "--remote", "origin", "--branch", "main"]);
    jj(f.cwd, ["new", other]);
    const otherChange = jj(f.cwd, ["log", "-r", other, "--no-graph", "-T", "change_id"]);
    f.append("op_other", { type: "submitted", repo: "fixture/project", changeId: otherChange, commitId: submittedOther, bookmark: candidateBookmark(otherChange), submittedBy: "elsewhere:other-workspace" });
    f.append("op_other", { type: "landed", base, commitId: other, branch: "main", remote: "origin" });
    // The local main lags its remote, so the landed change does not look integrated here.
    jj(f.cwd, ["bookmark", "set", "main", "-r", base, "--allow-backwards"]);
    await assert.rejects(landThroughRunner(f.cwd, f.options), /Nothing to land/);
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1);
  } finally { await f.dispose(); }
});

test("an older commit's running operation is followed without moving its candidate bookmark", async () => {
  const f = await fixture();
  try {
    f.append("op_older", { type: "submitted", repo: "fixture/project", changeId: f.change, commitId: "0".repeat(40), bookmark: candidateBookmark(f.change), submittedBy: "earlier" });
    f.append("op_older", { type: "stage", stage: "verifying" });
    const running = landThroughRunner(f.cwd, f.options);
    await waitFor(() => f.lines.some((line) => line.includes("verifying")));
    assert.throws(() => execFileSync("git", ["--git-dir", f.remote, "rev-parse", "--verify", `refs/heads/${candidateBookmark(f.change)}`], { stdio: "ignore" }));
    f.append("op_older", { type: "failed", stage: "verifying", reason: "fixture failure" });
    const result = await running;
    assert.equal(result.ok, false);
    assert.equal(result.operation.id, "op_older");
    assert.ok(f.lines.some((line) => line.includes("land again")));
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1);
  } finally { await f.dispose(); }
});
