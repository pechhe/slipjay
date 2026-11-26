import { confirmRelease, passedVerification, planRelease, returnRelease, unverifiedCandidateReason, verifyRelease } from "../release/release.ts";
import type { ReleaseCapability } from "./runner-queue-capabilities.ts";

export const releaseCapability: ReleaseCapability = {
  confirmRelease,
  passedVerification,
  planRelease,
  returnRelease,
  unverifiedCandidateReason,
  verifyRelease,
};
