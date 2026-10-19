import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import type { ResetPolicy } from "../../src/lib/policy/post-integration-policy.ts";
import { createResetScheduler } from "../../src/lib/release/reset-scheduler.ts";
import { OWNER_KILL_REASON } from "../../src/lib/runner/runner-contract.ts";
import { openOperationLog } from "../../src/lib/runner/runner-log.ts";

const HOUR = 3_600_000;
const command = { executable: "true", args: [], cwd: "." };
const weekly: ResetPolicy = { version: 1, target: "db", command, targetProbe: command, timeoutMs: 60_000, environmentKeys: [], intervalMs: 7 * 24 * HOUR };

function fixture() {
  const log = openOperationLog(":memory:");
  let clock = Date.now();
  const submitted: string[] = [];
  const scheduler = createResetScheduler({ log, now: () => clock,
    submit(repo) {
      submitted.push(`reset-${submitted.length + 1}`);
      log.append(submitted.at(-1)!, { type: "submitted", kind: "reset", repo, commitId: "a".repeat(40), submittedBy: "schedule" });
    } });
  return {
    log, scheduler, submitted,
    advance(ms: number) { clock += ms; },
    start(id: string) { log.append(id, { type: "stage", stage: "resetting" }); },
    finish(id: string, outcome: "reset" | "failed" | "killed") {
      log.append(id, outcome === "reset" ? { type: "reset", target: "db", source: "a".repeat(40) }
        : outcome === "failed" ? { type: "failed", stage: "resetting", reason: "Reset command failed" } : { type: "cancelled", reason: OWNER_KILL_REASON });
    },
  };
}

test("a repository that never reset resets at once, and only once while that reset is open; the next is due an interval after it", () => {
  const f = fixture();
  try {
    f.scheduler.consider("owner/repo", weekly);
    f.scheduler.consider("owner/repo", weekly);
    assert.deepEqual(f.submitted, ["reset-1"]);
    f.start("reset-1");
    f.scheduler.consider("owner/repo", weekly);
    assert.equal(f.submitted.length, 1, "a running reset is not doubled");
    f.finish("reset-1", "reset");
    f.advance(weekly.intervalMs - HOUR);
    f.scheduler.consider("owner/repo", weekly);
    assert.equal(f.submitted.length, 1, "not due before the interval ends");
    f.advance(2 * HOUR);
    f.scheduler.consider("owner/repo", weekly);
    assert.deepEqual(f.submitted, ["reset-1", "reset-2"]);
  } finally { f.scheduler.close(); f.log.close(); }
});

test("a failed or killed reset waits for the next interval; one cancelled while queued never started, and an undeclared reset arms nothing", () => {
  const f = fixture();
  try {
    // One repository each, so every reset is stamped near this clock.
    f.scheduler.consider("owner/failed", weekly);
    f.start("reset-1");
    f.finish("reset-1", "failed");
    f.scheduler.consider("owner/failed", weekly);
    assert.equal(f.submitted.length, 1, "a failure is not retried at once");
    f.scheduler.consider("owner/killed", weekly);
    f.start("reset-2");
    f.finish("reset-2", "killed");
    f.scheduler.consider("owner/killed", weekly);
    assert.equal(f.submitted.length, 2, "the owner's kill is not undone by the schedule");
    f.scheduler.consider("owner/cancelled", weekly);
    f.log.append("reset-3", { type: "cancelled", reason: "cancelled by the author" });
    f.scheduler.consider("owner/cancelled", weekly);
    assert.deepEqual(f.submitted, ["reset-1", "reset-2", "reset-3", "reset-4"], "a cancelled queued reset does not count as one");
    f.scheduler.consider("owner/undeclared", null);
    assert.equal(f.submitted.length, 4);
  } finally { f.scheduler.close(); f.log.close(); }
});

test("a reset that failed before its step retries an hour later, not at once and not an interval later", () => {
  const f = fixture();
  try {
    // The log stamps submissions with the real clock, so this starts from a first reset.
    f.scheduler.consider("owner/repo", weekly);
    f.log.append("reset-1", { type: "stage", stage: "fetching" });
    f.log.append("reset-1", { type: "failed", stage: "fetching", reason: "git fetch failed" });
    f.scheduler.consider("owner/repo", weekly);
    assert.equal(f.submitted.length, 1, "a failure before the step does not spin");
    // A minute past the hour: the log stamped reset-1 a little after the fixture's clock started.
    f.advance(HOUR + 60_000);
    f.scheduler.consider("owner/repo", weekly);
    assert.deepEqual(f.submitted, ["reset-1", "reset-2"], "it retries an hour after it started");
    f.log.append("reset-2", { type: "stage", stage: "fetching" });
    f.log.append("reset-2", { type: "cancelled", reason: OWNER_KILL_REASON });
    f.advance(HOUR);
    f.scheduler.consider("owner/repo", weekly);
    assert.equal(f.submitted.length, 2, "the owner's kill before the step stands until the next interval");
  } finally { f.scheduler.close(); f.log.close(); }
});

test("a reset that is not due yet is submitted by one timer when the interval ends, and a withdrawn policy clears it", async () => {
  const f = fixture();
  const short = { ...weekly, intervalMs: 50 };
  try {
    f.scheduler.consider("owner/repo", short);
    f.start("reset-1");
    f.finish("reset-1", "reset");
    f.scheduler.consider("owner/repo", short);
    f.scheduler.consider("owner/repo", short);
    // Past the due time even with the log's wall-clock stamp a few ms ahead of this clock.
    f.advance(1_000);
    for (const deadline = Date.now() + 5_000; f.submitted.length < 2 && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(f.submitted, ["reset-1", "reset-2"], "one timer, one reset");
    f.start("reset-2");
    f.finish("reset-2", "reset");
    f.advance(-1_000);
    f.scheduler.consider("owner/repo", short);
    f.scheduler.consider("owner/repo", null);
    f.advance(1_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(f.submitted.length, 2, "the cleared timer submits nothing");
  } finally { f.scheduler.close(); f.log.close(); }
});
