import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { landThroughRunner, LandingNotSubmitted } from "../../src/lib/runner/runner-client.ts";
import { jj } from "../support/workspace-project.ts";
import { fixture, waitFor } from "./fixtures/runner-client-fixture.ts";

const remoteCandidates = (remote: string) => execFileSync("git", ["--git-dir", remote, "for-each-ref", "refs/heads/slipjay/changes"], { encoding: "utf8" });

/**
 * A candidate refused before queuing is pushed, and the runner holds no operation to clean up after. The author then
 * rewrites the same change (as `jj rebase` does) and lands again: the retry submits exactly the current commit with no
 * bookmark command by hand, however the author's own repository imports the remote in the meantime.
 */
const orderings: [string, (cwd: string) => void, (cwd: string) => void, (cwd: string) => void][] = [
  ["with no fetch", () => {}, () => {}, () => {}],
  ["after a full fetch following the refusal", () => {}, (cwd) => jj(cwd, ["git", "fetch"]), () => {}],
  ["with a full fetch after the rewrite", () => {}, () => {}, (cwd) => jj(cwd, ["git", "fetch"])],
  ["when the repository tracks every remote bookmark", (cwd) => jj(cwd, ["config", "set", "--repo", "remotes.origin.auto-track-bookmarks", "glob:*"]), () => {}, (cwd) => jj(cwd, ["git", "fetch"])],
];

for (const [name, setup, afterRefusal, afterRewrite] of orderings) {
  test(`a candidate refused before queuing and then rebased is submitted on retry ${name}`, async () => {
    const f = await fixture();
    try {
      setup(f.cwd);
      f.refuseNextSubmission();
      await assert.rejects(landThroughRunner(f.cwd, f.options), LandingNotSubmitted);
      assert.equal(remoteCandidates(f.remote), "", "a refused candidate leaves no copy on the remote");
      afterRefusal(f.cwd);
      jj(f.cwd, ["edit", f.change]);
      await writeFile(join(f.cwd, "change.txt"), "candidate, rebased\n");
      jj(f.cwd, ["describe", "-m", "Implement candidate (rebased)"]);
      const rebased = jj(f.cwd, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
      assert.equal(jj(f.cwd, ["log", "-r", "@", "--no-graph", "-T", "change_id"]), f.change);
      assert.notEqual(rebased, f.commit);
      afterRewrite(f.cwd);
      const running = landThroughRunner(f.cwd, f.options);
      void running.catch(() => {});
      await waitFor(() => f.log.openOperations()[0]);
      const op = f.log.openOperations()[0]!;
      assert.equal(op.commitId, rebased, "the retry submits exactly the current source");
      f.append(op.id, { type: "cancelled", reason: "fixture done" });
      await running;
    } finally { await f.dispose(); }
  }, 60_000);
}

test("a refusal does not delete a newer commit of the change that replaced this candidate on the remote", async () => {
  const f = await fixture();
  try {
    // A concurrent landing of the same change pushes its newer commit before this refusal is answered.
    f.refuseNextSubmission(() => {
      const [line] = remoteCandidates(f.remote).trim().split("\n");
      const ref = line!.split(/\s+/)[2]!;
      execFileSync("git", ["--git-dir", f.remote, "update-ref", ref, execFileSync("git", ["--git-dir", f.remote, "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim()]);
    });
    await assert.rejects(landThroughRunner(f.cwd, f.options), LandingNotSubmitted);
    assert.notEqual(remoteCandidates(f.remote), "", "the other landing's candidate stays");
  } finally { await f.dispose(); }
}, 60_000);
