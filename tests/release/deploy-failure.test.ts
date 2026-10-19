import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import type { BoundedProcessResult } from "../../src/lib/infra/bounded-process.ts";
import { failure } from "../../src/lib/release/deploy.ts";

const exited = (stderr: string, stdout = "") => ({ exitCode: 1, signal: null, timedOut: false, stdout, stderr }) as unknown as BoundedProcessResult;

test("an uncaught error's reason is its message, not the stack and banner after it", () => {
  const bun = [
    "125 |   const drill = drillFailure(homedir(), process.env, step, name);",
    "126 |   if (drill) throw new Error(drill);",
    "                         ^",
    "error: release drill: www health fails on purpose",
    "      at /tmp/source/scripts/deploy.ts:126:23",
    "",
    "Bun v1.4.3 (Linux x64)",
  ].join("\n");
  assert.equal(failure(exited(bun), 1000), "exited 1: error: release drill: www health fails on purpose");
});

test("an error block counts on either stream and through colour codes", () => {
  assert.equal(failure(exited("warning: using fallback config", "Error: health endpoint unavailable"), 1000), "exited 1: Error: health endpoint unavailable\nwarning: using fallback config");
  assert.equal(failure(exited("\u001b[31merror\u001b[0m: www health failed\n    at /tmp/deploy.ts:1:1\n\nBun v1.4.3 (Linux x64)"), 1000), "exited 1: error: www health failed");
});

test("output with no error block keeps its last lines", () => {
  assert.equal(failure(exited("one\ntwo\nthree\nhq health failed"), 1000), "exited 1: two\nthree\nhq health failed");
  assert.equal(failure({ ...exited(""), exitCode: 0 }, 1000), null);
});
