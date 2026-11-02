import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { inWindow, nextPromotionAt, promotionSchedule } from "../../src/lib/policy/promotion-schedule.ts";

const fail = (message: string): never => { throw new Error(message); };
const london = { everyMinutes: 30, from: "08:00", until: "20:00", timeZone: "Europe/London" };
const at = (iso: string) => Date.parse(iso);

test("a promotion waits for the interval after the last one", () => {
  const now = at("2026-11-02T10:10:00Z");
  assert.equal(nextPromotionAt(london, undefined, now), now, "nothing promoted yet: now");
  assert.equal(nextPromotionAt(london, at("2026-11-02T09:50:00Z"), now), at("2026-11-02T10:20:00Z"));
  assert.equal(nextPromotionAt(london, at("2026-11-02T09:30:00Z"), now), now, "the interval has passed");
});

test("outside the window it waits for the next opening in the repository's time zone", () => {
  // 20:05 GMT on Monday: the window reopens at 08:00 GMT on Tuesday.
  assert.equal(nextPromotionAt(london, at("2026-11-02T19:00:00Z"), at("2026-11-02T20:05:00Z")), at("2026-11-03T08:00:00Z"));
  // In British Summer Time 08:00 local is 07:00 UTC.
  assert.equal(nextPromotionAt(london, undefined, at("2026-07-01T05:00:00Z")), at("2026-07-01T07:00:00Z"));
  // An interval ending after closing time carries over to the next opening.
  assert.equal(nextPromotionAt(london, at("2026-11-02T19:45:00Z"), at("2026-11-02T19:50:00Z")), at("2026-11-03T08:00:00Z"));
});

test("a window may cross midnight", () => {
  const night = { ...london, from: "22:00", until: "02:00" };
  assert.ok(inWindow(night, at("2026-11-02T23:30:00Z")));
  assert.ok(inWindow(night, at("2026-11-03T01:30:00Z")));
  assert.ok(!inWindow(night, at("2026-11-03T02:00:00Z")), "until is exclusive");
});

test("a declared schedule is validated", () => {
  assert.equal(promotionSchedule(undefined, fail), undefined);
  assert.deepEqual(promotionSchedule(london, fail), london);
  for (const [bad, message] of [
    [{ ...london, everyMinutes: 0 }, /everyMinutes/],
    [{ ...london, from: "8:00" }, /from must be/],
    [{ ...london, until: "08:00" }, /must differ/],
    [{ ...london, timeZone: "Mars/Olympus" }, /not a known time zone/],
    [{ ...london, timeZone: "" }, /must be an IANA time zone/],
    [{ ...london, weekdays: [1] }, /unknown fields: weekdays/],
  ] as const) assert.throws(() => promotionSchedule(bad, fail), message);
});
