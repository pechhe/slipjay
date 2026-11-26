import assert from "node:assert/strict";
import { test, fixture } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle, schedule, batchEvents } from "./fixtures/automatic-promotion.ts";
import type { RemoteVerification } from "../../src/lib/runner/runner-types.ts";
import { batchCheck } from "./fixtures/batch-check-fixture.ts";

test("a batch machine that never becomes ready is infrastructure: checked again a bounded number of times, never routed or promoted", async () => {
  let routed = 0;
  const unavailable: RemoteVerification = { async open() { throw Object.assign(new Error("Remote executor unavailable (boat): slipjay-fixture-repo-batch not reachable"), { machineUnavailable: true }); } };
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "batch" }, releaseGates: (root) => [batchCheck(root)],
      batchRemote: unavailable, recordBatchCheck: async () => { routed++; return { kind: "accepted", value: {} }; } });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const checks = f.log.verifications(REPO);
    assert.equal(checks.length, 3);
    for (const check of checks) {
      assert.equal(check.status, "failed");
      assert.deepEqual(batchEvents(f, check.id, "batch_outcome").map((event) => event.outcome), ["infrastructure"]);
      assert.match((check.result as { reason: string }).reason, /infrastructure, not a regression/);
    }
    assert.equal(routed, 0);
    assert.deepEqual(f.log.releases(REPO), []);
  } finally { await f.dispose(); }
}, 300_000);

test("a batch check killed by a host cgroup memory cap is infrastructure, while a mixed real failure stays red", async () => {
  let clock = Date.now();
  let routed = 0;
  const oomCheck = `process.stderr.write("'bun run test:release:batch' hit the 16G memory cap (YARDSMITH_HEAVY_CHECK_MEMORY_MAX); terminating it and its children\\nFailure cause: hit the 16G memory cap (YARDSMITH_HEAVY_CHECK_MEMORY_MAX)\\n"); process.exit(77);`;
  const realBreak = `if (require("node:fs").existsSync("break-real")) { process.stderr.write("FAIL tests/real.test.ts > real > breaks\\n"); process.exit(1); }`;
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), now: () => clock, batchVerification: { machine: "batch" }, releaseGates: () => [oomCheck, realBreak],
      recordBatchCheck: async () => { routed++; return { kind: "accepted", value: {} }; } });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const checks = f.log.verifications(REPO);
    assert.equal(checks.length, 3);
    for (const check of checks) {
      assert.equal(check.status, "failed");
      assert.deepEqual(batchEvents(f, check.id, "batch_outcome").map((event) => event.outcome), ["infrastructure"]);
      assert.match((check.result as { reason: string }).reason, /infrastructure, not a regression/);
    }
    assert.equal(routed, 0);
    assert.deepEqual(f.log.releases(REPO), []);

    clock += 31 * 60_000;
    await f.land(f.submit(await f.candidate("break-real")));
    await f.queue.recover();
    await settle(f);
    const mixed = f.log.verifications(REPO)[0]!;
    assert.notEqual(mixed.id, checks[0]!.id);
    assert.equal(mixed.status, "failed");
    assert.deepEqual(batchEvents(f, mixed.id, "batch_outcome").map((event) => event.outcome), ["red"]);
  } finally { await f.dispose(); }
}, 300_000);

test("a batch check that changes the source it runs on is not evidence: the head fails and nothing ships", async () => {
  const edits = `require("node:fs").writeFileSync("zero.txt", "edited by the check\\n");`;
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "batch" }, releaseGates: () => [edits],
      recordBatchCheck: async () => ({ kind: "accepted", value: {} }) });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const [check] = f.log.verifications(REPO);
    assert.equal(check!.status, "failed");
    assert.match((check!.result as { reason: string }).reason, /not evidence for it: The release checks changed the source/);
    assert.deepEqual(batchEvents(f, check!.id, "batch_outcome").map((event) => event.outcome), ["infrastructure"]);
    assert.deepEqual(f.log.releases(REPO), []);
  } finally { await f.dispose(); }
}, 300_000);
