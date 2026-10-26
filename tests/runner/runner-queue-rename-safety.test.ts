import assert from "node:assert/strict";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { retainSubmissionSource } from "../../src/lib/landing/submission-source.ts";
import { probeSubmission } from "../../src/lib/landing/submission-probe.ts";
import { RUNNER_JJ_DEFAULTS } from "../../src/lib/runner/runner-contract.ts";
import { exactPrefixGate, fixture, jj, test, until } from "./fixtures/runner-queue-fixture.ts";

for (const mode of ["normal", "retained", "prefix"] as const) {
  for (const edited of [true, false]) test(`${mode} queue ${edited ? "refuses a rename over integration edits" : "lands a plain rename"}`, async () => {
    const f = await fixture(false, false, undefined, false, { verificationDepth: mode === "prefix" ? 2 : 1 });
    try {
      const original = "export const plumbing = 'original';\n";
      const base = await f.seedMain({ "old.ts": original });
      jj(f.author, ["git", "fetch", "--remote", "origin"]);
      jj(f.author, ["new", base, "-m", "Move plumbing"]);
      await rename(join(f.author, "old.ts"), join(f.author, "new.ts"));
      const request = await f.push();
      jj(f.author, ["new", base, "-m", "YS-407: preserve integration plumbing"]);
      await writeFile(join(f.author, edited ? "old.ts" : "other.ts"), "export const plumbing = 'integration';\n");
      const earlier = f.submit(await f.push());
      const landed = await f.land(earlier);
      assert.ok(landed?.type === "landed", JSON.stringify(landed));
      if (mode === "normal") {
        const probe = await probeSubmission({ home: f.home, url: f.origin, jjConfig: RUNNER_JJ_DEFAULTS, request, ahead: [] });
        assert.deepEqual(probe, edited ? { paths: ["old.ts"], conflictsWith: null } : null);
      }
      const id = f.submit(request);
      if (mode === "retained") f.log.append(id, await retainSubmissionSource({ home: f.home, operationId: id, request, url: f.origin, executor: f.executor }));
      const result = await f.land(id);
      if (edited) {
        assert.ok(result?.type === "failed", JSON.stringify(result));
        assert.match(result.reason, /Landing rename conflict/);
        for (const detail of ["old.ts", "new.ts", landed.commitId, "YS-407: preserve integration plumbing"])
          assert.ok(result.reason.includes(detail), result.reason);
        const operation = f.log.operation(id);
        assert.ok(operation?.kind === "landing");
        assert.equal(operation.outcome?.classification?.cause, "conflict");
        assert.ok(!f.log.events({ operationId: id }).some((row) => row.event.type === "verification_base"));
        assert.equal(f.main(), landed.commitId);
      } else {
        assert.equal(result?.type, "landed", JSON.stringify(result));
        assert.equal(f.remoteFile("new.ts"), original.trim());
        assert.match(f.remoteFile("other.ts"), /integration/);
      }
    } finally { await f.dispose(); }
  });
}

test("a depth-two dependent refuses renames over its unpublished exact predecessor", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  try {
    const base = await f.seedMain({ "old.ts": "export const plumbing = 'original';\n" });
    jj(f.author, ["git", "fetch", "--remote", "origin"]);
    jj(f.author, ["new", base, "-m", "YS-407: predecessor plumbing"]);
    await writeFile(join(f.author, "old.ts"), "export const plumbing = 'integration';\n");
    await writeFile(join(f.author, "a.txt"), "a\n");
    const first = await f.push();
    jj(f.author, ["new", base, "-m", "Rename after predecessor"]);
    await rename(join(f.author, "old.ts"), join(f.author, "new.ts"));
    const request = await f.push();
    await writeFile(join(f.root, "hold-a"), "");
    const a = f.submit(first), b = f.submit(request);
    const retained = await retainSubmissionSource({ home: f.home, operationId: a, request: first, url: f.origin, executor: f.executor });
    f.log.append(a, retained);
    const probe = await probeSubmission({ home: f.home, url: f.origin, jjConfig: RUNNER_JJ_DEFAULTS, request,
      ahead: [{ operationId: a, changeId: first.changeId, commitId: first.commitId, retained }] });
    assert.deepEqual(probe, { paths: ["old.ts"], conflictsWith: { operationId: a, changeId: first.changeId } });
    f.queue.wake();
    await until(() => f.result(b));
    const result = f.result(b);
    assert.ok(result?.type === "failed", JSON.stringify(result));
    assert.match(result.reason, /Landing rename conflict.*[\s\S]*old\.ts/);
    const prepared = f.log.events({ operationId: a }).map((row) => row.event).find((event) => event.type === "attempt_prepared");
    assert.ok(prepared?.type === "attempt_prepared");
    assert.ok(result.reason.includes(prepared.candidate));
    assert.match(result.reason, /YS-407: predecessor plumbing/);
    assert.equal(f.main(), base, "the predecessor is still unpublished");
    assert.ok(!f.log.events({ operationId: b }).some((row) => row.event.type === "verification_base"));
    await rm(join(f.root, "hold-a"));
    await f.queue.idle();
    assert.equal(f.result(a)?.type, "landed");
  } finally { await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
});
