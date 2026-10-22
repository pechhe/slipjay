import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { duplicateLandingSource } from "../../src/lib/landing/landing-artifact.ts";
import { jj, project } from "../support/workspace-project.ts";

const commit = (cwd: string, revision: string) => jj(cwd, ["log", "-r", revision, "--no-graph", "-T", "commit_id"]);

test("a stack whose head is one copy of a divergent change is assembled and described without touching the other copy", async () => {
  const f = await project();
  try {
    await writeFile(join(f.repo, "first"), "first\n");
    jj(f.repo, ["describe", "-m", "First"]);
    jj(f.repo, ["new", "@"]);
    await writeFile(join(f.repo, "second"), "second\n");
    jj(f.repo, ["describe", "-m", "Second"]);
    const source = commit(f.repo, "@");
    // A resubmitted change leaves several visible commits of one change in the runner's probe checkout: make the head divergent.
    const before = jj(f.repo, ["op", "log", "--limit", "1", "--no-graph", "-T", "id"]);
    jj(f.repo, ["describe", "-r", source, "-m", "Second, locally"]);
    jj(f.repo, ["--at-operation", before, "describe", "-r", source, "-m", "Second, elsewhere"]);
    const copies = jj(f.repo, ["log", "-r", "divergent()", "--no-graph", "-T", 'commit_id ++ " " ++ description.first_line() ++ "\\n"']).split("\n").filter(Boolean);
    assert.equal(copies.length, 2, "the change is divergent");
    const submitted = copies.map((line) => line.split(" ")).find(([, ...words]) => words.join(" ") === "Second, elsewhere")![0]!;

    const candidate = await duplicateLandingSource(f.repo, submitted, "main");
    assert.equal(jj(f.repo, ["log", "-r", candidate, "--no-graph", "-T", "description"]), "First\n\nSecond, elsewhere");
    assert.equal(jj(f.repo, ["file", "show", "-r", candidate, "second"]), "second");
    assert.equal(commit(f.repo, `${candidate}-`), commit(f.repo, "main"));
    assert.equal(jj(f.repo, ["log", "-r", submitted, "--no-graph", "-T", "description.first_line()"]), "Second, elsewhere", "the submitted commit is not rewritten");
  } finally { await f.dispose(); }
}, 120_000);
