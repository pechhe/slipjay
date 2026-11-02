import { knownTimeZone } from "./audit-policy.ts";

/**
 * `promotionSchedule`: when a `process: "development"` runner may promote by itself. Undeclared, it promotes each
 * pre-verified landing as soon as it can. Declared, it promotes at most once every `everyMinutes`, and only while the
 * repository's local time (`timeZone`) is from `from` until `until`, so landings between promotions ship together.
 * An owner's `slipjay promote --confirm` is never held by it, and counts as the latest promotion.
 */
export type PromotionSchedule = { everyMinutes: number; from: string; until: string; timeZone: string };

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;
/** The longest a window can stay closed: a day, plus an hour for a daylight-saving change. */
const SEARCH_MINUTES = 25 * 60;

const minutesOf = (clock: string) => {
  const [, hours, minutes] = CLOCK.exec(clock)!;
  return Number(hours) * 60 + Number(minutes);
};

/** Validates a declared schedule; undefined when undeclared. */
export function promotionSchedule(declared: unknown, fail: (message: string) => never): PromotionSchedule | undefined {
  if (declared === undefined) return undefined;
  if (declared === null || typeof declared !== "object" || Array.isArray(declared)) fail("promotionSchedule must be an object");
  const { everyMinutes, from, until, timeZone, ...rest } = declared as Record<string, unknown>;
  if (Object.keys(rest).length) fail(`promotionSchedule declares unknown fields: ${Object.keys(rest).join(", ")}`);
  if (!Number.isInteger(everyMinutes) || (everyMinutes as number) < 1 || (everyMinutes as number) > 1440) fail("promotionSchedule.everyMinutes must be an integer from 1 to 1440");
  for (const [name, value] of [["from", from], ["until", until]] as const)
    if (typeof value !== "string" || !CLOCK.test(value)) fail(`promotionSchedule.${name} must be a 24-hour HH:MM time`);
  if (from === until) fail("promotionSchedule.from and until must differ");
  // An empty zone would silently read the runner host's own zone.
  if (typeof timeZone !== "string" || !timeZone.trim()) fail("promotionSchedule.timeZone must be an IANA time zone");
  if (!knownTimeZone(timeZone)) fail(`promotionSchedule.timeZone ${timeZone} is not a known time zone`);
  return { everyMinutes: everyMinutes as number, from: from as string, until: until as string, timeZone: timeZone as string };
}

/** Whether `at` falls in the window: from `from` (inclusive) until `until` (exclusive), crossing midnight when `until` is earlier. */
export function inWindow(schedule: PromotionSchedule, at: number): boolean {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: schedule.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const local = Number(parts.find((part) => part.type === "hour")!.value) * 60 + Number(parts.find((part) => part.type === "minute")!.value);
  const from = minutesOf(schedule.from), until = minutesOf(schedule.until);
  return from < until ? local >= from && local < until : local >= from || local < until;
}

/**
 * The earliest time a scheduled promotion may start: `now` when it may start now, otherwise the later of
 * `everyMinutes` after `lastPromotedAt` and the window's next opening. Minute steps keep it right across
 * daylight-saving changes.
 */
export function nextPromotionAt(schedule: PromotionSchedule, lastPromotedAt: number | undefined, now: number): number {
  let at = Math.max(now, lastPromotedAt === undefined ? now : lastPromotedAt + schedule.everyMinutes * MINUTE_MS);
  if (inWindow(schedule, at)) return at;
  at = Math.ceil(at / MINUTE_MS) * MINUTE_MS;
  for (let step = 0; step < SEARCH_MINUTES && !inWindow(schedule, at); step++) at += MINUTE_MS;
  return at;
}

/** How a waiting promotion reads on a pre-verification's log: the same line until the schedule changes. */
export const describeSchedule = (schedule: PromotionSchedule) =>
  `promotions are batched every ${schedule.everyMinutes} min from ${schedule.from} until ${schedule.until} ${schedule.timeZone}`;
