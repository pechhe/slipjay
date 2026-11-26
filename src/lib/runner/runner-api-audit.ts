import { attributedCause, auditSummary, auditToExplain, resolveCulprits } from "../release/audit-ledger.ts";
import { promotionState } from "./runner-promotion.ts";

export type RunnerAuditApi = {
  attributedCause: typeof attributedCause;
  auditSummary: typeof auditSummary;
  auditToExplain: typeof auditToExplain;
  resolveCulprits: typeof resolveCulprits;
  promotionState: typeof promotionState;
};

export const runnerAuditApi: RunnerAuditApi = {
  attributedCause,
  auditSummary,
  auditToExplain,
  resolveCulprits,
  promotionState,
};
