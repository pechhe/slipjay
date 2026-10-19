import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import type { AuditPolicy } from "../../src/lib/policy/audit-policy.ts";
import { createAuditScheduler } from "../../src/lib/release/audit-scheduler.ts";
import { AUDIT_INTERRUPTED_REASON, OWNER_KILL_REASON } from "../../src/lib/runner/runner-contract.ts";
import { openOperationLog } from "../../src/lib/runner/runner-log.ts";

const HOUR = 3_600_000;
const command = { executable: "true", args: [] };
const policy: AuditPolicy = { commands: [command], timeOfDay: "02:00", timeZone: "Europe/London" };
const REPO = "owner/repo";
const HEAD = "a".repeat(40);
// 14 July 2026, 10:00 London: the slot today was 02:00 BST, 01:00 UTC.
const MORNING = Date.parse("2026-07-14T09:00:00Z");

function fixture(start = MORNING) {
  const log = openOperationLog(":memory:");
  let clock = start;
  const submitted: { id: string; slot: string }[] = [];
  const scheduler = createAuditScheduler({ log, now: () => clock,
    submit(repo, slot) {
      const id = `audit-${submitted.length + 1}`;
      submitted.push({ id, slot: new Date(slot).toISOString() });
      log.append(id, { type: "submitted", kind: "audit", repo, commitId: "", slot: new Date(slot).toISOString(), submittedBy: "schedule" });
    } });
  return {
    log, scheduler, submitted,
    at(iso: string) { clock = Date.parse(iso); },
    advance(ms: number) { clock += ms; },
    start(id: string) { log.append(id, { type: "stage", stage: "verifying" }); },
    finish(id: string, outcome: "green" | "failed" | "killed" | "interrupted") {
      if (outcome === "green") log.append(id, { type: "audited", commit: HEAD, commands: ["true"], passed: ["true"], skipped: [], reused: [] });
      else if (outcome === "failed") log.append(id, { type: "failed", stage: "verifying", reason: "Required verification failed", command: "true" });
      else log.append(id, { type: "cancelled", reason: outcome === "killed" ? OWNER_KILL_REASON : AUDIT_INTERRUPTED_REASON });
    },
  };
}

test("an audit starts with no landing in the ledger, once for the slot that has passed, and not again while it is open", () => {
  const f = fixture();
  try {
    assert.equal(f.log.lastLanded(REPO), null);
    f.scheduler.consider(REPO, policy);
    f.scheduler.consider(REPO, policy);
    assert.deepEqual(f.submitted, [{ id: "audit-1", slot: "2026-07-14T01:00:00.000Z" }]);
    f.start("audit-1");
    f.scheduler.consider(REPO, policy);
    assert.equal(f.submitted.length, 1, "a running audit is not doubled");
  } finally { f.scheduler.close(); f.log.close(); }
});

test("a repository without an audit declaration arms nothing, and dropping the declaration disarms it", () => {
  const f = fixture();
  try {
    f.scheduler.consider(REPO, null);
    f.scheduler.reconsider(REPO);
    assert.equal(f.submitted.length, 0);
    f.scheduler.consider(REPO, policy);
    f.finish("audit-1", "green");
    f.scheduler.consider(REPO, null);
    f.at("2026-07-15T03:00:00Z");
    f.scheduler.reconsider(REPO);
    assert.equal(f.submitted.length, 1, "no policy remembered, so nothing is asked again");
  } finally { f.scheduler.close(); f.log.close(); }
});

test("a green audit covers its slot; the next is due at the next wall-clock time, not an interval after the last run", () => {
  const f = fixture();
  try {
    f.scheduler.consider(REPO, policy);
    f.start("audit-1");
    // It ran late and finished mid-afternoon: that does not move tomorrow's 02:00 BST.
    f.at("2026-07-14T14:00:00Z");
    f.finish("audit-1", "green");
    f.scheduler.consider(REPO, policy);
    assert.equal(f.submitted.length, 1);
    f.at("2026-07-15T00:59:00Z");
    f.scheduler.consider(REPO, policy);
    assert.equal(f.submitted.length, 1, "not due before 02:00 London, though over 10 hours have passed");
    f.at("2026-07-15T01:00:00Z");
    f.scheduler.consider(REPO, policy);
    assert.deepEqual(f.submitted.map((entry) => entry.slot), ["2026-07-14T01:00:00.000Z", "2026-07-15T01:00:00.000Z"]);
  } finally { f.scheduler.close(); f.log.close(); }
});

