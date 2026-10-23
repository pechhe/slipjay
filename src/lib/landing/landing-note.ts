import type { LandingOutcome } from "../runner/runner-types.ts";

/**
 * What `slipjay land` says after a landing Build records as a chore, and nothing for a landing under a Spec. The chore
 * belongs to no Spec, so attaching it is the author's decision, made with Build's own action: `land` prints no more than that.
 */
export function choreLandingNote(build: LandingOutcome["build"], landedCommitId: string, operationId: string): string | null {
  if (build?.admission !== "unassociated") return null;
  const revision = landedCommitId.slice(0, 12);
  return build.chore
    ? `landed ${revision} as a chore: Build #${build.chore.number} is in no Spec; attach it with hq_forge_associate_landing`
    : `landed ${revision} as a chore, in no Spec; attach it with hq_forge_associate_landing (Build has not recorded the chore's number yet: slipjay runner outcome ${operationId} shows it once it has)`;
}
