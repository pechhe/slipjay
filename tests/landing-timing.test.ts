import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { landingTimingLine, landingTimingRecord } from "../src/lib/landing-timing.ts";

test("landing timing reports each runner stage and the total", () => {
  const line = landingTimingLine({ startedAt: 0, finishedAt: 9_000, stages: [["queued", 0], ["verifying", 1_000], ["publishing", 5_000]] });
  assert.equal(line, "[land] queued 1.0s · verifying 4.0s · publishing 4.0s · total 9.0s");
});

test("landing timing record sums each stage, including time queued behind other landings", () => {
  const record = landingTimingRecord({ startedAt: 0, finishedAt: 9_000, stages: [["queued", 500], ["fetching", 6_000], ["verifying", 7_000], ["queued", 8_000], ["publishing", 8_500]] }, true);
  assert.deepEqual(record, { ok: true, totalMs: 9_000, stagesMs: { queued: 6_000, fetching: 1_000, verifying: 1_000, publishing: 500 } });
});
