import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { candidateBookmark } from "../../src/lib/runner/runner-contract.ts";
import { jj } from "../support/workspace-project.ts";
import { fixture, released, waitFor } from "./fixtures/runner-client-fixture.ts";

test("a full fetch while the candidate is queued does not leave the landed commit divergent or the author's commit immutable", async () => {
  const f = await fixture();
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    // Another session fetches every remote bookmark, importing the candidate bookmark while it exists on origin.
    jj(f.repo, ["git", "fetch"]);
    const git = (...args: string[]) => execFileSync("git", ["--git-dir", f.remote, ...args], { encoding: "utf8" }).trim();
    const landed = git("commit-tree", `${op.commitId}^{tree}`, "-p", "main", "-m", "Implement candidate (rewritten)");
    git("update-ref", "refs/heads/main", landed);
    git("update-ref", "-d", `refs/heads/${candidateBookmark(f.change)}`);
    f.append(op.id, { type: "landed", base: "fixture-base", commitId: landed, branch: "main", remote: "origin" });
    const result = await running;
    assert.equal(result.ok, true, f.lines.join("\n"));
    assert.ok(!f.lines.some((line) => line.includes("Could not abandon")), f.lines.join("\n"));
    assert.equal(jj(f.repo, ["log", "-r", "divergent()", "--no-graph", "-T", 'change_id ++ "\\n"']), "");
    assert.equal(jj(f.repo, ["log", "-r", `visible_heads() & ${f.commit}`, "--no-graph", "-T", "commit_id"]), "");
  } finally { await f.dispose(); }
});

test("after a runner rebase conflict, fetching and rebasing keeps the change visible and editable at @", async () => {
  const f = await fixture();
  try {
    // Another landing changes the same file first, so the runner's rebase conflicts.
    const other = join(f.root, "other");
    const git = (args: string[]) => execFileSync("git", ["-C", other, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args]);
    execFileSync("git", ["clone", "-q", f.remote, other]);
    await writeFile(join(other, "change.txt"), "upstream\n");
    git(["add", "change.txt"]);
    git(["commit", "-qm", "Land upstream"]);
    git(["push", "-q", "origin", "main"]);
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    jj(f.repo, ["git", "fetch"]);
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "-d", `refs/heads/${candidateBookmark(f.change)}`]);
    f.append(op.id, { type: "failed", stage: "rebasing", reason: "Rebase produced conflicts; resolve them in this workspace and retry:\nchange.txt" });
    assert.equal((await running).ok, false);
    jj(f.cwd, ["git", "fetch"]);
    jj(f.cwd, ["rebase", "-b", "@", "-d", "main@origin"]);
    await writeFile(join(f.cwd, "change.txt"), "upstream\ncandidate\n");
    jj(f.cwd, ["describe", "-m", "Implement candidate, rebased"]);
    const at = (template: string) => jj(f.cwd, ["log", "-r", "@", "--no-graph", "-T", template]);
    assert.equal(at("change_id"), f.change);
    assert.equal(at("conflict"), "false");
    assert.match(at("description"), /rebased/);
    assert.equal(jj(f.cwd, ["log", "-r", "@-", "--no-graph", "-T", "description.first_line()"]), "Land upstream");
  } finally { await f.dispose(); }
});

test("a failed landing leaves the author's commit editable after a full fetch imported its candidate", async () => {
  const f = await fixture();
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    jj(f.repo, ["git", "fetch"]);
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "-d", `refs/heads/${candidateBookmark(f.change)}`]);
    f.append(op.id, { type: "failed", stage: "verifying", reason: "gate failed" });
    assert.equal((await running).ok, false);
    jj(f.cwd, ["describe", "-m", "Implement candidate, fixed"]);
    assert.match(jj(f.cwd, ["log", "-r", "@", "--no-graph", "-T", "description"]), /fixed/);
  } finally { await f.dispose(); }
});

test("a landed candidate made immutable by a re-imported remote bookmark is still dropped", async () => {
  const f = await fixture();
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    // The runner rebased the candidate, and a fetch elsewhere re-imported its remote bookmark untracked.
    const base = jj(f.cwd, ["log", "-r", `${f.commit}-`, "--no-graph", "-T", "commit_id"]);
    const landed = execFileSync("git", ["--git-dir", f.remote, "commit-tree", `${f.commit}^{tree}`, "-p", base, "-m", "Implement candidate (landed)"], { encoding: "utf8" }).trim();
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "refs/heads/main", landed]);
    jj(f.cwd, ["git", "fetch", "--remote", "origin", "--branch", candidateBookmark(f.change)]);
    assert.equal(jj(f.cwd, ["log", "-r", f.commit, "--no-graph", "-T", "immutable"]), "true");
    f.append(op.id, { type: "landed", base, commitId: landed, branch: "main", remote: "origin" });
    const result = await running;
    assert.equal(result.ok, true);
    await released(f.cwd);
  } finally { await f.dispose(); }
});
