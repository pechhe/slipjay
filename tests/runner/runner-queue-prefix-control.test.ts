import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { test, fixture, until, exactPrefixGate } from "./fixtures/runner-queue-fixture.ts";

test("depth-two waiting dependent can be killed without waiting for or killing its predecessor", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  try {
    await writeFile(join(f.root, "hold-a"), "");
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(() => f.log.operation(b)?.stage === "waiting-for-predecessor" || f.result(b) || undefined);
    assert.equal(f.result(b), undefined, JSON.stringify(f.result(b)));
    assert.equal(f.queue.kill(b).status, "killed");
    await until(() => f.result(b));
    assert.equal(f.result(b)?.type, "cancelled");
    assert.equal(f.result(a), undefined);
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    assert.equal(f.result(a)?.type, "landed", JSON.stringify(f.result(a)));
  } finally { await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);

test("depth-two paused queue does not rebuild a stale head or admit another operation", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  try {
    const base = f.main();
    await writeFile(join(f.root, "hold-a"), "");
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    const c = f.submit(await f.candidate("c.txt"));
    f.queue.wake();
    await until(() => f.log.operation(b)?.stage === "waiting-for-predecessor" || f.result(b) || undefined);
    assert.equal(f.result(b), undefined, JSON.stringify(f.result(b)));
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "fixture-owner" });
    const moved = execFileSync("git", ["--git-dir", f.origin, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "external move"],
      { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "f@example.com", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "f@example.com" } }).trim();
    execFileSync("git", ["--git-dir", f.origin, "update-ref", "refs/heads/main", moved, base]);
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    assert.equal(f.result(a)?.type, "failed", JSON.stringify(f.result(a)));
    assert.equal(f.result(b)?.type, "failed");
    assert.equal(f.log.operation(c)?.status, "queued");
    assert.equal(f.log.events({ operationId: a }).filter((row) => row.event.type === "attempt_prepared").length, 1);
    assert.ok(f.log.paused());
    assert.equal(f.main(), moved);
  } finally { await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);
