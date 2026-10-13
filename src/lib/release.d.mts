import type { GraphqlRunner, HalfBuiltSpecs } from "./release-specs.mjs";
import type { VerificationDeclaration } from "./verification-policy.mjs";

export type ReleasePlan = {
  root: string;
  integrationRoot: string;
  remote: string;
  integrationBranch: string;
  releaseBranch: string;
  /** The release branch on the remote. */
  base: string;
  /** The integration commit being released. */
  candidate: string;
  commits: Array<{ commitId: string; subject: string; description: string }>;
  migrationArtifacts: string[];
  checks: VerificationDeclaration[];
};

export type ReleaseSummary = {
  integrationBranch: string;
  releaseBranch: string;
  remote: string;
  base: string;
  candidate: string;
  commits: number;
  migrationArtifacts: string[];
  checks: string[];
  /** Open Specs with Tickets in the range; absent when the range is empty. */
  halfBuiltSpecs?: HalfBuiltSpecs;
};

/** The outcome of a repository's declared `postRelease` step for one release. */
export type PostReleaseOutcome = {
  ok: boolean;
  status: "running" | "failed" | "complete";
  target?: string;
  candidate: string;
  /** Null only when the merge that shipped the candidate could not be read. */
  merge: string | null;
  /** The integration commit whose exact source the step ran in. */
  source?: string;
  attempt?: number;
  reason?: string;
  /** The command that reruns a step that did not complete. */
  retry?: string;
};

/** Present after a confirmed release, or a confirm that retried a pending step. */
type PostReleaseField = { postRelease?: PostReleaseOutcome };
/** Present on a plan while the target's latest post-release step did not complete. */
type PendingPostReleaseField = { pendingPostRelease?: PostReleaseOutcome };

export type ReleaseResult =
  | ({ ok: true; status: "up_to_date" } & ReleaseSummary & PostReleaseField & PendingPostReleaseField)
  | ({ ok: true; status: "planned"; subjects: string[]; next: string } & ReleaseSummary & PendingPostReleaseField)
  | ({ ok: true; status: "released"; merge: string; verification: unknown; releasedAt: string } & ReleaseSummary & PostReleaseField)
  /**
   * The release branch already contains the candidate: a release this one waited
   * for shipped it, so it verified nothing. `merge` is the release merge that
   * first contained it and `releasedBy` that merge's candidate. Without such a
   * merge (the branch was moved outside `slipjay release`), `merge` is the
   * release branch head and `releasedBy` null. The summary describes the plan
   * against that head, so `commits` is 0.
   */
  | ({ ok: true; status: "released_by"; merge: string; releasedBy: string | null } & ReleaseSummary & PostReleaseField)
  | { ok: false; status: "refused"; reason: string }
  | { ok: false; status: "verification_failed"; reason: string; evidence: unknown };

export function planRelease(cwd?: string, options?: { candidate?: string }): Promise<ReleasePlan>;
export function releaseIntegration(
  cwd?: string,
  options?: { confirm?: string; migrationsReady?: boolean; onProgress?: (line: string) => void; graphql?: GraphqlRunner },
): Promise<ReleaseResult>;
