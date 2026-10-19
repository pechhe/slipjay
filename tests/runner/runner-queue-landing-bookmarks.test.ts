import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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

test("the candidate bookmark is gone from origin before any landing verdict, including after a restart or a queued cancel", async () => {
  const f = await fixture();
  try {
    const landed = f.submit(await f.candidate("landed.txt"));
    assert.equal((await f.land(landed))?.type, "landed");
    const failed = f.submit(await f.candidate("fail"));
    assert.equal((await f.land(failed))?.type, "failed");
    const interrupted = f.submit(await f.candidate("interrupted.txt"));
    f.log.append(interrupted, { type: "stage", stage: "verifying" });
    await f.queue.recover();
    assert.equal(f.result(interrupted)?.type, "failed");
    assert.deepEqual([landed, failed, interrupted].map((id) => f.candidateAtVerdict.get(id)), [false, false, false]);
    const request = await f.candidate("cancelled.txt");
    const cancelled = f.submit(request);
    f.log.append(cancelled, { type: "cancelled", reason: "cancelled by the author" });
    f.queue.cancelled(f.log.operation(cancelled)!);
    await f.queue.idle();
    assert.equal(execFileSync("git", ["--git-dir", f.origin, "for-each-ref", `refs/heads/${request.bookmark}`], { encoding: "utf8" }), "");
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
