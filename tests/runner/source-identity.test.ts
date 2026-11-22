import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identifyRetainedSources, retainSubmissionSource, submissionStorePath, verbatimPatchId } from "../../src/lib/landing/submission-source.ts";
import { directExecutor } from "../support/executor.ts";
import { test, fixture } from "./fixtures/runner-queue-fixture.ts";

test("a retained source's identity is the same for the same files on a moved base, and differs for other files", async () => {
  const f = await fixture();
  try {
    const retain = async (file: string) => {
      const request = await f.candidate(file);
      const id = f.submit(request);
      f.log.append(id, await retainSubmissionSource({ home: f.home, operationId: id, request, url: f.origin, executor: f.executor }));
      return { id, commitId: request.commitId };
    };
    const first = await retain("same.txt");
    assert.equal((await f.land(f.submit(await f.candidate("moves-the-base.txt"))))?.type, "landed");
    const rebased = await retain("same.txt");
    const other = await retain("other.txt");
    assert.notEqual(first.commitId, rebased.commitId);
    assert.equal(await identifyRetainedSources({ home: f.home, log: f.log, executor: f.executor }), 3);
    const digest = (id: string) => f.log.events({ operationId: id }).flatMap(({ event }) => event.type === "source_identity" ? [event.digest] : []);
    assert.deepEqual(digest(first.id), digest(rebased.id));
    assert.equal(digest(first.id).length, 1);
    assert.notDeepEqual(digest(other.id), digest(first.id));
    // Each is recorded once: a second pass finds nothing left to identify.
    assert.equal(await identifyRetainedSources({ home: f.home, log: f.log, executor: f.executor }), 0);
  } finally { await f.dispose(); }
}, 120_000);

test("retention records the verbatim patch-id a reviewer computes, the same for a rebased candidate and another for other files (WV-74)", async () => {
  const f = await fixture();
  try {
    const retain = async (file: string) => {
      const request = await f.candidate(file);
      const id = f.submit(request);
      return { commitId: request.commitId, retained: await retainSubmissionSource({ home: f.home, operationId: id, request, url: f.origin, executor: f.executor }) };
    };
    const first = await retain("same.txt");
    assert.equal((await f.land(f.submit(await f.candidate("moves-the-base.txt"))))?.type, "landed");
    const rebased = await retain("same.txt");
    const other = await retain("other.txt");
    assert.notEqual(first.commitId, rebased.commitId);
    // What a reviewer runs on the revision it judged: `git diff-tree -p <revision> | git patch-id --verbatim`.
    const gitDir = submissionStorePath(f.home, "fixture/repo");
    const diff = execFileSync("git", ["--git-dir", gitDir, "diff-tree", "-p", first.commitId]);
    const reviewer = execFileSync("git", ["--git-dir", gitDir, "patch-id", "--verbatim"], { input: diff }).toString().split(" ")[0];
    assert.match(first.retained.patchId ?? "", /^[0-9a-f]{40}$/);
    assert.equal(first.retained.patchId, reviewer);
    assert.equal(rebased.retained.patchId, first.retained.patchId);
    assert.notEqual(other.retained.patchId, first.retained.patchId);
  } finally { await f.dispose(); }
}, 120_000);

test("a patch-id tells apart changes that differ only in whitespace, so a review of one never counts for the other (WV-74)", async () => {
  const root = mkdtempSync(join(tmpdir(), "patch-id-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(root, "f.ts"), "a\nb\nc\n");
    git("add", "f.ts"); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const commit = (content: string, message: string) => {
      writeFileSync(join(root, "f.ts"), content);
      git("commit", "-qam", message);
      return git("rev-parse", "HEAD");
    };
    const reviewed = commit("a\nb\nc\nconst greeting = \"hello world\";\n", "reviewed");
    git("checkout", "-q", base);
    const squashed = commit("a\nb\nc\nconst greeting = \"helloworld\";\n", "edited after review");
    git("checkout", "-q", base);
    commit("top\na\nb\nc\n", "the base moves");
    const rebased = commit("top\na\nb\nc\nconst greeting = \"hello world\";\n", "reworded and rebased");
    const id = (commitId: string) => verbatimPatchId({ executor: directExecutor("test"), gitExecutable: "git", gitDir: join(root, ".git"), commitId, cwd: root });
    const [first, edited, moved] = await Promise.all([id(reviewed), id(squashed), id(rebased)]);
    assert.match(first ?? "", /^[0-9a-f]{40}$/);
    assert.equal(moved, first, "a rebase and a reworded message keep the patch-id");
    assert.notEqual(edited, first, "whitespace inside a string literal changes behaviour, so it changes the patch-id");
    // An empty diff has none: Build then falls back to the exact commit.
    git("commit", "-q", "--allow-empty", "-m", "empty");
    assert.equal(await id(git("rev-parse", "HEAD")), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
