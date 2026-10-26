import assert from "node:assert/strict";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, fixture, until, exactPrefixGate, seqOf, jj } from "./fixtures/runner-queue-fixture.ts";

for (const scenario of ["overlap", "rebased-overlap", "migration", "rename-out", "policy", "read-by-gate", "unmarked"] as const) {
  test(`depth-two prepared predecessor barrier: ${scenario}`, async () => {
    const f = await fixture(true, false, undefined, true, {
      verificationDepth: 2, prefixGate: exactPrefixGate,
      postIntegrationReadByGate: scenario === "unmarked" ? undefined : scenario === "read-by-gate",
    });
    try {
      await writeFile(join(f.root, "hold-a"), "");
      // A file integration already has, which the predecessor moves out of the trigger path.
      if (scenario === "rename-out") {
        await f.seedMain({ "schema/old.ts": "schema\n" });
        jj(f.author, ["git", "fetch", "--remote", "origin"]);
      }
      // Every predecessor carries a.txt so the same gate holds it deterministically.
      await f.candidate("a.txt");
      if (scenario === "rename-out") {
        await mkdir(join(f.author, "moved"));
        await rename(join(f.author, "schema/old.ts"), join(f.author, "moved/old.ts"));
      }
      if (scenario === "migration" || scenario === "rebased-overlap") {
        await mkdir(join(f.author, "schema"));
        await writeFile(join(f.author, "schema/a.ts"), "schema\n");
      }
      if (scenario === "policy") {
        const file = join(f.author, "slipjay.json");
        const policy = JSON.parse(await readFile(file, "utf8"));
        policy.projectCode = "fixture";
        await writeFile(file, JSON.stringify(policy));
      }
      const a = f.submit(await f.push());
      // The submitted diff touches a trigger, but integration already has it.
      // Only the rebased candidate's diff can correctly permit overlap here.
      if (scenario === "rebased-overlap") await f.seedMain({ "schema/a.ts": "schema\n" });
      const b = f.submit(await f.candidate("b.txt"));
      f.queue.wake();
      await until(() => f.log.operation(b)?.stage === "waiting-for-predecessor" || f.result(b) || undefined);
      assert.equal(f.result(a), undefined, JSON.stringify(f.result(a)));
      assert.equal(f.result(b), undefined, JSON.stringify(f.result(b)));
      const events = (id: string) => f.log.events({ operationId: id }).map((row) => row.event);
      const prepared = events(a).find((event) => event.type === "attempt_prepared");
      assert.ok(prepared?.type === "attempt_prepared");
      const overlaps = scenario === "overlap" || scenario === "rebased-overlap";
      assert.equal(prepared.overlap, overlaps);
      assert.equal(events(b).some((event) => event.type === "verification_passed"), overlaps);
      assert.equal(events(b).some((event) => event.type === "attempt_prepared"), overlaps);
      await rm(join(f.root, "hold-a"));
      await f.queue.idle();
      assert.equal(f.result(a)?.type, "landed", JSON.stringify(f.result(a)));
      assert.equal(f.result(b)?.type, "landed", JSON.stringify(f.result(b)));
      assert.deepEqual(f.published.filter((row) => row.event.type === "landed").map((row) => row.operationId), [a, b]);
      if (!overlaps) assert.ok(seqOf(f, b, "attempt_prepared") > seqOf(f, a, "landed"));
    } finally { await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
  }, 120_000);
}

test("depth-two queued release still fences successor preparation", async () => {
  const f = await fixture(false, true, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  try {
    assert.equal((await f.land(f.submit(await f.candidate("seed.txt"))))?.type, "landed");
    await writeFile(join(f.root, "hold-a"), "");
    await writeFile(join(f.root, "hold-release"), "");
    const a = f.submit(await f.candidate("a.txt"));
    const release = f.submitRelease(f.main());
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(async () => readFile(join(f.root, "a-started"), "utf8").then(() => true, () => undefined));
    assert.equal(f.log.operation(b)?.status, "queued");
    await rm(join(f.root, "hold-a"));
    await until(async () => f.result(release) ?? readFile(join(f.root, "release-started"), "utf8").then(() => true, () => undefined));
    assert.equal(f.result(release), undefined, JSON.stringify(f.result(release)));
    assert.equal(f.result(a)?.type, "landed", JSON.stringify(f.result(a)));
    assert.equal(f.log.operation(b)?.status, "queued");
    assert.ok(!f.log.events({ operationId: b }).some((row) => row.event.type === "attempt_started"));
    await rm(join(f.root, "hold-release"));
    await f.queue.idle();
    assert.equal(f.result(release)?.type, "released", JSON.stringify(f.result(release)));
    assert.equal(f.result(b)?.type, "landed", JSON.stringify(f.result(b)));
    assert.ok(seqOf(f, b, "attempt_started") > seqOf(f, release, "released"));
  } finally {
    await rm(join(f.root, "hold-a"), { force: true });
    await rm(join(f.root, "hold-release"), { force: true });
    await f.dispose();
  }
}, 120_000);
