import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "vite-plus/test";
import { retainSubmissionSource, importSubmissionSource, readSubmissionManifest } from "../src/lib/submission-source.ts";
import { localExecutor } from "../src/lib/runner-queue.ts";
import { candidateBookmark } from "../src/lib/runner-contract.ts";
import { jj, project } from "./support/workspace-project.ts";

async function sourceFixture() {
  const f = await project();
  await writeFile(join(f.repo, "retained.txt"), "source without its author\n");
  jj(f.repo, ["describe", "-m", "Retained candidate"]);
  const commitId = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
  const changeId = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "change_id"]);
  const bookmark = candidateBookmark(changeId);
  execFileSync("git", ["--git-dir", jj(f.repo, ["git", "root"]), "push", f.remote, `${commitId}:refs/heads/${bookmark}`], { stdio: "pipe" });
  const home = join(f.root, "runner"); await mkdir(home);
  const request = { repo: "owner/repo", changeId, commitId, bookmark, submittedBy: "fixture", requestId: randomUUID() };
  return { ...f, home, request };
}

test("retained source survives author loss, upstream deletion/GC and a fresh consumer", async () => {
  const f = await sourceFixture();
  try {
    const operationId = "retained-source";
    const request = { ...f.request, handoff: { version: 1 as const, source: f.request.commitId, intent: "Repair without author chat",
      scope: ["retained.txt"], spec: null, helpers: [], checks: [], reviews: [], toolchain: [], gaps: ["APP_SECRET=do-not-retain"] } };
    const input = { home: f.home, operationId, request, url: f.remote, executor: localExecutor() };
    const retained = await retainSubmissionSource(input);
    assert.equal(retained.handoffComplete, false);
    assert.deepEqual(await retainSubmissionSource(input), retained);
    const consumer = join(f.root, "fresh-consumer");
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "-d", `refs/heads/${f.request.bookmark}`]);
    execFileSync("git", ["--git-dir", f.remote, "gc", "--prune=now"]);
    await rm(f.repo, { recursive: true, force: true });
    jj(f.root, ["git", "clone", f.remote, consumer]);
    assert.equal(jj(consumer, ["log", "-r", `present(${f.request.commitId})`, "--no-graph", "-T", "commit_id"]), "");
    await importSubmissionSource(f.home, f.request.repo, operationId, retained, consumer);
    assert.equal(jj(consumer, ["file", "show", "-r", f.request.commitId, "retained.txt"]), "source without its author");
    await assert.rejects(importSubmissionSource(f.home, f.request.repo, operationId, { ...retained, manifestSha256: "0".repeat(64) }, consumer), /manifest/);
    await assert.rejects(retainSubmissionSource({ ...input, request: { ...f.request, commitId: "f".repeat(40) } }), /identity changed/);
    // Its persisted manifest contains explicit evidence gaps and no transport URL/credentials.
    const file = (await readdir(join(f.home, "submissions")))[0]!;
    const manifest = JSON.parse(await readFile(join(f.home, "submissions", file), "utf8")) as { gaps: string[]; source: string };
    assert.equal(manifest.source, f.request.commitId);
    assert.equal(manifest.gaps.length, 1);
    const stored = JSON.stringify(manifest);
    assert.equal(stored.includes("Repair without author chat"), true);
    assert.equal(stored.includes("do-not-retain"), false);
    assert.equal(stored.includes("author-reported"), true);
    assert.deepEqual(await readSubmissionManifest(f.home, f.request.repo, operationId, retained), manifest);
    await assert.rejects(readSubmissionManifest(f.home, "wrong/repo", operationId, retained), /manifest/);
    await writeFile(join(f.home, "submissions", file), "{}");
    await assert.rejects(readSubmissionManifest(f.home, f.request.repo, operationId, retained), /manifest/);
  } finally { await f.dispose(); }
}, 120_000);

test("retention rejects a moved candidate before recording a manifest", async () => {
  const f = await sourceFixture();
  try {
    await assert.rejects(retainSubmissionSource({ home: f.home, operationId: "wrong-source", request: { ...f.request, commitId: "f".repeat(40) }, url: f.remote, executor: localExecutor() }), /differs/);
    assert.deepEqual(await readdir(join(f.home, "submissions")), []);
  } finally { await f.dispose(); }
}, 120_000);