test("the time zone decides the slot: the same instant is covered in Tokyo and due in London", () => {
  const f = fixture();
  try {
    const tokyo: AuditPolicy = { ...policy, timeZone: "Asia/Tokyo" };
    f.scheduler.consider("owner/london", policy);
    f.scheduler.consider("owner/tokyo", tokyo);
    // 09:00 UTC is 10:00 in London (slot 01:00 UTC today) and 18:00 in Tokyo (slot 17:00 UTC yesterday).
    assert.deepEqual(f.submitted.map((entry) => entry.slot), ["2026-07-14T01:00:00.000Z", "2026-07-13T17:00:00.000Z"]);
  } finally { f.scheduler.close(); f.log.close(); }
});

test("a missed run is submitted at the next opportunity, and several missed times are one run", () => {
  const f = fixture();
  try {
    f.scheduler.consider(REPO, policy);
    f.finish("audit-1", "green");
    // The runner was down for three nights.
    f.at("2026-07-17T09:00:00Z");
    f.scheduler.consider(REPO, policy);
    assert.deepEqual(f.submitted.map((entry) => entry.slot), ["2026-07-14T01:00:00.000Z", "2026-07-17T01:00:00.000Z"]);
  } finally { f.scheduler.close(); f.log.close(); }
});

test("a run cancelled while queued or killed is submitted again at the next consideration", () => {
  const f = fixture();
  try {
    f.scheduler.consider(REPO, policy);
    f.log.append("audit-1", { type: "cancelled", reason: "cancelled by the author" });
    f.scheduler.reconsider(REPO);
    assert.equal(f.submitted.length, 2, "cancelled while queued never ran");
    f.start("audit-2");
    f.finish("audit-2", "killed");
    f.scheduler.reconsider(REPO);
    assert.deepEqual(f.submitted.map((entry) => entry.slot), Array(3).fill("2026-07-14T01:00:00.000Z"), "a kill is no verdict, unlike a reset's, which counts as run");
  } finally { f.scheduler.close(); f.log.close(); }
});

test("a restart mid-audit records it interrupted, and the schedule runs it again", () => {
  const f = fixture();
  try {
    f.scheduler.consider(REPO, policy);
    f.start("audit-1");
    // The new runner process: recovery closes the running audit as interrupted, then the schedule is asked afresh.
    f.finish("audit-1", "interrupted");
    const restarted = createAuditScheduler({ log: f.log, now: () => MORNING + HOUR, submit: (repo, slot) => f.log.append("audit-2", { type: "submitted", kind: "audit", repo, commitId: "", slot: new Date(slot).toISOString(), submittedBy: "schedule" }) });
    try {
      restarted.consider(REPO, policy);
      assert.equal(f.log.operation("audit-1")!.status, "cancelled");
      const rerun = f.log.operation("audit-2");
      assert.ok(rerun?.kind === "audit" && rerun.slot === "2026-07-14T01:00:00.000Z" && rerun.status === "queued");
    } finally { restarted.close(); }
  } finally { f.scheduler.close(); f.log.close(); }
});

test("a failing audit is a verdict: it is not retried before the next scheduled time", () => {
  const f = fixture();
  try {
    f.scheduler.consider(REPO, policy);
    f.start("audit-1");
    f.finish("audit-1", "failed");
    f.scheduler.reconsider(REPO);
    f.advance(6 * HOUR);
    f.scheduler.reconsider(REPO);
    assert.equal(f.submitted.length, 1);
    f.at("2026-07-15T01:00:00Z");
    f.scheduler.reconsider(REPO);
    assert.equal(f.submitted.length, 2);
  } finally { f.scheduler.close(); f.log.close(); }
});

test("a time that is not yet due arms one timer that submits when it fires, and a withdrawn policy clears it", () => {
  vi.useFakeTimers();
  const f = fixture();
  try {
    f.scheduler.consider(REPO, policy);
    f.finish("audit-1", "green");
    f.scheduler.reconsider(REPO);
    f.scheduler.reconsider(REPO);
    assert.equal(f.submitted.length, 1);
    assert.equal(vi.getTimerCount(), 1, "one timer however often it is asked");
    // 09:00 UTC to 01:00 UTC the next day.
    f.advance(16 * HOUR);
    vi.advanceTimersByTime(16 * HOUR);
    assert.deepEqual(f.submitted.map((entry) => entry.slot), ["2026-07-14T01:00:00.000Z", "2026-07-15T01:00:00.000Z"]);
    f.finish("audit-2", "green");
    f.scheduler.reconsider(REPO);
    assert.equal(vi.getTimerCount(), 1);
    f.scheduler.consider(REPO, null);
    assert.equal(vi.getTimerCount(), 0);
  } finally { f.scheduler.close(); f.log.close(); vi.useRealTimers(); }
});
