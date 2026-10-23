import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuildAdmissionRecord, BuildAdmissionRequest, BuildRoute } from "../../src/lib/build/build-admission.ts";
import { createReceiptDrain } from "../../src/lib/build/build-receipts.ts";
import type { BuildReceiptInput } from "../../src/lib/build/build-receipts.ts";
import type { OperationLog, SubmitRequest } from "../../src/lib/runner/runner-types.ts";
import { test, jj, fixture } from "./fixtures/runner-queue-fixture.ts";

const earlierSpec = "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e", laterSpec = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const admission = (specId: string): BuildAdmissionRecord => ({
  binding: { specId, ticketIds: [], bodyRevision: 1, bindGeneration: 1, sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" },
  specBodyHash: "f".repeat(64), helperRevisions: [], repairsOperationId: null, supersedes: null });

/**
 * Build's custody rules, as its attempt ledger applies them: an attempt is pending while submitted or held, or while its
 * latest failure left publication unknown; after an unknown publication only a confirmation or a settled failure may
 * follow; an ended attempt takes no second end; and a Spec with a pending attempt admits no other (`delivery_pending`).
 */
function custodialBuild() {
  const attempts = new Map<string, { specId: string; facts: BuildReceiptInput[] }>();
  const unknown = (fact: BuildReceiptInput) => fact.event === "failed" && fact.failure?.recovery === "publication_unknown";
  const ended = (fact: BuildReceiptInput) => fact.event === "published" || fact.event === "failed" && !unknown(fact);
  const pending = (facts: BuildReceiptInput[]) => { const latest = facts.at(-1); return !latest || latest.event === "held" || unknown(latest); };
  const refused = (code: string) => Promise.resolve({ kind: "refused" as const, code });
  const route: BuildRoute = (action, input) => {
    if (action === "read") return Promise.resolve({ kind: "accepted", value: { id: (input as { itemId: string }).itemId, number: 1, kind: "spec" } });
    if (action === "admitAttempt") {
      const request = input as BuildAdmissionRequest;
      if ([...attempts.values()].some((attempt) => attempt.specId === request.specId && pending(attempt.facts))) return refused("delivery_pending");
      attempts.set(request.operationId, { specId: request.specId, facts: [] });
      return Promise.resolve({ kind: "accepted", value: { admission: { recordedAt: null } } });
    }
    if (action !== "recordAttempt") return Promise.resolve({ kind: "accepted", value: null });
    const fact = input as BuildReceiptInput;
    const attempt = attempts.get(fact.operationId)!;
    if (attempt.facts.some(ended) && ended(fact)) return refused("attempt_already_ended");
    if (attempt.facts.some(unknown) && fact.event !== "published" && !ended(fact)) return refused("attempt_reconciliation_required");
    attempt.facts.push(fact);
    return Promise.resolve({ kind: "accepted", value: null });
  };
  return { route, attempts };
}

const bound = (request: SubmitRequest, specId: string) => ({ ...request, admission: admission(specId) });
async function drained(log: OperationLog, route: BuildRoute) {
  const drain = createReceiptDrain({ log, route });
  drain.wake(); await drain.idle(); drain.close();
}
const recoveries = (log: OperationLog, id: string) => log.events({ operationId: id }).flatMap((row) => row.event.type === "build_receipt" ? [row.event] : []);

test("a landing that fails finishing an earlier landing's hold ends in Build, so its Spec lands again; the release settles the earlier one", async () => {
  const f = await fixture(true);
  try {
    const build = custodialBuild();
    // The earlier landing integrates its migration, then fails finalizing it: the runner holds that integration.
    await writeFile(join(f.root, "fail-finalize"), "");
    const earlier = f.submit(bound(await f.candidate("schema/held.ts"), earlierSpec));
    await drained(f.log, build.route);
    assert.equal((await f.land(earlier))?.type, "failed");
    const [hold] = f.log.snapshot(f.executor.host).held;
    assert.ok(hold);
    // The next turn retries that hold first, fails the same way and never integrates its own candidate.
    const later = f.submit(bound(await f.candidate("later.txt"), laterSpec));
    await drained(f.log, build.route);
    const failure = await f.land(later);
    assert.equal(failure?.type === "failed" && failure.stage, "finalizing", JSON.stringify(failure));
    await drained(f.log, build.route);
    const [laterFailure] = build.attempts.get(later)!.facts.filter((fact) => fact.event === "failed");
    assert.equal(laterFailure?.failure?.recovery, "infrastructure_retry");
    // The earlier landing's own integration may have published: Build keeps it.
    assert.equal(build.attempts.get(earlier)!.facts.at(-1)?.failure?.recovery, "publication_unknown");

    // The same Spec lands again: Build admits it, since nothing of its own is in doubt.
    const again = f.submit(bound(await f.candidate("later-again.txt"), laterSpec));
    await drained(f.log, build.route);
    assert.ok(f.log.events({ operationId: again }).some((row) => row.event.type === "build_admitted"), JSON.stringify(f.log.operation(again)?.result));
    f.log.append(again, { type: "cancelled", reason: "the hold is cleared first" });

    // The README's manual fix discards the held integration; the recovery turn releases it.
    await rm(join(f.root, "fail-finalize"));
    const checkout = join(f.home, "repos", "fixture/repo");
    jj(checkout, ["bookmark", "set", "main", "-r", "main@origin", "--allow-backwards"]);
    jj(checkout, ["abandon", hold.commitId]);
    await f.queue.recover();
    await f.queue.idle();
    assert.deepEqual(f.log.snapshot(f.executor.host).held, []);
    await drained(f.log, build.route);
    // The earlier attempt ends with how it recovers, so its Spec is admitted again with no step in Build.
    const settled = build.attempts.get(earlier)!.facts.at(-1)!;
    assert.deepEqual([settled.event, settled.failure?.recovery], ["failed", "code_repair"]);
    assert.match(settled.failure!.cause, /^Released unpublished: /);
    // The later attempt had already ended: its reconciliation is settled, never parked.
    assert.ok(recoveries(f.log, later).every((receipt) => receipt.state === "delivered"));
    const reland = f.submit(bound(await f.candidate("schema/held-again.ts"), earlierSpec));
    await drained(f.log, build.route);
    assert.equal((await f.land(reland))?.type, "landed");
    // A landing of the later Spec now integrates its own candidate.
    const last = f.submit(bound(await f.candidate("later-last.txt"), laterSpec));
    await drained(f.log, build.route);
    assert.equal((await f.land(last))?.type, "landed");
  } finally { await f.dispose(); }
}, 240_000);
