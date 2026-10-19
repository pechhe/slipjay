import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/slipjay.ts";
import { referencesIssue, withIssueTrailer } from "../../src/lib/build/issue-references.ts";
import { metadataHome } from "../../src/lib/workspace/workspace-paths.ts";
import { jj, landThroughTestRunner, project } from "../support/workspace-project.ts";

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

test("an Isolated landing records its Issue as a trailer on the pushed commit", async () => {
  const f = await project();
  const workspace = await createWorkspace("Trailer", f.repo, { issueNumber: 96601 });
  try {
    await writeFile(join(workspace.workspacePath, "a.txt"), "a\n");
    jj(workspace.workspacePath, ["describe", "-m", "Add a"]);
    assert.equal((await landThroughTestRunner(f, workspace.workspacePath)).ok, true);
    assert.equal(remoteMessage(f.remote), "Add a\n\nIssue: fixture/project#96601");
  } finally {
    await rm(workspace.workspacePath, { recursive: true, force: true });
    await f.dispose();
  }
}, 120_000);

test("an Isolated landing that already references its Issue is not changed", async () => {
  const f = await project();
  const workspace = await createWorkspace("Referenced", f.repo, { issueNumber: 96602 });
  try {
    await writeFile(join(workspace.workspacePath, "a.txt"), "a\n");
    jj(workspace.workspacePath, ["describe", "-m", "Add a (#96602)"]);
    assert.equal((await landThroughTestRunner(f, workspace.workspacePath)).ok, true);
    assert.equal(remoteMessage(f.remote), "Add a (#96602)");
  } finally {
    await rm(workspace.workspacePath, { recursive: true, force: true });
    await f.dispose();
  }
}, 120_000);

test("a landing without an Issue adds no trailer", async () => {
  const f = await project();
  const workspace = await createWorkspace("No issue", f.repo);
  try {
    await writeFile(join(workspace.workspacePath, "a.txt"), "a\n");
    jj(workspace.workspacePath, ["describe", "-m", "Add a"]);
    assert.equal((await landThroughTestRunner(f, workspace.workspacePath)).ok, true);
    assert.equal(remoteMessage(f.remote), "Add a");
  } finally {
    await rm(workspace.workspacePath, { recursive: true, force: true });
    await f.dispose();
  }
}, 120_000);

test("a Direct landing records the Issue named by the primary checkout's metadata", async () => {
  const f = await project();
  const directory = metadataHome();
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "default.json"), JSON.stringify({ version: 1, workspaceName: "default", issueNumber: 96603 }));
    await writeFile(join(f.repo, "direct.txt"), "d\n");
    jj(f.repo, ["describe", "-m", "Add direct"]);
    const landed = await landThroughTestRunner(f, f.repo, { direct: true });
    assert.equal(landed.ok, true);
    assert.equal(remoteMessage(f.remote), "Add direct\n\nIssue: fixture/project#96603");
  } finally {
    await rm(join(directory, "default.json"), { force: true });
    await f.dispose();
  }
}, 120_000);
