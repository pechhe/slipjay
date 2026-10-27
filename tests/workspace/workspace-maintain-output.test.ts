import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));

/**
 * The pass records a request file it cannot parse as a failure. That failure is part of
 * what it did, so the pass says so instead of reporting nothing to do.
 */
test("maintain reports an unreadable request instead of nothing to archive or evict", async () => {
  const home = await mkdtemp(join(tmpdir(), "slipjay-maintain-"));
  const requests = join(home, ".slipjay", "state", "archive-requests");
  await mkdir(requests, { recursive: true });
  await writeFile(join(requests, "broken.json"), "{ not a request");
  // A disposable HOME keeps the pass out of real state, and a home rather than a checkout
  // leaves it nothing to evict.
  const run = (args: string[]) => spawnSync("bun", [cli, "maintain", ...args], {
    cwd: home, env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 30_000,
  });

  const plain = run([]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^failed\tbroken\t.*could not be read/m);
  assert.doesNotMatch(plain.stdout, /Nothing to archive or evict/);

  const json = run(["--json"]);
  assert.equal(json.status, 0, json.stderr);
  const reported = JSON.parse(json.stdout) as { requests: Array<{ requestId: string; outcome: string; reason: string }>; evictions: unknown };
  assert.deepEqual(reported.requests.map(({ requestId, outcome }) => ({ requestId, outcome })), [{ requestId: "broken", outcome: "failed" }]);
  assert.match(reported.requests[0]!.reason, /the request file could not be read/);
  assert.deepEqual(reported.evictions, { results: [], skipped: [] });
});
