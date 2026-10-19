import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, jj, fixture, until, exactPrefixGate } from "./fixtures/runner-queue-fixture.ts";

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
