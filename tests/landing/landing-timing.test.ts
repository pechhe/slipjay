import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { landingTimingLine } from "../../src/lib/landing/landing-timing.ts";

test("landing timing reports each runner stage and the total", () => {
  const line = landingTimingLine({ startedAt: 0, finishedAt: 9_000, stages: [["queued", 0], ["verifying", 1_000], ["publishing", 5_000]] });
  assert.equal(line, "[land] queued 1.0s · verifying 4.0s · publishing 4.0s · total 9.0s");
});
