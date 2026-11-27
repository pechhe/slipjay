import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { referencesIssue, withIssueTrailer } from "../../src/lib/build/issue-references.ts";
import { metadataHome } from "../../src/lib/workspace/workspace-paths.ts";
import { jj, project } from "../support/workspace-project.ts";
import { landOnTestRunner, withTestRunner } from "../support/test-runner.ts";

const remoteMessage = (remote: string) => execFileSync("git", ["--git-dir", remote, "log", "-1", "--format=%B", "main"], { encoding: "utf8" }).trim();

test("a description is referenced by #N, closing keywords and owner/repo#N, never by another number", () => {
  for (const text of ["Do it (#987)", "Fixes #987", "Closes o/r#987", "See o/r#987"]) assert.equal(referencesIssue(text, 987), true, text);
  for (const text of ["Do it", "Refs #9870", "Fixes #98", "abc#987"]) assert.equal(referencesIssue(text, 987), false, text);
});

test("the trailer is appended once, joins an existing trailer block, and needs an Issue", () => {
  assert.equal(withIssueTrailer("Do it", 987, "o/r"), "Do it\n\nIssue: o/r#987");
  assert.equal(withIssueTrailer("Do it\n\nBody", 987, "o/r"), "Do it\n\nBody\n\nIssue: o/r#987");
  assert.equal(withIssueTrailer("Do it\n\nCo-Authored-By: A <a@b.c>", 987, "o/r"), "Do it\n\nCo-Authored-By: A <a@b.c>\nIssue: o/r#987");
  assert.equal(withIssueTrailer("Do it\n\nFixes #987", 987, "o/r"), "Do it\n\nFixes #987");
  assert.equal(withIssueTrailer("Do it", null, "o/r"), "Do it");
});

test("Isolated and Direct landings record their Issue trailer when missing", async () => {
  const f = await project();
  const directory = metadataHome();
  try {
    await withTestRunner(f, async (runner) => {
      const withIssue = await createWorkspace("Trailer", f.repo, { issueNumber: 96601 });
      try {
        await writeFile(join(withIssue.workspacePath, "a.txt"), "a\n");
        jj(withIssue.workspacePath, ["describe", "-m", "Add a"]);
        assert.equal((await landOnTestRunner(runner, withIssue.workspacePath)).ok, true);
        assert.equal(remoteMessage(f.remote), "Add a\n\nIssue: fixture/project#96601");
      } finally { await rm(withIssue.workspacePath, { recursive: true, force: true }); }

      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "default.json"), JSON.stringify({ version: 1, workspaceName: "default", issueNumber: 96603 }));
      await writeFile(join(f.repo, "direct.txt"), "d\n");
      jj(f.repo, ["describe", "-m", "Add direct"]);
      const landed = await landOnTestRunner(runner, f.repo, { direct: true });
      assert.equal(landed.ok, true);
      assert.equal(remoteMessage(f.remote), "Add direct\n\nIssue: fixture/project#96603");
    });
  } finally {
    await rm(join(directory, "default.json"), { force: true });
    await f.dispose();
  }
}, 120_000);
