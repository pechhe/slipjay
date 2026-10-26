import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { timed } from "../../src/lib/workspace/start-steps.ts";
import type { StartSteps } from "../../src/lib/workspace/start-steps.ts";

test("a step timed inside another counts as itself, never twice", async () => {
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    const steps: StartSteps = {};
    await timed(steps, "install", async () => {
      now += 40;
      await timed(steps, "fingerprint", async () => { now += 60; });
    });
    assert.deepEqual(steps, { fingerprint: 60, install: 40 });
    assert.equal(await timed(undefined, "fetch", async () => 7), 7, "nothing is recorded without steps");
  } finally {
    clock.mockRestore();
  }
});
