import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { auditPolicy } from "../../src/lib/policy/audit-policy.ts";
import { latestAuditSlot, nextAuditSlot } from "../../src/lib/release/audit-schedule.ts";

const at = (iso: string) => Date.parse(iso);
const iso = (instant: number) => new Date(instant).toISOString();
const london = { timeOfDay: "02:00", timeZone: "Europe/London" };

test("the slot is 02:00 on London's clock: 02:00 UTC in winter, 01:00 UTC in summer", () => {
  assert.equal(iso(latestAuditSlot(at("2026-01-15T12:00:00Z"), london)), "2026-01-15T02:00:00.000Z");
  assert.equal(iso(latestAuditSlot(at("2026-07-15T12:00:00Z"), london)), "2026-07-15T01:00:00.000Z");
  assert.equal(iso(nextAuditSlot(at("2026-07-15T12:00:00Z"), london)), "2026-07-16T01:00:00.000Z");
});

test("before today's time the latest slot is yesterday's, and at the time it is today's", () => {
  assert.equal(iso(latestAuditSlot(at("2026-07-15T00:59:59Z"), london)), "2026-07-14T01:00:00.000Z");
  assert.equal(iso(latestAuditSlot(at("2026-07-15T01:00:00Z"), london)), "2026-07-15T01:00:00.000Z");
  assert.equal(iso(nextAuditSlot(at("2026-07-15T01:00:00Z"), london)), "2026-07-16T01:00:00.000Z");
  assert.equal(iso(nextAuditSlot(at("2026-07-15T00:59:59Z"), london)), "2026-07-15T01:00:00.000Z");
});

test("the slot follows the day in the zone, not the UTC day", () => {
  // 23:30 UTC on 14 July is already 00:30 on 15 July in London, still before that day's 02:00.
  assert.equal(iso(latestAuditSlot(at("2026-07-14T23:30:00Z"), london)), "2026-07-14T01:00:00.000Z");
  const tokyo = { timeOfDay: "02:00", timeZone: "Asia/Tokyo" };
  // 17:00 UTC is 02:00 the next day in Tokyo.
  assert.equal(iso(latestAuditSlot(at("2026-07-14T17:00:00Z"), tokyo)), "2026-07-14T17:00:00.000Z");
  assert.equal(iso(latestAuditSlot(at("2026-07-14T16:59:00Z"), tokyo)), "2026-07-13T17:00:00.000Z");
  const newYork = { timeOfDay: "23:30", timeZone: "America/New_York" };
  assert.equal(iso(latestAuditSlot(at("2026-01-15T12:00:00Z"), newYork)), "2026-01-15T04:30:00.000Z");
});

test("daylight saving moves the slot with the clock: the night the clocks change is 23 or 25 hours long", () => {
  // Clocks went forward at 01:00 UTC on 29 March 2026 and back at 01:00 UTC on 25 October.
  const before = latestAuditSlot(at("2026-03-28T12:00:00Z"), london), after = nextAuditSlot(at("2026-03-28T12:00:00Z"), london);
  assert.equal(iso(before), "2026-03-28T02:00:00.000Z");
  assert.equal(iso(after), "2026-03-29T01:00:00.000Z");
  assert.equal(after - before, 23 * 3_600_000);
  const autumn = nextAuditSlot(at("2026-10-24T12:00:00Z"), london);
  assert.equal(iso(autumn), "2026-10-25T02:00:00.000Z");
  assert.equal(autumn - latestAuditSlot(at("2026-10-24T12:00:00Z"), london), 25 * 3_600_000);
});

test("a time the clock skips runs once, after the gap; one it repeats runs at its first reading", () => {
  const skipped = { timeOfDay: "01:30", timeZone: "Europe/London" };
  // 01:30 does not exist on 29 March 2026 (01:00 becomes 02:00): the slot is the same reading after the gap.
  assert.equal(iso(nextAuditSlot(at("2026-03-28T12:00:00Z"), skipped)), "2026-03-29T01:30:00.000Z");
  const repeated = { timeOfDay: "01:30", timeZone: "Europe/London" };
  // 01:30 happens twice on 25 October 2026; the first reading is 00:30 UTC.
  assert.equal(iso(nextAuditSlot(at("2026-10-24T12:00:00Z"), repeated)), "2026-10-25T00:30:00.000Z");
});

test("the slots tile time: every instant has one latest slot at or before it and a next slot after it", () => {
  const start = at("2026-03-26T00:00:00Z");
  for (let step = 0; step < 24 * 12; step += 1) {
    const now = start + step * 30 * 60_000;
    const latest = latestAuditSlot(now, london), next = nextAuditSlot(now, london);
    assert.ok(latest <= now && now < next, iso(now));
    assert.ok(next - latest >= 23 * 3_600_000 && next - latest <= 25 * 3_600_000, iso(now));
    assert.equal(nextAuditSlot(latest - 1, london), latest, iso(now));
  }
});

const check = (value: unknown) => [{ executable: "bun", args: ["run", String(value)] }];
const parse = (value: unknown) => auditPolicy(value, { checks: check, fail: (message) => { throw new Error(message); } });

test("an audit policy defaults to 02:00 Europe/London and refuses what would run nothing or never run", () => {
  assert.equal(parse(undefined), null);
  assert.deepEqual(parse({ commands: ["test"] }), { commands: check("test"), timeOfDay: "02:00", timeZone: "Europe/London" });
  assert.deepEqual(parse({ commands: ["test"], timeOfDay: "23:59", timeZone: "America/New_York" })?.timeOfDay, "23:59");
  assert.throws(() => parse({ commands: [] }), /at least one command/);
  assert.throws(() => parse({}), /at least one command/);
  assert.throws(() => parse({ commands: ["test"], timeOfDay: "24:00" }), /HH:MM/);
  assert.throws(() => parse({ commands: ["test"], timeOfDay: "2:00" }), /HH:MM/);
  assert.throws(() => parse({ commands: ["test"], timeZone: "Mars/Olympus" }), /IANA time zone/);
  assert.throws(() => parse({ commands: ["test"], every: "day" }), /does not know: every/);
  assert.throws(() => parse("nightly"), /not an object/);
});

test("the execution policy reads the audit, runs its commands through the gate's checks, and keeps it apart from the landing gate", async () => {
  const { parseExecutionPolicy } = await import("../../src/lib/policy/execution-policy.ts");
  const audit = { commands: [{ executable: "bun", args: ["install", "--frozen-lockfile"] }, { executable: "bun", args: ["run", "test"], cwd: "app" }] };
  const policy = parseExecutionPolicy(JSON.stringify({ version: 1, requiredLandingVerification: [{ executable: "bun", args: ["run", "check"] }], audit }));
  assert.deepEqual(policy.audit, { ...audit, timeOfDay: "02:00", timeZone: "Europe/London" });
  assert.equal(policy.requiredLandingVerification.length, 1);
  assert.equal(parseExecutionPolicy(JSON.stringify({ version: 1 })).audit, undefined);
  assert.throws(() => parseExecutionPolicy(JSON.stringify({ version: 1, audit: { commands: [{ executable: "sh", args: ["-c", "true"] }] } })), /audit\.commands\[0\]\.executable is unsafe/);
  assert.throws(() => parseExecutionPolicy(JSON.stringify({ version: 1, audit: { commands: [{ executable: "bun", args: [], cwd: "../x" }] } })), /audit\.commands\[0\]\.cwd/);
  assert.throws(() => parseExecutionPolicy(JSON.stringify({ version: 1, audit: { commands: [] } })), /slipjay.json audit\.commands must list at least one command/);
});
