import assert from "node:assert/strict";
import { createRunnerHandler } from "../../src/lib/runner/runner-api.ts";
import { RUNNER_API, RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { serveRunner } from "../../src/lib/runner/runner-http.ts";
import type { LandingOperation } from "../../src/lib/runner/runner-types.ts";
import { fixture, test } from "./fixtures/runner-queue-fixture.ts";

test("the authenticated prioritize route accepts optional options and refuses invalid or ineligible requests", async () => {
  const f = await fixture();
  const token = "fixture-token";
  try {
    const server = await serveRunner(createRunnerHandler({
      log: f.log, token, runnerName: "fixture", readLog: f.queue.readLog, prioritize: f.queue.prioritize,
      kill: f.queue.kill, onSubmitted: f.queue.wake, subscribe: f.log.subscribe,
    }), { host: "127.0.0.1", port: 0 });
    try {
      f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
      const id = f.submit(await f.candidate("priority.txt"));
      const post = (target: string, body?: string, credential = token) => fetch(
        `${server.url}${RUNNER_API}/operations/${target}/prioritize`,
        { method: "POST", body, headers: { authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(10_000) },
      );
      assert.equal((await post(id, undefined, "wrong-token")).status, 401);
      assert.equal((await post("unknown")).status, 404);
      for (const invalid of ["{", "null", '{"whilePaused":"true"}', '{"reason":3}']) {
        assert.equal((await post(id, invalid)).status, 400, invalid);
      }
      assert.equal((await post(f.submitReset())).status, 409);
      const first = await post(id);
      assert.equal(first.status, 200);
      const { operation: firstOperation } = await first.json() as { operation: LandingOperation };
      assert.equal(firstOperation.stage, "paused");
      assert.equal(firstOperation.prioritized?.whilePaused, false);

      const upgrade = await post(id, JSON.stringify({ whilePaused: true, reason: "urgent fix" }));
      assert.equal(upgrade.status, 200);
      const { operation } = await upgrade.json() as { operation: LandingOperation };
      assert.deepEqual(operation.prioritized, { seq: firstOperation.prioritized?.seq, whilePaused: true, reason: "urgent fix" });
      await f.queue.idle();
      assert.equal(f.result(id)?.type, "landed");
      const finished = await post(id);
      assert.equal(finished.status, 409);
      assert.match((await finished.json() as { error: string }).error, /already finished.*landed/);
    } finally { await server.close(); }
  } finally { await f.dispose(); }
}, 120_000);
