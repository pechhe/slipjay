import assert from "node:assert/strict";
import { test as serialTest } from "vite-plus/test";
import { fixture, until } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle, schedule, batchEvents } from "./fixtures/automatic-promotion.ts";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import type { ReleaseAlertPayload } from "../../src/lib/runner/runner-types.ts";
import { batchCheck, localRemote, preemptionWaitMs } from "./fixtures/batch-check-fixture.ts";

serialTest("a confirm stops an in-flight diagnosis without cancelling the red batch or superseding another confirm", async () => {
  let clock = Date.now();
  let heldCommit: string | undefined;
  let probeStarted = false;
  let batchId: string | undefined;
  let probeAborted = false;
  let probeClosed = false;
  const alerts: ReleaseAlertPayload[] = [];
  const remote = localRemote();
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false,
    { process: "development", promotionSchedule: schedule(30), now: () => clock, batchVerification: { machine: "batch" },
      releaseGates: (root) => [batchCheck(root)],
      releaseAlertWebhook: { url: "https://example.test/release", timeoutMs: 1_000 },
      sendReleaseAlert: (_url, payload) => {
        alerts.push(payload);
        return new Promise<void>(() => {}); // A transport that never settles cannot stall the queue.
      },
      batchRemote: { async open(input) {
        const attempt = await remote.open(input);
        if (input.candidate !== heldCommit) return attempt;
        return { ...attempt,
          executor: { ...attempt.executor, async run(request) {
            if (!probeStarted && request.env?.SLIPJAY_RELEASE_SUITES) {
              probeStarted = true;
              if (!request.abortSignal!.aborted)
                await new Promise<void>((resolve) => request.abortSignal!.addEventListener("abort", () => resolve(), { once: true }));
              probeAborted = true;
              request.abortSignal!.throwIfAborted();
            }
            return attempt.executor.run(request);
          } },
          async close() { if (probeStarted) probeClosed = true; },
        };
      } } });
  try {
    await f.land(f.submit(await f.candidate("zero.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    clock = promotedAt + 60_000;
    await f.land(f.submit(await f.candidate("break-a")));
    const older = f.main();
    const second = f.submit(await f.candidate("second.txt"));
    await f.land(second);
    heldCommit = older;
    const head = f.main();
    clock = promotedAt + 31 * 60_000;
    await f.queue.recover();
    f.queue.wake();
    const original = f.log.verifications(REPO, head).find((check) => check.submittedBy.endsWith(":batch"));
    assert.ok(original, "recovery schedules a batch for diagnosis");
    batchId = original.id;
    await until(() => {
      assert.equal(f.log.operation(original.id)?.result, undefined, "the batch has not ended before its diagnosis probe");
      return probeStarted || undefined;
    }, preemptionWaitMs);

    const third = f.submit(await f.candidate("third.txt"));
    f.queue.wake();
    await until(() => f.log.operation(third)?.result?.type === "landed" || undefined, preemptionWaitMs);
    const newest = f.main();
    const fourth = f.submit(await f.candidate("fourth.txt"));
    f.queue.wake();
    await until(() => f.log.operation(fourth)?.result?.type === "landed" || undefined, preemptionWaitMs);
    const latest = f.main();
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "test" });
    const first = await f.queue.requestBatchCheck(REPO, newest);
    const next = await f.queue.requestBatchCheck(REPO, older);
    assert.ok(first?.requested && next?.requested);
    await until(() => f.log.operation(original.id)?.result, preemptionWaitMs);
    assert.equal(probeAborted, true);
    assert.equal(probeClosed, true);
    const [outcome] = batchEvents(f, original.id, "batch_outcome");
    assert.ok(outcome?.outcome === "red");
    assert.equal(outcome.diagnosis, "incomplete");
    assert.equal(outcome.shorterCandidate, null);
    assert.match(outcome.reason!, /diagnosis stopped for the release of/);
    assert.equal(f.log.operation(original.id)?.status, "failed");

    await f.queue.recover();
    const queued = f.log.verifications(REPO).filter((entry) => entry.status === "queued");
    assert.deepEqual(new Set(queued.map((entry) => entry.id)), new Set([first.operation.id, next.operation.id]));
    assert.equal(f.log.verifications(REPO, latest).length, 0, "the scheduled batch waits while confirms are queued");
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "test" });
    await settle(f);
    const sequence = (id: string) => f.log.events({ operationId: id }).find(({ event }) => event.type === "batch_started")!.seq;
    assert.ok(sequence(first.operation.id) < sequence(next.operation.id), "the newer requested commit still checks first");
    const originalAlerts = alerts.filter(({ operationId }) => operationId === original.id);
    assert.equal(originalAlerts.length, 1);
    const alert = originalAlerts[0]!;
    assert.equal(alert.event, "batch_unattributed");
    assert.equal(alert.headCommitId, head);
    assert.deepEqual(alert.suites, ["workbench"]);
    assert.deepEqual(alert.unattributed, outcome.unattributed);
  } finally {
    if (batchId && f.log.operation(batchId)?.status === "running") f.queue.kill(batchId);
    await f.dispose();
  }
}, 300_000);
