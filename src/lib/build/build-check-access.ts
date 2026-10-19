import { createHash, randomBytes } from "node:crypto";
import { RUNNER_API } from "../runner/runner-contract.ts";
import { readAdmittedItems } from "./build-admission.ts";
import type { BuildAdmittedItems } from "./build-admission.ts";
import type { BuildBinding } from "../landing/submission-handoff.ts";
import type { BuildReader } from "./tracker.ts";

/** A Build-bound landing's admitted binding, as JSON, for its repository's checks. */
export const BUILD_CONTEXT_ENV = "SLIPJAY_BUILD_CONTEXT";
/** Where a check in a Build-tracked repository reads Build: the runner's `/v1/build/read`. */
export const BUILD_READ_URL_ENV = "SLIPJAY_BUILD_READ_URL";
/** The bearer token for `BUILD_READ_URL_ENV`, good for one operation's checks only. */
export const BUILD_READ_TOKEN_ENV = "SLIPJAY_BUILD_READ_TOKEN";

export type BuildCheckAccess = ReturnType<typeof createBuildCheckAccess>;

/**
 * Read-only Build access for repository checks. Each operation gets its own random token, which reaches only the
 * runner's Build read route and stops working when the operation revokes it; the runner's own token and its Build
 * credential never leave the runner. Tokens live only in memory, so a restart ends them all.
 */
export function createBuildCheckAccess() {
  const live = new Set<string>();
  const digest = (token: string) => createHash("sha256").update(token).digest("hex");
  let url: string | undefined;
  return {
    /** The runner serves at `baseUrl`; until then no access is granted. */
    serve(baseUrl: string): void { url = new URL(`${RUNNER_API}/build/read`, baseUrl).toString(); },
    /** A fresh token and the environment that hands it to checks, or null before the runner serves. */
    grant(): { token: string; environment: Record<string, string> } | null {
      if (!url) return null;
      const token = randomBytes(32).toString("hex");
      live.add(digest(token));
      return { token, environment: { [BUILD_READ_URL_ENV]: url, [BUILD_READ_TOKEN_ENV]: token } };
    },
    revoke(token: string): void { live.delete(digest(token)); },
    /** Whether `authorization` carries a token granted and not yet revoked. */
    admits(authorization: string | null): boolean {
      const token = /^Bearer ([0-9a-f]{64})$/.exec(authorization ?? "")?.[1];
      return token !== undefined && live.has(digest(token));
    },
  };
}

/**
 * `BUILD_CONTEXT_ENV` for an admitted binding, with the item numbers its admission recorded. An admission recorded
 * before they were read has them read from Build now, which throws unless Build answers.
 */
export async function buildCheckContext(binding: BuildBinding, items: BuildAdmittedItems | undefined, read: BuildReader): Promise<string> {
  const { specNumber, ticketNumbers } = items ?? await readAdmittedItems(read, binding.specId, binding.ticketIds);
  return JSON.stringify({ version: 1, specId: binding.specId, specNumber, ticketNumbers, sessionId: binding.sessionId });
}
