import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "vite-plus/test";
import { landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { candidateBookmark } from "../../src/lib/runner/runner-contract.ts";
import { jj } from "../support/workspace-project.ts";
import { fixture, released, waitFor } from "./fixtures/runner-client-fixture.ts";

/** An earlier landing's candidate under the author's commit, immutable as a full fetch imports its remote bookmark untracked. */
function earlierCandidate(f: Awaited<ReturnType<typeof fixture>>, alsoOn?: { bookmark?: string; tag?: string }) {
  jj(f.cwd, ["new", "--insert-before", "@", "--no-edit", "-m", "Earlier candidate"]);
  const earlier = jj(f.cwd, ["log", "-r", "@-", "--no-graph", "-T", 'commit_id ++ " " ++ change_id']).split(" ");
  const bookmark = candidateBookmark(earlier[1]!);
  jj(f.cwd, ["git", "push", "--remote", "origin", "--named", `${bookmark}=${earlier[0]}`]);
  if (alsoOn?.bookmark) jj(f.cwd, ["git", "push", "--remote", "origin", "--named", `${alsoOn.bookmark}=${earlier[0]}`]);
  jj(f.cwd, ["bookmark", "forget", "--include-remotes", bookmark]);
  if (alsoOn?.bookmark) jj(f.cwd, ["bookmark", "forget", "--include-remotes", alsoOn.bookmark]);
  jj(f.cwd, ["git", "fetch", "--remote", "origin"]);
  if (alsoOn?.tag) jj(f.cwd, ["tag", "set", alsoOn.tag, "-r", earlier[0]!]);
  assert.equal(jj(f.cwd, ["log", "-r", earlier[0]!, "--no-graph", "-T", "immutable"]), "true");
  return earlier[0]!;
}

async function landOverEarlierCandidate(f: Awaited<ReturnType<typeof fixture>>, alsoOn?: { bookmark?: string; tag?: string }) {
  const earlier = earlierCandidate(f, alsoOn);
  const commit = jj(f.cwd, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
  const running = landThroughRunner(f.cwd, f.options);
  void running.catch(() => {});
  await waitFor(() => f.lines.some((line) => line.includes("queued")));
  const op = f.log.openOperations()[0]!;
  const base = jj(f.cwd, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]);
  const landed = execFileSync("git", ["--git-dir", f.remote, "commit-tree", `${commit}^{tree}`, "-p", base, "-m", "Implement candidate (landed)"], { encoding: "utf8" }).trim();
  execFileSync("git", ["--git-dir", f.remote, "update-ref", "refs/heads/main", landed]);
  f.append(op.id, { type: "landed", base, commitId: landed, branch: "main", remote: "origin" });
  const result = await running;
  assert.equal(result.ok, true);
  return { earlier, commit };
}

test("an earlier candidate made immutable by SlipJay's own remote bookmark is abandoned with the landed stack", async () => {
  const f = await fixture();
  try {
    const { earlier, commit } = await landOverEarlierCandidate(f);
    assert.ok(!f.lines.some((line) => line.includes("Could not abandon")), f.lines.join("\n"));
    assert.equal(jj(f.repo, ["log", "-r", `(${earlier} | ${commit}) & ::${f.workspaceName}@`, "--no-graph", "-T", "commit_id"]), "");
    assert.equal(jj(f.repo, ["log", "-r", "divergent()", "--no-graph", "-T", 'change_id ++ "\\n"']), "");
    await released(f.cwd);
  } finally { await f.dispose(); }
});

test("an earlier candidate that a tag also holds is not abandoned", async () => {
  const f = await fixture();
  try {
    const { earlier } = await landOverEarlierCandidate(f, { tag: "keep-me" });
    assert.ok(f.lines.some((line) => line.includes("Could not abandon")), f.lines.join("\n"));
    assert.equal(jj(f.repo, ["log", "-r", earlier, "--no-graph", "-T", "commit_id"]), earlier);
    await released(f.cwd);
  } finally { await f.dispose(); }
});

test("an earlier candidate that another remote bookmark also holds is not abandoned", async () => {
  const f = await fixture();
  try {
    const { earlier } = await landOverEarlierCandidate(f, { bookmark: "someone-else" });
    assert.ok(f.lines.some((line) => line.includes("Could not abandon")), f.lines.join("\n"));
    assert.equal(jj(f.repo, ["log", "-r", earlier, "--no-graph", "-T", "commit_id"]), earlier);
    await released(f.cwd);
  } finally { await f.dispose(); }
});
