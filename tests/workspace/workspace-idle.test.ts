import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { lastKnownTouch } from "../../src/lib/workspace/workspace-idle.ts";

const CLOCK = "2026-11-15T10:00:00.000Z";
const UPDATED = "2026-11-10T09:00:00.000Z";
const CLAIMED = "2026-11-05T09:00:00.000Z";
const CREATED = "2026-11-01T09:00:00.000Z";

test("a recorded idle clock is the time a checkout ages from", () => {
  assert.equal(lastKnownTouch({ lastActivityAt: CLOCK, updatedAt: UPDATED, createdAt: CREATED }), Date.parse(CLOCK));
  assert.equal(lastKnownTouch({ lastActivityAt: CLOCK, updatedAt: "2026-11-16T09:00:00.000Z" }), Date.parse(CLOCK), "a stamp newer than the clock does not move it");
});

test("without a recorded clock the newest stamp the metadata carries stands in", () => {
  assert.equal(lastKnownTouch({ createdAt: CREATED, updatedAt: UPDATED }), Date.parse(UPDATED));
  assert.equal(lastKnownTouch({ createdAt: CREATED, claimedAt: CLAIMED }), Date.parse(CLAIMED));
  assert.equal(lastKnownTouch({ attachedAt: UPDATED, createdAt: CREATED, claimedAt: CLAIMED }), Date.parse(UPDATED));
});

test("no stamp at all is unknown, not idle for ever", () => {
  assert.equal(lastKnownTouch(null), null);
  assert.equal(lastKnownTouch(undefined), null);
  assert.equal(lastKnownTouch({}), null);
  assert.equal(lastKnownTouch({ lastActivityAt: 42, createdAt: "not a date", updatedAt: "" }), null);
});
