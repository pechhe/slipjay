import type { AuditPolicy } from "../policy/audit-policy.ts";

/**
 * Wall-clock arithmetic for the nightly audit: the scheduled instants of "HH:MM in a time zone", which follow
 * the zone's clock across daylight saving rather than a fixed number of hours.
 */
type Day = { year: number; month: number; day: number };
type Schedule = Pick<AuditPolicy, "timeOfDay" | "timeZone">;

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(instant: number, timeZone: string): Record<string, number> {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(timeZone, format);
  }
  return Object.fromEntries(format.formatToParts(new Date(instant)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

/** The zone's offset from UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const local = parts(instant, timeZone);
  return Date.UTC(local.year!, local.month! - 1, local.day!, local.hour!, local.minute!, local.second!) - Math.floor(instant / 1000) * 1000;
}

const dayOf = (instant: number, timeZone: string): Day => {
  const local = parts(instant, timeZone);
  return { year: local.year!, month: local.month!, day: local.day! };
};
const addDays = ({ year, month, day }: Day, days: number): Day => {
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
};

/**
 * The instant the zone's clock reads `timeOfDay` on `day`. A time the clock repeats (the hour it goes back) is
 * the first reading; one it skips (the hour it goes forward) is the same reading after the gap, so the audit still
 * runs once that day.
 */
function instantOn(day: Day, timeOfDay: string, timeZone: string): number {
  const [hour, minute] = timeOfDay.split(":").map(Number) as [number, number];
  const wall = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
  const offsets = [...new Set([offsetAt(wall - 86_400_000, timeZone), offsetAt(wall + 86_400_000, timeZone)])];
  const readings = offsets.map((offset) => wall - offset).filter((instant) => offsetAt(instant, timeZone) === wall - instant);
  // Skipped: the earlier offset's reading falls after the gap.
  return readings.length ? Math.min(...readings) : wall - Math.min(...offsets);
}

/** The latest scheduled instant at or before `now`. */
export function latestAuditSlot(now: number, { timeOfDay, timeZone }: Schedule): number {
  const today = dayOf(now, timeZone);
  const slot = instantOn(today, timeOfDay, timeZone);
  return slot <= now ? slot : instantOn(addDays(today, -1), timeOfDay, timeZone);
}

/** The first scheduled instant after `now`. */
export function nextAuditSlot(now: number, { timeOfDay, timeZone }: Schedule): number {
  const today = dayOf(now, timeZone);
  const slot = instantOn(today, timeOfDay, timeZone);
  return slot > now ? slot : instantOn(addDays(today, 1), timeOfDay, timeZone);
}
