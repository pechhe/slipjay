import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { jj } from "../support/workspace-project.ts";
import { fixture, released, waitFor } from "./fixtures/runner-client-fixture.ts";

test("a landing's stages end with this machine's housekeeping once the runner reports its verdict", async () => {
  const f = await fixture(false, true);
  try {
    const stages: string[] = [];
    const running = landThroughRunner(f.cwd, { ...f.options, onStage: (stage) => stages.push(stage) });
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    f.append(f.log.openOperations()[0]!.id, { type: "cancelled", reason: "fixture done" });
    await running;
    assert.equal(stages.at(-1), "housekeeping", stages.join());
  } finally { await f.dispose(); }
}, 60_000);

test("a published landing finishes housekeeping and releases the author workspace", async () => {
  const f = await fixture();
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "refs/heads/main", op.commitId]);
    f.append(op.id, { type: "landed", base: "fixture-base", commitId: op.commitId, branch: "main", remote: "origin" });
    const result = await running;
    assert.equal(result.ok, true);
    assert.equal(jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]), op.commitId);
    await released(f.cwd);
  } finally { await f.dispose(); }
});

test("a published landing the local repo cannot see yet is still reported as landed, with the local failure as a warning", async () => {
  const f = await fixture();
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    // The runner published a commit this repository never fetches: the local lookup after publication fails.
    const published = "c".repeat(40);
    f.append(op.id, { type: "landed", base: "fixture-base", commitId: published, branch: "main", remote: "origin" });
    const result = await running;
    assert.equal(result.ok, true);
    assert.equal(result.operation.result?.type, "landed");
    const verdict = f.lines.findIndex((line) => line.includes(`landed ${published}`) && line.includes(op.id));
    const warning = f.lines.findIndex((line) => line.startsWith("warning:") && line.includes(published.slice(0, 12)));
    assert.ok(verdict >= 0, "the verdict names the published commit and operation");
    assert.ok(warning > verdict, "the local failure follows the verdict as a warning");
    assert.ok(f.lines.some((line) => line.includes("run slipjay land again")), "the warning names the recovery command");
  } finally { await f.dispose(); }
});

test("a decline from an older runner reports its paths and fails without landing anywhere", async () => {
  const f = await fixture();
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    f.append(op.id, { type: "declined", reason: "migration needs local landing", paths: ["schema/change.sql"] });
    const result = await running;
    assert.equal(result.ok, false);
    assert.ok(f.lines.some((line) => line.includes("migration needs local landing") && line.includes("schema/change.sql")));
    assert.notEqual(jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]), op.commitId);
  } finally { await f.dispose(); }
});


test("a landed stack the runner rebased leaves none of its submitted commits behind", async () => {
  const f = await fixture();
  try {
    jj(f.cwd, ["new"]);
    await writeFile(join(f.cwd, "second.txt"), "second\n");
    jj(f.cwd, ["describe", "-m", "Implement the second commit"]);
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    // Another landing advanced main, so the runner rewrote both commits onto it.
    const git = (...args: string[]) => execFileSync("git", ["--git-dir", f.remote, ...args], { encoding: "utf8" }).trim();
    const upstream = git("commit-tree", "main^{tree}", "-p", "main", "-m", "Land upstream");
    const lower = git("commit-tree", `${f.commit}^{tree}`, "-p", upstream, "-m", "Implement candidate (rewritten)");
    const upper = git("commit-tree", `${op.commitId}^{tree}`, "-p", lower, "-m", "Implement the second commit (rewritten)");
    git("update-ref", "refs/heads/main", upper);
    f.append(op.id, { type: "landed", base: upstream, commitId: upper, branch: "main", remote: "origin" });
    const result = await running;
    assert.equal(result.ok, true, f.lines.join("\n"));
    // Nothing undelivered remained, so housekeeping released the workspace.
    await released(f.cwd);
    assert.equal(jj(f.repo, ["log", "-r", `(${f.commit} | ${op.commitId}) & ::visible_heads()`, "--no-graph", "-T", 'commit_id ++ "\\n"']), "");
  } finally { await f.dispose(); }
});

test("a landing finishes housekeeping even when abandoning the rewritten submitted commit fails", async () => {
  const f = await fixture();
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    // The runner rewrote the candidate onto main, so the submitted commit must be abandoned locally.
    const git = (...args: string[]) => execFileSync("git", ["--git-dir", f.remote, ...args], { encoding: "utf8" }).trim();
    const landed = git("commit-tree", `${op.commitId}^{tree}`, "-p", "main", "-m", "Implement candidate (rewritten)");
    git("update-ref", "refs/heads/main", landed);
    // Anything that stops the abandon, as a stale working copy does in the field.
    jj(f.repo, ["config", "set", "--repo", 'revset-aliases."immutable_heads()"', `builtin_immutable_heads() | ${op.commitId}`]);
    f.append(op.id, { type: "landed", base: "fixture-base", commitId: landed, branch: "main", remote: "origin" });
    const result = await running;
    assert.equal(result.ok, true);
    // The working copy moved onto the landed commit, so housekeeping released the workspace.
    await released(f.cwd);
    assert.ok(f.lines.some((line) => line.includes(`jj abandon '::${op.commitId}`)), f.lines.join("\n"));
  } finally { await f.dispose(); }
});
