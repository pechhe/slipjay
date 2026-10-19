import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoredEvent } from "../../src/lib/runner/runner-contract.ts";
import { gate, command, test, jj, fixture } from "./fixtures/runner-queue-fixture.ts";

test("queued candidates land in arrival order on the previous candidate, with runner gate records and streamed logs", async () => {
  const f = await fixture();
  try {
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    assert.equal(f.log.operation(a)!.position, 1);
    assert.equal(f.log.operation(b)!.position, 2);
    assert.equal(await f.queue.readLog("unknown"), null);
    f.queue.wake(); f.queue.wake();
    await f.queue.idle();
    const first = f.result(a);
    const second = f.result(b);
    assert.equal(first?.type, "landed", JSON.stringify(first));
    assert.equal(second?.type, "landed", JSON.stringify(second));
    if (first?.type !== "landed" || second?.type !== "landed") throw new Error("Expected landed candidates");
    assert.equal(second.base, first.commitId);
    assert.equal(f.main(), second.commitId);
    assert.equal(f.remoteFile("a.txt"), "a.txt");
    assert.equal(f.remoteFile("b.txt"), "b.txt");
    assert.deepEqual(f.published.filter((stored) => stored.event.type === "landed").map((stored) => stored.operationId), [a, b]);
    for (const id of [a, b]) {
      const operation = f.log.operation(id)!;
      assert.equal(operation.runs.length, 1);
      assert.equal(operation.runs[0]!.host, f.executor.host);
      assert.equal(operation.runs[0]!.command, command);
      assert.equal(operation.runs[0]!.timeoutMs, f.requestedTimeouts.find((request) => request.command === command)!.timeoutMs);
      assert.equal(operation.runs[0]!.exitCode, 0);
      const evidence = f.log.events({ operationId: id }).map((row) => row.event);
      const shape = evidence.findLast((event) => event.type === "change_shape");
      assert.ok(shape?.type === "change_shape");
      assert.equal(shape.files, 1);
      assert.equal(shape.insertions, 1);
      assert.equal(shape.migrationBearing, false);
      assert.match(shape.fileSet, /^[a-f0-9]{64}$/);
      assert.ok(evidence.some((event) => event.type === "queue_snapshot" && event.depth >= event.position));
      assert.ok(evidence.some((event) => event.type === "verification_base" && event.base === (id === a ? first.base : second.base)));
      assert.ok(evidence.some((event) => event.type === "stage_detail" && event.stage === "verifying" && event.durationMs >= 0));
      assert.equal(operation.runs[0]!.killed, false);
      assert.ok(Number.isFinite(operation.runs[0]!.outputBytes));
      assert.deepEqual(f.log.events({ operationId: id }).filter((stored) => stored.event.type === "stage").map((stored) => stored.event.type === "stage" && stored.event.stage), ["fetching", "rebasing", "installing", "verifying", "integrating", "finalizing", "publishing"]);
      assert.equal(f.queue.logPath(id), join(f.home, "logs", `${id}.log`));
      const lines = (await f.queue.readLog(id))!.trim().split("\n").map((line) => JSON.parse(line) as StoredEvent);
      assert.deepEqual(lines, f.published.filter((stored) => stored.operationId === id));
    }
    assert.equal(execFileSync("git", ["--git-dir", f.origin, "for-each-ref", "refs/heads/slipjay/changes"], { encoding: "utf8" }), "");
    // The runner's jj settings come from its config and defaults, set in the warm checkout, not from the host.
    const repoConfig = jj(join(f.home, "repos", "fixture/repo"), ["config", "list", "--repo"]);
    for (const setting of ['user.name = "Runner Identity"', 'user.email = "runner@example.com"', 'snapshot.max-new-file-size = "64MiB"'])
      assert.ok(repoConfig.includes(setting), repoConfig);
  } finally { await f.dispose(); }
}, 120_000);

for (const verificationDepth of [1, 2] as const) test(`a two-commit landing preserves feature attribution at depth ${verificationDepth}`, async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth });
  try {
    const base = f.main();
    jj(f.author, ["new", "main", "-m", "feat: deliver the feature\n\nFeature body.\n\nIssue: pechhe/slipjay#59"]);
    await writeFile(join(f.author, "feature.txt"), "feature\n");
    jj(f.author, ["new", "@", "-m", "fix: answer review\n\nReview body."]);
    await writeFile(join(f.author, "review.txt"), "review\n");
    const result = await f.land(f.submit(await f.push()));
    assert.equal(result?.type, "landed", JSON.stringify(result));
    const description = execFileSync("git", ["--git-dir", f.origin, "show", "-s", "--format=%B", f.main()], { encoding: "utf8" }).trim();
    if (verificationDepth === 2) {
      assert.equal(description, "feat: deliver the feature\n\nFeature body.\n\nIssue: pechhe/slipjay#59\n\nfix: answer review\n\nReview body.");
      assert.equal(f.parents(f.main())[0], base, "folded artifact extends integration directly");
    } else {
      assert.equal(description, "fix: answer review\n\nReview body.");
      const first = f.parents(f.main())[0]!;
      assert.equal(execFileSync("git", ["--git-dir", f.origin, "show", "-s", "--format=%B", first], { encoding: "utf8" }).trim(),
        "feat: deliver the feature\n\nFeature body.\n\nIssue: pechhe/slipjay#59");
      assert.equal(f.parents(first)[0], base, "serial landing preserves both commits");
    }
    assert.equal(f.remoteFile("feature.txt"), "feature");
    assert.equal(f.remoteFile("review.txt"), "review");
  } finally { await f.dispose(); }
}, 120_000);

test("a candidate on an older base lands without abandoning the integration published since, on a branch jj does not call trunk", async () => {
  const f = await fixture(false, false, undefined, false, { branch: "rollover" });
  try {
    const stale = await f.candidate("stale.txt");
    const first = await f.land(f.submit(await f.candidate("first.txt")));
    const second = await f.land(f.submit(await f.candidate("second.txt")));
    assert.ok(first?.type === "landed" && second?.type === "landed", JSON.stringify([first, second]));
    // `jj git clone` names the remote's default branch trunk(); a fork whose default is another
    // branch (pechhe/t3code integrates on rollover) has no such alias, so jj calls only main trunk.
    const checkout = join(f.home, "repos", "fixture/repo");
    jj(checkout, ["config", "unset", "--repo", 'revset-aliases."trunk()"']);
    // `stale` was made before both: the runner's cleanup must keep them, and land it on top.
    const landed = await f.land(f.submit(stale));
    assert.ok(landed?.type === "landed", JSON.stringify(landed));
    assert.equal(landed.base, second.commitId);
    assert.deepEqual(f.parents(second.commitId), [first.commitId]);
    assert.equal(jj(checkout, ["log", "-r", "rollover", "--no-graph", "-T", "commit_id"]), f.main());
    // A later landing still finds its integration branch.
    assert.equal((await f.land(f.submit(await f.candidate("after.txt"))))?.type, "landed");
  } finally { await f.dispose(); }
}, 120_000);
