import assert from "node:assert/strict";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { newOperationId } from "../../src/lib/runner/runner-log.ts";
import { createReceiptDrain } from "../../src/lib/build/build-receipts.ts";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";

test("a Build-bound landing never starts before admission, holds no place in its lane, and once admitted still waits out a pause", async () => {
  const f = await fixture();
  try {
    const binding = { specId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", ticketIds: [], bodyRevision: null, bindGeneration: 1, sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" };
    const bound = newOperationId();
    f.log.append(bound, { type: "submitted", ...await f.candidate("bound.txt"), admission: { binding, specBodyHash: null, helperRevisions: [], repairsOperationId: null, supersedes: null } });
    const other = f.submit(await f.candidate("other.txt"));
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.result(other)?.type, "landed", JSON.stringify(f.result(other)));
    const pending = f.log.operation(bound)!;
    assert.ok(pending.kind === "landing" && pending.admission === "pending" && pending.status === "queued" && pending.runs.length === 0);
    assert.equal(pending.waitingFor, "Build admission");
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    f.log.append(bound, { type: "build_admitted", sequence: 1, sessionId: binding.sessionId, recordedAt: null });
    f.queue.wake(); await f.queue.idle();
    assert.deepEqual([f.log.operation(bound)!.status, f.log.operation(bound)!.stage], ["queued", "paused"]);
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "owner" });
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.result(bound)?.type, "landed", JSON.stringify(f.result(bound)));
  } finally { await f.dispose(); }
}, 120_000);

test("an admitted candidate waits while a newer one of its change awaits admission, and runs once Build refuses that one", async () => {
  const f = await fixture();
  try {
    const binding = { specId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", ticketIds: [], bodyRevision: null, bindGeneration: 1, sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" };
    const record = { binding, specBodyHash: null, helperRevisions: [], repairsOperationId: null, supersedes: null };
    const source = await f.candidate("held.txt");
    const admitted = newOperationId(), newer = newOperationId();
    f.log.append(admitted, { type: "submitted", ...source, admission: record });
    f.log.append(admitted, { type: "build_admitted", sequence: 1, sessionId: binding.sessionId, recordedAt: null });
    f.log.append(newer, { type: "submitted", ...source, admission: { ...record, supersedes: admitted } });
    f.queue.wake(); await f.queue.idle();
    const waiting = f.log.operation(admitted)!;
    assert.ok(waiting.status === "queued" && waiting.runs.length === 0 && waiting.waitingFor === "Build admission of a newer candidate", JSON.stringify(waiting));
    // Build refuses the newer one (a stale bind): the drain records it, and the queue starts the admitted candidate.
    const drain = createReceiptDrain({ log: f.log, route: () => Promise.resolve({ kind: "refused", code: "bind_generation_stale" }), onAdmissionSettled: f.queue.wake });
    drain.wake(); await drain.idle(); drain.close();
    await until(() => f.result(admitted)?.type === "landed" ? true : undefined);
    assert.equal(f.log.operation(newer)!.status, "declined");
  } finally { await f.dispose(); }
}, 120_000);
