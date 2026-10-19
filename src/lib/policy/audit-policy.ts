import type { VerificationDeclaration } from "./verification-policy.ts";

/**
 * `audit`: the nightly complete-suite audit. The runner runs `commands`, in full, on the exact integration-branch
 * head every day at `timeOfDay` in `timeZone`. The commands take the shape of `requiredLandingVerification`
 * entries but are their own list: an audit never borrows the landing gate's, which may skip or reuse work.
 */
export type AuditPolicy = {
  commands: VerificationDeclaration[];
  /** Wall-clock `HH:MM`, 24-hour. */
  timeOfDay: string;
  /** An IANA time zone name. */
  timeZone: string;
};

export const DEFAULT_AUDIT_TIME = "02:00";
export const DEFAULT_AUDIT_TIME_ZONE = "Europe/London";

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Whether the runtime knows `name` as a time zone. */
export function knownTimeZone(name: string): boolean {
  try { new Intl.DateTimeFormat("en-GB", { timeZone: name }); return true; } catch { return false; }
}

/**
 * Parse the policy's `audit` declaration; null when undeclared. `checks` validates the command list as the policy
 * validates its other gate declarations, and `fail` reports a violation under the policy's own name.
 */
export function auditPolicy(value: unknown, { checks, fail }: {
  checks: (value: unknown, name: string) => VerificationDeclaration[];
  fail: (message: string) => never;
}): AuditPolicy | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("declares an audit that is not an object");
  const row = value as Record<string, unknown>;
  const unknown = Object.keys(row).filter((key) => !["commands", "timeOfDay", "timeZone"].includes(key));
  if (unknown.length) fail(`declares audit fields it does not know: ${unknown.join(", ")}`);
  // An audit with nothing to run would read as green.
  if (!Array.isArray(row.commands) || !row.commands.length) fail("audit.commands must list at least one command: an audit that runs nothing would pass");
  const timeOfDay = row.timeOfDay ?? DEFAULT_AUDIT_TIME;
  if (typeof timeOfDay !== "string" || !TIME_OF_DAY.test(timeOfDay)) fail('audit.timeOfDay must be a 24-hour "HH:MM" time');
  const timeZone = row.timeZone ?? DEFAULT_AUDIT_TIME_ZONE;
  if (typeof timeZone !== "string" || !knownTimeZone(timeZone)) fail("audit.timeZone must be an IANA time zone name, such as Europe/London");
  return { commands: checks(row.commands, "audit.commands"), timeOfDay: timeOfDay as string, timeZone: timeZone as string };
}
