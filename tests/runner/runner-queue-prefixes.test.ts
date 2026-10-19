import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { OWNER_KILL_REASON, RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { test, jj, fixture, until, exactPrefixGate, dependentWaitingOnRebuild } from "./fixtures/runner-queue-fixture.ts";

test("depth-two exact prefixes let B finish first but publish exact A then B", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  try {
    await writeFile(join(f.root, "hold-a"), "");
    const base = f.main();
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(async () => f.result(b) ?? await readFile(join(f.root, "b-verified"), "utf8").catch(() => undefined));
    assert.equal(f.result(b), undefined, JSON.stringify(f.result(b)));
    await until(() => f.log.operation(b)?.stage === "waiting-for-predecessor" || undefined);
    assert.equal(f.main(), base, "B does not occupy the canonical publisher while A verifies");
    const prepared = (id: string) => f.log.events({ operationId: id }).map((row) => row.event).find((event) => event.type === "attempt_prepared");
    const pa = prepared(a), pb = prepared(b);
    assert.ok(pa?.type === "attempt_prepared" && pb?.type === "attempt_prepared");
    assert.equal(pa.base, base); assert.equal(pb.base, pa.candidate);
    assert.deepEqual(pb.predecessor, { operationId: a, attempt: 1, candidate: pa.candidate });
    await rm(join(f.root, "hold-a"));
    await f.queue.idle();
    assert.equal(f.result(a)?.type, "landed", JSON.stringify(f.result(a)));
    assert.equal(f.result(b)?.type, "landed", JSON.stringify(f.result(b)));
    assert.equal(f.main(), pb.candidate);
    assert.deepEqual(f.parents(pb.candidate), [pa.candidate]);
    assert.deepEqual(f.published.filter((row) => row.event.type === "landed").map((row) => row.operationId), [a, b]);
    assert.notEqual(pa.checkout, pb.checkout, "verifiers use independent repositories");
    assert.equal(f.remoteFile("a.txt"), "a.txt");
    assert.equal(f.remoteFile("b.txt"), "b.txt");
  } finally { await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);

test("depth-two exact prefix catches a combination failure before B publication", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  try {
    await writeFile(join(f.root, "hold-a"), "");
    await writeFile(join(f.root, "fail-combination"), "");
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(() => f.result(b));
    assert.equal(f.result(b)?.type, "failed", JSON.stringify(f.result(b)));
    assert.match(JSON.stringify(f.result(b)), /A\+B conflict/);
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    const landed = f.result(a);
    assert.ok(landed?.type === "landed");
    assert.equal(f.main(), landed.commitId);
    assert.ok(f.log.events({ operationId: b }).some((row) => row.event.type === "attempt_invalidated"));
  } finally { await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);

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

test("depth-two dependent waiting on its predecessor's rebuild can be killed, and is not rebuilt", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  let unsubscribe = () => {};
  try {
    const waiting = await dependentWaitingOnRebuild(f);
    unsubscribe = waiting.unsubscribe;
    assert.equal(f.queue.kill(waiting.b).status, "killed", "the waiting dependent is still the owner's to stop");
    await until(() => f.result(waiting.b));
    assert.deepEqual(f.result(waiting.b), { type: "cancelled", reason: OWNER_KILL_REASON });
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    assert.equal(f.result(waiting.a)?.type, "landed", JSON.stringify(f.result(waiting.a)));
    assert.equal(f.log.events({ operationId: waiting.b }).filter((row) => row.event.type === "attempt_prepared").length, 1, "a killed dependent never rebuilds");
  } finally { unsubscribe(); await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);

test("depth-two dependent waiting on its predecessor's rebuild does not rebuild once the runner is paused", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  let unsubscribe = () => {};
  try {
    const waiting = await dependentWaitingOnRebuild(f);
    unsubscribe = waiting.unsubscribe;
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "fixture-owner" });
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    assert.equal(f.result(waiting.a)?.type, "landed", JSON.stringify(f.result(waiting.a)));
    const outcome = f.result(waiting.b);
    assert.ok(outcome?.type === "failed" && /predecessor invalidated/.test(outcome.reason), JSON.stringify(outcome));
    assert.equal(f.log.events({ operationId: waiting.b }).filter((row) => row.event.type === "attempt_prepared").length, 1, "a pause stops the rebuild");
  } finally { unsubscribe(); await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);

test("depth-two dependent rebuilt behind a held predecessor lands on it once the hold publishes", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  let unsubscribe = () => {};
  try {
    await writeFile(join(f.root, "hold-a"), "");
    // B's rebuild first verifies on the remote tip, before the held A publishes under it.
    await writeFile(join(f.root, "a-gone"), "");
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    // The outage ends as soon as A is held: B's rebuild then finishes A first, and lands after it.
    unsubscribe = f.log.subscribe((row) => { if (row.operationId === a && row.event.type === "failed") rmSync(join(f.root, "reject-push"), { force: true }); });
    f.queue.wake();
    await until(() => f.log.operation(b)?.stage === "waiting-for-predecessor" || f.result(b) || undefined);
    await writeFile(join(f.root, "reject-push"), "");
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    assert.equal(f.result(a)?.type, "failed", JSON.stringify(f.result(a)));
    const landed = f.result(b);
    assert.ok(landed?.type === "landed", JSON.stringify(landed));
    assert.equal(f.main(), landed.commitId);
    assert.equal(f.remoteFile("a.txt"), "a.txt", "the held predecessor published first");
    assert.deepEqual(f.log.snapshot(f.executor.host).held, []);
  } finally { unsubscribe(); await rm(join(f.root, "hold-a"), { force: true }); await rm(join(f.root, "reject-push"), { force: true }); await f.dispose(); }
}, 120_000);

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

test("depth-two publication refuses an author rewrite after preparation", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  try {
    const base = f.main();
    await writeFile(join(f.root, "hold-a"), "");
    const original = await f.candidate("a.txt");
    const a = f.submit(original);
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(() => f.log.operation(b)?.stage === "waiting-for-predecessor" || f.result(b) || undefined);
    assert.equal(f.result(b), undefined, JSON.stringify(f.result(b)));
    jj(f.author, ["edit", original.commitId]);
    await writeFile(join(f.author, "rewritten.txt"), "changed after preparation\n");
    await f.push();
    await rm(join(f.root, "hold-a")); await f.queue.idle();
    assert.equal(f.result(a)?.type, "failed", JSON.stringify(f.result(a)));
    assert.match(JSON.stringify(f.result(a)), /Submitted source changed/);
    assert.equal(f.result(b)?.type, "failed");
    assert.equal(f.main(), base);
    assert.equal(f.log.events({ operationId: a }).filter((row) => row.event.type === "attempt_prepared").length, 1);
  } finally { await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);
