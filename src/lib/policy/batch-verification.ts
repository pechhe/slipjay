import { MACHINE_POOL } from "./deployment-policy.ts";

/**
 * `batchVerification` (SJ-192): opt-in batch checks for a `process: "development"` repository. Declared, a landing no
 * longer queues a pre-verification of its own. When a scheduled promotion falls due, the runner freezes the integration
 * head, runs `requiredReleaseVerification` once over the combined change from the commit Production serves to that head,
 * on the build machine of pool `machine` (a boat VM held for this check alone, warmed ahead of the promotion), and
 * promotes only a head whose complete check passed. A red batch is rerun once for flakiness, then diagnosed landing by
 * landing; each culprit is recorded on its own Forge work. Undeclared, the repository behaves as before. Like every
 * promotion setting it is read from the release branch's policy, never from the candidate's.
 */
export type BatchVerification = { machine: string };

/** Validates a declared opt-in; undefined when undeclared. */
export function batchVerification(declared: unknown, fail: (message: string) => never): BatchVerification | undefined {
  if (declared === undefined) return undefined;
  if (declared === null || typeof declared !== "object" || Array.isArray(declared)) fail("batchVerification must be an object");
  const { machine, ...rest } = declared as Record<string, unknown>;
  if (Object.keys(rest).length) fail(`batchVerification declares unknown fields: ${Object.keys(rest).join(", ")}`);
  if (typeof machine !== "string" || !MACHINE_POOL.test(machine)) fail("batchVerification.machine must be a machine pool name (a-z, 0-9, -)");
  return { machine };
}

/**
 * The environment every release verification command is given (batch checks, their reruns and diagnosis, and
 * pre-verifications alike): the exact, immutable base the change is measured from (the commit Production serves, or
 * the release branch when nothing is served yet) and the head being verified. `SLIPJAY_RELEASE_SUITES` narrows a
 * rerun to the named suites of the command's own test-report `outcomes`; absent, the command runs everything.
 */
export const RELEASE_BASE_ENV = "SLIPJAY_RELEASE_BASE";
export const RELEASE_HEAD_ENV = "SLIPJAY_RELEASE_HEAD";
export const RELEASE_SUITES_ENV = "SLIPJAY_RELEASE_SUITES";
export const RELEASE_ENV_KEYS = [RELEASE_BASE_ENV, RELEASE_HEAD_ENV, RELEASE_SUITES_ENV] as const;
