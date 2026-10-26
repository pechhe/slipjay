import type { VerificationOperation } from "../runner/runner-types.ts";
import type { RequiredVerificationFailureEvidence } from "../infra/verification-evidence.ts";

/**
 * What changed since the candidate the owner last approved, when the candidate has
 * moved past it without that approval shipping (a fix landed after verification
 * failed): the next ask shows only this.
 */
export type PromotionDelta = {
  since: string;
  commits: Array<{ commitId: string; subject: string }>;
  paths: string[];
  migrationArtifacts: string[];
};

/**
 * What the runner knows of a promotion: the newest commit staging is green on, the
 * candidates approved before, and its pre-verifications, each newest first.
 */
export type PromotionState = { stagingGreen: string | null; approved: string[]; verifications: VerificationOperation[];
  /** Every commit staging recorded a green deploy of, newest first; absent from a runner that does not list them (then only `stagingGreen`). */
  stagingGreenCommits?: string[];
  /** Why the audits refuse a promotion (see `promotionRefusal`), or null; absent from a runner that does not audit. */
  auditRefusal?: string | null };

/**
 * The candidate's pre-verification, as its newest pre-verification that was not
 * superseded or cancelled reports it. `passed` only for one against the plan's base
 * with the plan's checks, which a confirm reuses; a pass against anything else is `none`.
 */
export type ReleaseVerificationState = {
  status: "passed" | "failed" | "running" | "queued" | "none";
  commit: string;
  operationId: string | null;
  failedCommand?: string;
};

/**
 * Whether the owner's approval of `approvedCandidate`, which has not shipped, covers
 * this candidate: only when the changes since it add or change no migration artifact
 * and every commit among them names no work item, or only items the approved range
 * already names (`Build: #N` and `Issue:` trailers). `reasons` names each rule that
 * failed. Anything SlipJay cannot establish leaves it uncovered.
 */
export type ApprovalCoverage = { approvedCandidate: string | null; covered: boolean; reasons: string[] };

export type ReleaseSummary = {
  integrationBranch: string;
  releaseBranch: string;
  remote: string;
  base: string;
  candidate: string;
  commits: number;
  migrationArtifacts: string[];
  nonAdditiveMigrations: string[];
  paths: string[];
  checks: string[];
  /** Present when the candidate moved past an earlier approval that did not ship. */
  delta?: PromotionDelta;
};

/** What a promotion's plan adds: its candidate's pre-verification, and whether an earlier approval covers it. */
export type PromotionPlan = { verification?: ReleaseVerificationState; approval?: ApprovalCoverage;
  /** `requested` when `--candidate` chose an older staging-green commit; `newerGreen` then names the newer green commits it leaves out, newest first. */
  candidateSource?: "newest_green" | "requested"; newerGreen?: string[] };

export type ReleaseResult =
  | ({ ok: true; status: "up_to_date" } & ReleaseSummary & PromotionPlan)
  | ({ ok: true; status: "planned"; subjects: string[]; next: string } & ReleaseSummary & PromotionPlan)
  /** `verification` names the reused pre-verification as `preverified` when the confirm ran no checks of its own. */
  | ({ ok: true; status: "released"; merge: string; verification: unknown; releasedAt: string } & ReleaseSummary)
  /**
   * The release branch already contains the candidate (an earlier or newer
   * release shipped it), so the confirm verified nothing. `merge` is the release merge that first contained
   * it and `releasedBy` that merge's candidate. Without such a merge (the branch
   * was moved outside `slipjay promote`), `merge` is the release branch head and
   * `releasedBy` null. The summary describes the plan against that head, so
   * `commits` is 0.
   */
  | ({ ok: true; status: "released_by"; merge: string; releasedBy: string | null } & ReleaseSummary)
  | { ok: false; status: "refused"; reason: string }
  | { ok: false; status: "verification_failed"; reason: string; evidence: RequiredVerificationFailureEvidence };
