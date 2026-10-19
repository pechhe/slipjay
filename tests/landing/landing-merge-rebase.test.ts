import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { rebaseOntoIntegration } from "../../src/lib/landing/landing-candidate.ts";
import { jj, project } from "../support/workspace-project.ts";

const run = async (cwd: string, args: string[]) => jj(cwd, args);
const commit = (repo: string, revision: string) =>
  jj(repo, ["log", "-r", revision, "--no-graph", "-T", "commit_id"]);
const parents = (repo: string, revision: string) =>
  jj(repo, [
    "log",
    "-r",
    revision,
    "--no-graph",
    "-T",
    'parents.map(|parent| parent.commit_id()).join(" ")',
  ]).split(" ");
const descriptions = (repo: string, revset: string) =>
  jj(repo, ["log", "-r", revset, "--no-graph", "-T", 'description.first_line() ++ "\\n"'])
    .split("\n")
    .filter(Boolean)
    .sort();

test("a merge candidate moves onto the integration tip and keeps its merged-in parent", async () => {
  const f = await project();
  try {
    const initial = commit(f.repo, "main");
    jj(f.repo, ["new", initial, "-m", "Upstream one"]);
    jj(f.repo, ["new", "-m", "Upstream two"]);
    const upstream = commit(f.repo, "@");
    jj(f.repo, ["new", "main", upstream, "-m", "Merge upstream"]);
    jj(f.repo, ["new", "-m", "Fork fix"]);
    const fix = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "change_id"]);
    jj(f.repo, ["new", initial, "-m", "Landed meanwhile"]);
    jj(f.repo, ["bookmark", "set", "main", "-r", "@"]);
    const tip = commit(f.repo, "main");

    await rebaseOntoIntegration(f.repo, fix, "main", run);

    const merge = commit(f.repo, `parents(${fix})`);
    assert.deepEqual(parents(f.repo, merge), [tip, upstream]);
    // Only the fork's line was rewritten: the upstream commits are the same, not copies.
    assert.deepEqual(descriptions(f.repo, `main..${fix}`), [
      "Fork fix",
      "Merge upstream",
      "Upstream one",
      "Upstream two",
    ]);
    assert.equal(commit(f.repo, `description(exact:"Upstream two\\n")`), upstream);
  } finally {
    await f.dispose();
  }
});

test("a plain stack still rebases as a branch", async () => {
  const f = await project();
  try {
    const initial = commit(f.repo, "main");
    jj(f.repo, ["new", initial, "-m", "Change one"]);
    jj(f.repo, ["new", "-m", "Change two"]);
    const top = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "change_id"]);
    jj(f.repo, ["new", initial, "-m", "Landed meanwhile"]);
    jj(f.repo, ["bookmark", "set", "main", "-r", "@"]);

    await rebaseOntoIntegration(f.repo, top, "main", run);

    assert.deepEqual(descriptions(f.repo, `main..${top}`), ["Change one", "Change two"]);
    assert.deepEqual(parents(f.repo, `roots(main..${top})`), [commit(f.repo, "main")]);
  } finally {
    await f.dispose();
  }
});
