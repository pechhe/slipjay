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

const daily = { at: ["00:00", "12:00", "18:00"], timeZone: "Europe/London" };

test("with fixed times a candidate waits for the next one", () => {
  // 09:00 GMT, with the last promotion at midnight.
  assert.equal(nextPromotionAt(daily, at("2026-11-02T00:05:00Z"), at("2026-11-02T09:00:00Z")), at("2026-11-02T12:00:00Z"));
  // After the last time of the day it waits for midnight.
  assert.equal(nextPromotionAt(daily, at("2026-11-02T18:05:00Z"), at("2026-11-02T20:00:00Z")), at("2026-11-03T00:00:00Z"));
  // In British Summer Time 12:00 local is 11:00 UTC.
  assert.equal(nextPromotionAt(daily, at("2026-07-01T00:05:00Z"), at("2026-07-01T09:00:00Z")), at("2026-07-01T11:00:00Z"));
});

test("a fixed time stays open for an hour, once", () => {
  const noon = at("2026-11-02T12:00:00Z");
  const midnight = at("2026-11-02T00:05:00Z");
  assert.equal(nextPromotionAt(daily, midnight, noon), noon, "it starts at its time");
  assert.equal(nextPromotionAt(daily, midnight, noon + 59 * 60_000), noon + 59 * 60_000, "a candidate ready within the hour still ships");
  assert.equal(nextPromotionAt(daily, midnight, noon + 60 * 60_000), at("2026-11-02T18:00:00Z"), "after the hour it waits for the next time");
  assert.equal(nextPromotionAt(daily, noon + 5 * 60_000, noon + 10 * 60_000), at("2026-11-02T18:00:00Z"), "a promotion in this slot closes it");
});

test("an owner's promotion between fixed times leaves the next one in place", () => {
  assert.equal(nextPromotionAt(daily, at("2026-11-02T14:00:00Z"), at("2026-11-02T14:30:00Z")), at("2026-11-02T18:00:00Z"));
  assert.equal(nextPromotionAt(daily, at("2026-11-02T14:00:00Z"), at("2026-11-02T18:00:00Z")), at("2026-11-02T18:00:00Z"), "and that time still runs");
});

test("a clock change neither repeats nor loses a fixed time", () => {
  const night = { at: ["01:30"], timeZone: "Europe/London" };
  // 31 Oct 2027: 01:30 happens twice, first in BST (00:30Z), then in GMT (01:30Z). A promotion at the first closes both.
  assert.equal(nextPromotionAt(night, at("2027-10-31T00:35:00Z"), at("2027-10-31T01:35:00Z")), at("2027-11-01T01:30:00Z"));
  assert.equal(nextPromotionAt(night, at("2027-10-30T00:35:00Z"), at("2027-10-31T01:35:00Z")), at("2027-10-31T01:35:00Z"), "with no promotion that day it is open");
  // 28 Mar 2027 has no 01:30: the next one is on the 29th, in BST.
  assert.equal(nextPromotionAt(night, at("2027-03-27T01:35:00Z"), at("2027-03-27T02:31:00Z")), at("2027-03-29T00:30:00Z"));
  // A promotion earlier the same day, before the time's clock reading, leaves it open.
  assert.equal(nextPromotionAt(daily, at("2026-11-02T14:00:00Z"), at("2026-11-02T18:10:00Z")), at("2026-11-02T18:10:00Z"));
});

test("a declared schedule is validated", () => {
  assert.deepEqual(promotionSchedule(daily, fail), daily);
  for (const [bad, message] of [
    [{ ...daily, at: [] }, /must list/],
    [{ ...daily, at: ["25:00"] }, /must list/],
    [{ ...daily, at: ["12:00", "12:00"] }, /must not repeat/],
    [{ ...daily, everyMinutes: 30 }, /cannot be combined/],
    [{ ...daily, timeZone: "" }, /must be an IANA time zone/],
  ] as const) assert.throws(() => promotionSchedule(bad, fail), message);
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
