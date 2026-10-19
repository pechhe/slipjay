import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { mapBounded } from "../../src/lib/workspace/bounded-map.ts";

test("a bounded map never runs more than its limit at once and keeps input order", async () => {
  let running = 0;
  let peak = 0;
  const items = Array.from({ length: 25 }, (_, index) => index);
  const results = await mapBounded(items, 4, async (item) => {
    running += 1;
    peak = Math.max(peak, running);
    // Later items finish first, so order comes from the index, not completion.
    await new Promise((settle) => setTimeout(settle, (25 - item) % 5));
    running -= 1;
    return item * 2;
  });
  assert.equal(peak, 4);
  assert.deepEqual(results, items.map((item) => item * 2));
  assert.deepEqual(await mapBounded([], 4, async () => 1), []);
});
