import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, jj, fixture } from "./fixtures/runner-queue-fixture.ts";

test("a renamed integration bookmark is fetched and tracked without deleting the old bookmark", async () => {
  const f = await fixture();
  try {
    jj(f.author, ["new", "main"]);
    const policyPath = join(f.author, "slipjay.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    await writeFile(policyPath, JSON.stringify({ ...policy, integrationBranch: "renamed" }));
    jj(f.author, ["describe", "-m", "Rename integration"]);
    const rename = await f.land(f.submit(await f.push()));
    assert.equal(rename?.type, "landed", JSON.stringify(rename));
    const oldTip = f.main();
    jj(f.author, ["git", "fetch", "--remote", "origin", "--branch", "main"]);
    jj(f.author, ["git", "push", "--remote", "origin", "--named", "renamed=main@origin"]);
    const checkout = join(f.home, "repos", "fixture/repo");
    assert.equal(jj(checkout, ["log", "--no-graph", "-r", 'bookmarks("renamed")', "-T", "commit_id"]), "");
    const next = await f.land(f.submit(await f.candidate("after-rename.txt")));
    assert.equal(next?.type, "landed", JSON.stringify(next));
    if (next?.type !== "landed") throw new Error("Expected renamed landing");
    assert.equal(next.branch, "renamed");
    assert.equal(execFileSync("git", ["--git-dir", f.origin, "rev-parse", "renamed"], { encoding: "utf8" }).trim(), next.commitId);
    assert.equal(f.main(), oldTip, "old remote bookmark remains unchanged");
    assert.equal(jj(checkout, ["log", "--no-graph", "-r", "main", "-T", "commit_id"]), oldTip, "old local bookmark remains unchanged");
    assert.equal(jj(checkout, ["log", "--no-graph", "-r", 'tracked_remote_bookmarks(exact:"renamed")', "-T", "commit_id"]), next.commitId);
  } finally { await f.dispose(); }
}, 120_000);

test("a missing renamed integration bookmark names the local and remote failure", async () => {
  const f = await fixture();
  try {
    jj(f.author, ["new", "main"]);
    const policyPath = join(f.author, "slipjay.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    await writeFile(policyPath, JSON.stringify({ ...policy, integrationBranch: "missing" }));
    jj(f.author, ["describe", "-m", "Rename integration"]);
    assert.equal((await f.land(f.submit(await f.push())))?.type, "landed");
    const oldTip = f.main();
    const next = await f.land(f.submit(await f.candidate("after-rename.txt")));
    assert.equal(next?.type, "failed", JSON.stringify(next));
    assert.match(JSON.stringify(next), /integration bookmark 'missing'.*locally.*remote 'origin'/);
    assert.equal(f.main(), oldTip);
  } finally { await f.dispose(); }
}, 120_000);

test("the candidate bookmark is gone from origin before a landing verdict other than landed, including after a restart or a queued cancel, and right after a landed one (SJ-223)", async () => {
  // The only fixture user that reads `candidateAtVerdict` here, so it asks for the observation it asserts.
  const f = await fixture(false, false, undefined, false, { observeCandidateAtVerdict: true });
  try {
    const published = await f.candidate("landed.txt");
    const landed = f.submit(published);
    assert.equal((await f.land(landed))?.type, "landed");
    // A landing is recorded as landed once its push succeeded; deleting its candidate follows the record.
    await f.queue.idle();
    assert.equal(execFileSync("git", ["--git-dir", f.origin, "for-each-ref", `refs/heads/${published.bookmark}`], { encoding: "utf8" }), "");
    const failed = f.submit(await f.candidate("fail"));
    assert.equal((await f.land(failed))?.type, "failed");
    const interrupted = f.submit(await f.candidate("interrupted.txt"));
    f.log.append(interrupted, { type: "stage", stage: "verifying" });
    await f.queue.recover();
    assert.equal(f.result(interrupted)?.type, "failed");
    assert.deepEqual([landed, failed, interrupted].map((id) => f.candidateAtVerdict.get(id)), [true, false, false]);
    const request = await f.candidate("cancelled.txt");
    const cancelled = f.submit(request);
    f.log.append(cancelled, { type: "cancelled", reason: "cancelled by the author" });
    f.queue.cancelled(f.log.operation(cancelled)!);
    await f.queue.idle();
    assert.equal(execFileSync("git", ["--git-dir", f.origin, "for-each-ref", `refs/heads/${request.bookmark}`], { encoding: "utf8" }), "");
  } finally { await f.dispose(); }
}, 120_000);

test("a candidate bookmark a stopped runner left after recording landed is deleted at the next startup (SJ-223)", async () => {
  const f = await fixture();
  try {
    const request = await f.candidate("left.txt");
    const id = f.submit(request);
    assert.equal((await f.land(id))?.type, "landed");
    await f.queue.idle();
    // As if the runner stopped between the landed record and the bookmark's deletion.
    execFileSync("git", ["--git-dir", f.origin, "update-ref", `refs/heads/${request.bookmark}`, request.commitId]);
    await f.queue.recover();
    // The deletion runs beside admission, after recovery: wait for it rather than for a fixed time.
    const left = () => execFileSync("git", ["--git-dir", f.origin, "for-each-ref", `refs/heads/${request.bookmark}`], { encoding: "utf8" });
    for (let tries = 0; left() !== "" && tries < 300; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(left(), "");
  } finally { await f.dispose(); }
}, 120_000);

test("unknown repositories and stale submitted commits fail without publishing", async () => {
  const f = await fixture();
  try {
    const before = f.main();
    const request = await f.candidate("stale.txt");
    const unknown = f.submit({ ...request, repo: "unknown/repo" });
    const stale = f.submit({ ...request, commitId: "f".repeat(40) });
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.result(unknown)?.type, "failed");
    assert.equal(f.result(stale)?.type, "failed");
    for (const id of [unknown, stale]) {
      const result = f.result(id);
      assert.ok(result?.type === "failed");
      assert.match(result.reason, id === unknown ? /not configured/ : /does not resolve to submitted commit/);
    }
    assert.equal(f.main(), before);
  } finally { await f.dispose(); }
}, 120_000);

test("an author's newer candidate pushed to the bookmark after submitting stays on origin when the submitted one ends (SJ-200)", async () => {
  const f = await fixture();
  try {
    const request = await f.candidate("first.txt");
    const id = f.submit(request);
    // The author moves the same change on and pushes it again, before the runner reaches the submitted commit.
    await writeFile(join(f.author, "first.txt"), "newer\n");
    const newer = await f.push();
    assert.equal(newer.bookmark, request.bookmark);
    assert.notEqual(newer.commitId, request.commitId);
    assert.equal((await f.land(id))?.type, "failed");
    // The deletion is leased to the submitted commit, as jj's push leased the position it fetched.
    assert.equal(execFileSync("git", ["--git-dir", f.origin, "rev-parse", `refs/heads/${request.bookmark}`], { encoding: "utf8" }).trim(), newer.commitId);
  } finally { await f.dispose(); }
}, 120_000);

test("a runner checkout cloned again is configured again, and a landing leaves it on the integration branch (SJ-200)", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.land(f.submit(await f.candidate("one.txt"))))?.type, "landed");
    const checkout = join(f.home, "repos", "fixture/repo");
    await rm(checkout, { recursive: true, force: true });
    const second = await f.land(f.submit(await f.candidate("two.txt")));
    assert.equal(second?.type, "landed", JSON.stringify(second));
    assert.match(jj(checkout, ["config", "list", "--repo", "revset-aliases"]), /trunk\(\)/);
    assert.equal(jj(checkout, ["log", "--no-graph", "-r", "@-", "-T", "commit_id"]), f.main());
  } finally { await f.dispose(); }
}, 120_000);
