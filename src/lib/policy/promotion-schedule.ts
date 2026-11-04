import { knownTimeZone } from "./audit-policy.ts";

/**
 * `promotionSchedule`: when a `process: "development"` runner may promote by itself. Undeclared, it promotes each
 * pre-verified landing as soon as it can. Declared, landings between promotions ship together, on one of two forms:
 * `at`, fixed times of the repository's local day (`timeZone`), or an interval, at most once every `everyMinutes` and
 * only while the local time is from `from` until `until`.
 * An owner's `slipjay promote --confirm` is never held by it, and counts as the latest promotion.
 */
export type PromotionSchedule =
  | { at: string[]; timeZone: string }
  | { everyMinutes: number; from: string; until: string; timeZone: string };

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;
/** The longest a window can stay closed: a day, plus an hour for a daylight-saving change. */
const SEARCH_MINUTES = 25 * 60;
/** How long a fixed time stays open: a candidate ready in this hour, or a check that had to run again, still ships in its slot. */
const SLOT_OPEN_MINUTES = 60;

const minutesOf = (clock: string) => {
  const [, hours, minutes] = CLOCK.exec(clock)!;
  return Number(hours) * 60 + Number(minutes);
};

/** Validates a declared schedule; undefined when undeclared. */
export function promotionSchedule(declared: unknown, fail: (message: string) => never): PromotionSchedule | undefined {
  if (declared === undefined) return undefined;
  if (declared === null || typeof declared !== "object" || Array.isArray(declared)) fail("promotionSchedule must be an object");
  const { at, everyMinutes, from, until, timeZone, ...rest } = declared as Record<string, unknown>;
  if (Object.keys(rest).length) fail(`promotionSchedule declares unknown fields: ${Object.keys(rest).join(", ")}`);
  if (at !== undefined) {
    if (everyMinutes !== undefined || from !== undefined || until !== undefined) fail("promotionSchedule.at cannot be combined with everyMinutes, from or until");
    if (!Array.isArray(at) || !at.length || at.some((clock) => typeof clock !== "string" || !CLOCK.test(clock))) fail("promotionSchedule.at must list 24-hour HH:MM times");
    if (new Set(at).size !== at.length) fail("promotionSchedule.at must not repeat a time");
    return { at: at as string[], timeZone: validTimeZone(timeZone, fail) };
  }
  if (!Number.isInteger(everyMinutes) || (everyMinutes as number) < 1 || (everyMinutes as number) > 1440) fail("promotionSchedule.everyMinutes must be an integer from 1 to 1440");
  for (const [name, value] of [["from", from], ["until", until]] as const)
    if (typeof value !== "string" || !CLOCK.test(value)) fail(`promotionSchedule.${name} must be a 24-hour HH:MM time`);
  if (from === until) fail("promotionSchedule.from and until must differ");
  return { everyMinutes: everyMinutes as number, from: from as string, until: until as string, timeZone: validTimeZone(timeZone, fail) };
}

function validTimeZone(timeZone: unknown, fail: (message: string) => never): string {
  // An empty zone would silently read the runner host's own zone.
  if (typeof timeZone !== "string" || !timeZone.trim()) fail("promotionSchedule.timeZone must be an IANA time zone");
  if (!knownTimeZone(timeZone as string)) fail(`promotionSchedule.timeZone ${timeZone as string} is not a known time zone`);
  return timeZone as string;
}

const localMinutes = (timeZone: string, at: number) => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  return Number(parts.find((part) => part.type === "hour")!.value) * 60 + Number(parts.find((part) => part.type === "minute")!.value);
};

/** Whether `at` falls in the window: from `from` (inclusive) until `until` (exclusive), crossing midnight when `until` is earlier. */
export function inWindow(schedule: Extract<PromotionSchedule, { from: string }>, at: number): boolean {
  const local = localMinutes(schedule.timeZone, at);
  const from = minutesOf(schedule.from), until = minutesOf(schedule.until);
  return from < until ? local >= from && local < until : local >= from || local < until;
}

/**
 * With fixed times: `now` while a time opened in the last hour and nothing has promoted since it, otherwise the next
 * time. Later than that a candidate waits for the next one, so a landing in the afternoon does not ship by itself
 * because nothing was ready at noon.
 */
function nextFixedTime(schedule: Extract<PromotionSchedule, { at: string[] }>, lastPromotedAt: number | undefined, now: number): number {
  const times = new Set(schedule.at.map(minutesOf));
  const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  for (let step = 0; step < SLOT_OPEN_MINUTES; step++) {
    const opened = minute - step * MINUTE_MS;
    if (times.has(localMinutes(schedule.timeZone, opened))) {
      if (lastPromotedAt === undefined || !closedBy(schedule.timeZone, lastPromotedAt, opened)) return now;
      break;
    }
  }
  let at = minute + MINUTE_MS;
  // Two days: a clock change can skip the only time of a day.
  for (let step = 0; step < 2 * SEARCH_MINUTES && !times.has(localMinutes(schedule.timeZone, at)); step++) at += MINUTE_MS;
  return at;
}

/**
 * Whether a promotion at `promoted` has used the slot that `opened`. A clock going back repeats a local time, and that
 * is still one slot: a promotion earlier the same local day, at or after the same clock time, closes it too.
 */
function closedBy(timeZone: string, promoted: number, opened: number): boolean {
  if (promoted >= opened) return true;
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return day.format(promoted) === day.format(opened) && localMinutes(timeZone, promoted) >= localMinutes(timeZone, opened);
}

/**
 * The earliest time a scheduled promotion may start: `now` when it may start now. With an interval, otherwise the later
 * of `everyMinutes` after `lastPromotedAt` and the window's next opening. Minute steps keep both right across
 * daylight-saving changes.
 */
export function nextPromotionAt(schedule: PromotionSchedule, lastPromotedAt: number | undefined, now: number): number {
  if ("at" in schedule) return nextFixedTime(schedule, lastPromotedAt, now);
  let at = Math.max(now, lastPromotedAt === undefined ? now : lastPromotedAt + schedule.everyMinutes * MINUTE_MS);
  if (inWindow(schedule, at)) return at;
  at = Math.ceil(at / MINUTE_MS) * MINUTE_MS;
  for (let step = 0; step < SEARCH_MINUTES && !inWindow(schedule, at); step++) at += MINUTE_MS;
  return at;
}

/** How a waiting promotion reads on a pre-verification's log: the same line until the schedule changes. */
export const describeSchedule = (schedule: PromotionSchedule) => "at" in schedule
  ? `promotions are batched at ${schedule.at.join(", ")} ${schedule.timeZone}`
  : `promotions are batched every ${schedule.everyMinutes} min from ${schedule.from} until ${schedule.until} ${schedule.timeZone}`;
