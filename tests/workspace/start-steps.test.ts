import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { timed } from "../../src/lib/workspace/start-steps.ts";
import type { StartSteps } from "../../src/lib/workspace/start-steps.ts";

const pause = (ms: number) => new Promise((settle) => setTimeout(settle, ms));

test("a step timed inside another counts as itself, never twice", async () => {
  const steps: StartSteps = {};
  const started = performance.now();
  await timed(steps, "install", async () => {
    await pause(40);
    await timed(steps, "fingerprint", () => pause(60));
  });
  const wall = performance.now() - started;
  assert.ok(steps.fingerprint! >= 55 && steps.install! >= 35, JSON.stringify(steps));
  assert.ok(Math.abs(steps.install! + steps.fingerprint! - wall) <= 2, `the install excludes its fingerprint: ${JSON.stringify(steps)} in ${wall}ms`);
  assert.equal(await timed(undefined, "fetch", async () => 7), 7, "nothing is recorded without steps");
});
