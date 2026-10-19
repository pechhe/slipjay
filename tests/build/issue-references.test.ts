import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { commitIssue, githubRepository } from "../../src/lib/build/issue-references.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { jj, project } from "../support/workspace-project.ts";
import { withTestRunner } from "../support/test-runner.ts";

test("GitHub repository identity uses the actual supported remote hostname and normal path", () => {
  for (const remote of [
    "https://github.com/owner/app.git",
    "http://github.com/owner/app",
    "https://fixture-user:fixture-password@github.com/owner/app.git?token=fixture-query#fixture-fragment",
    "https://notgithub.com@github.com/owner/app.git",
    "git@github.com:owner/app.git",
    "github.com:owner/app.git/",
    "ssh://git@github.com/owner/app.git",
    "ssh://git@github.com:443/owner/app.git",
    "git://github.com/owner/app.git",
    "https://GITHUB.COM/owner/app.git/",
  ]) assert.equal(githubRepository(`origin ${remote}`), "owner/app", remote);
});

test("host lookalikes, embedded GitHub text and malformed remote paths cannot supply identity", () => {
  for (const remote of [
    "https://notgithub.com/owner/app.git",
    "https://example.com/github.com/owner/app.git",
    "https://github.com.evil.example/owner/app.git",
    "https://github.com@evil.example/owner/app.git",
    "https://evil.example/?url=https://github.com/owner/app.git",
    "https://evil.example/#https://github.com/owner/app.git",
    "git@notgithub.com:owner/app.git",
    "git@github.com.evil.example:owner/app.git",
    "git@evil.example:github.com/owner/app.git",
    "/local/github.com/owner/app.git",
    "file:///local/github.com/owner/app.git",
    "ftp://github.com/owner/app.git",
    "https://github.com/owner/app/extra.git",
    "https://github.com/owner%2Fother/app.git",
    "https://github.com/owner/app%2Fextra.git",
    "https://github.com/owner/.git",
    "git@github.com:owner/..",
    "git@github.com:owner/app.git?token=fixture",
    "https://github.com/owner",
    "https://github.com:invalid/owner/app.git",
  ]) assert.equal(githubRepository(`origin ${remote}`), null, remote);
});

test("preferred valid GitHub remotes and the established fallback retain their selection semantics", () => {
  const remotes = "local /local/app.git\norigin https://github.com/first/app.git\npublish git@github.com:second/app.git";
  assert.equal(githubRepository(remotes, "publish"), "second/app");
  assert.equal(githubRepository(remotes, "missing"), "first/app");
  assert.equal(githubRepository(remotes, "local"), "first/app");
  assert.equal(githubRepository(remotes), "first/app");
  assert.equal(githubRepository("origin https://notgithub.com/false/app.git\npublish git@github.com:second/app.git", "origin"), "second/app");
  assert.equal(githubRepository(""), null);
});

test("a real runner clones, fetches and pushes locally while JJ exposes the configured GitHub identity", async () => {
  const f = await project();
  const previousGit = jj(f.repo, ["config", "get", "git.executable-path"]);
  try {
    const workspace = (await createWorkspace("GitHub transport fixture", f.repo)).workspacePath;
    await writeFile(join(workspace, "local-transport"), "local");
    jj(workspace, ["describe", "-m", "Exercise local transport"]);
    await withTestRunner(f, async ({ location, env }) => {
      const remotes = jj(workspace, ["git", "remote", "list"]);
      assert.match(remotes, /^origin https:\/\/github\.com\/fixture\/project\.git$/m);
      assert.equal(githubRepository(remotes, "origin"), "fixture/project");
      const result = await landThroughRunner(workspace, { location, env, onLine: () => {} });
      assert.equal(result.ok, true);
      const commands = (await readFile(join(f.root, "git-transport.jsonl"), "utf8")).trim().split("\n")
        .map(line => JSON.parse(line) as string[]);
      const checkout = join(f.root, "runner", "repos", "fixture", "project");
      assert.ok(existsSync(join(checkout, ".jj")), "the runner cloned its own checkout");
      assert.match(jj(checkout, ["git", "remote", "list"]), /^origin https:\/\/github\.com\/fixture\/project\.git$/m);
      assert.ok(commands.some(args => args.includes("fetch")), "source and runner fetched through the transport wrapper");
      assert.ok(commands.some(args => args.includes("push")), "publication pushed through the transport wrapper");
    });
    assert.equal(f.remoteFile("local-transport"), "local");
    assert.equal(jj(f.repo, ["config", "get", "git.executable-path"]), previousGit);
    assert.equal(githubRepository(jj(f.repo, ["git", "remote", "list"]), "origin"), null);
  } finally { await f.dispose(); }
}, 60000);

test("a commit's Issue comes from its trailer for this repository, else a closing reference or (#N)", () => {
  assert.equal(commitIssue("Add a thing\n\nIssue: owner/app#12", "owner/app"), 12);
  assert.equal(commitIssue("Add a thing\n\nIssue: #13", "owner/app"), 13);
  assert.equal(commitIssue("Add a thing (#14)\n\nIssue: other/repo#99", "owner/app"), 14);
  assert.equal(commitIssue("Fix it\n\nCloses #15", "owner/app"), 15);
  assert.equal(commitIssue("Tidy up", "owner/app"), null);
});
