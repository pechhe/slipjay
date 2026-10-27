import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createRetention } from "../../src/lib/runner/retention-loop.ts";

/** Poll `check` until it holds, or fail: the interval is a race the test must not paper over with a sleep. */
async function until(check: () => boolean, budgetMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > budgetMs) throw new Error("timed out waiting for the next retention pass");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a failed retention pass is journalled and the loop keeps its schedule", async () => {
  const lines: string[] = [];
  let passes = 0;
  const retention = createRetention({
    intervalMs: 5,
    log: (line) => lines.push(line),
    async pass() {
      passes += 1;
      if (passes === 1) throw new Error("ledger is locked");
    },
  });
  try {
    // The pass the runner runs as soon as recovery settles.
    await retention.retain();
    assert.deepEqual(lines, ["[retention] pass failed: ledger is locked"]);
    // The failure did not end the loop: the interval ran the pass again, and a pass that succeeds logs nothing.
    await until(() => passes >= 2);
    assert.deepEqual(lines, ["[retention] pass failed: ledger is locked"]);
  } finally { retention.close(); }
});
