import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, jj, fixture, until, exactPrefixGate } from "./fixtures/runner-queue-fixture.ts";

for (const outcome of ["failure", "kill", "hold", "remote-move"] as const) test(`depth-two exact prefix invalidates B after predecessor ${outcome} and rebuilds it once on what A left`, async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  try {
    const base = f.main();
    await writeFile(join(f.root, "hold-a"), "");
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(() => f.log.operation(b)?.stage === "waiting-for-predecessor" || f.result(b) || undefined);
    assert.equal(f.result(b), undefined, JSON.stringify(f.result(b)));
    if (outcome === "failure") await writeFile(join(f.root, "fail-a"), "");
    if (outcome === "hold") await writeFile(join(f.root, "reject-push"), "");
    if (outcome === "remote-move") {
      // Another valid writer advanced the remote after the prefix was frozen.
      const commit = execFileSync("git", ["--git-dir", f.origin, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "external move"],
        { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "f@example.com", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "f@example.com" } }).trim();
      execFileSync("git", ["--git-dir", f.origin, "update-ref", "refs/heads/main", commit, base]);
    }
    if (outcome === "kill") assert.equal(f.queue.kill(a).status, "killed");
    // Without A, B's rebuild verifies B alone.
    if (outcome !== "remote-move") await writeFile(join(f.root, "a-gone"), "");
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    assert.equal(f.result(a)?.type, outcome === "kill" ? "cancelled" : outcome === "remote-move" ? "landed" : "failed", JSON.stringify(f.result(a)));
    const prepared = (id: string) => f.log.events({ operationId: id }).map((row) => row.event).filter((event) => event.type === "attempt_prepared");
    assert.ok(f.log.events({ operationId: b }).some((row) => row.event.type === "attempt_invalidated"));
    assert.deepEqual(prepared(b).map((event) => event.attempt), [1, 2], "B's stale evidence is never reused: one fresh attempt");
    if (outcome === "hold") {
      // A held integration is finished first; while it cannot publish, nothing after it does.
      assert.equal(f.result(b)?.type, "failed", JSON.stringify(f.result(b)));
      assert.equal(f.log.snapshot(f.executor.host).held.length, 1);
      assert.equal(f.main(), base);
    } else {
      const landed = f.result(b);
      assert.ok(landed?.type === "landed", JSON.stringify(landed));
      assert.equal(f.main(), landed.commitId);
      assert.equal(landed.base, outcome === "remote-move" ? (f.result(a) as { commitId: string }).commitId : base, "B rebuilt on what A's outcome left");
      assert.equal(prepared(b)[1]!.base, landed.base);
    }
    if (outcome === "remote-move") assert.equal(prepared(a).length, 2, "one immutable automatic rebuild");
    // Every prepared candidate remains retained in the verifier after terminal outcome.
    for (const id of [a, b]) {
      const prepared = f.log.events({ operationId: id }).map((row) => row.event).find((event) => event.type === "attempt_prepared");
      assert.ok(prepared?.type === "attempt_prepared");
      assert.equal(jj(prepared.checkout, ["log", "-r", prepared.candidate, "--no-graph", "-T", "commit_id"]), prepared.candidate);
    }
  } finally { await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);
