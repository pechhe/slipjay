import { createHash } from "node:crypto";
import { repositoryKey } from "./runner-contract.ts";
import type { LandingOperation, OperationEvent, OperationLog, SubmitRequest } from "./runner-contract.ts";

export type RepairProof = { operationId: string; claimId: string; token: string };
export type RepairClaim = Extract<OperationEvent, { type: "repair_claimed" }> & { operationId: string };
export const repairTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const validRepairProof = (v: unknown): v is RepairProof => v !== null && typeof v === "object"
  && Object.keys(v).length === 3 && ["operationId", "claimId", "token"].every((key) => typeof (v as Record<string, unknown>)[key] === "string") && (v as RepairProof).operationId.length > 0 && (v as RepairProof).operationId.length <= 128
  && /^[a-zA-Z0-9_-]{1,128}$/.test((v as RepairProof).claimId) && /^[a-f0-9]{64}$/.test((v as RepairProof).token);

/** A logical change's write fence outlives followers and any individual retry. */
export function repairAuthority(log: OperationLog, repo: string, changeId: string): { claimed: boolean; active: RepairClaim | null } {
  const operations = log.operationsForChange(repositoryKey(repo), changeId);
  const history = operations.flatMap((op) => log.events({ operationId: op.id })).sort((a, b) => a.seq - b.seq);
  const last = history.findLast((row) => row.event.type === "repair_claimed");
  if (last?.event.type !== "repair_claimed") return { claimed: false, active: null };
  const event = last.event;
  const closed = history.some((row) => row.seq > last.seq && (row.event.type === "landed"
    || row.event.type === "repair_released" && row.event.claimId === event.claimId));
  return { claimed: true, active: closed ? null : { ...event, operationId: last.operationId } };
}

export function repairEligibility(log: OperationLog, operation: LandingOperation): string | null {
  if (log.paused()) return "Runner is paused; no repair was admitted";
  if (log.operationsForChange(operation.repo, operation.changeId)[0]?.id !== operation.id) return "A newer attempt owns this logical change";
  if (operation.status !== "failed" || operation.outcome?.publication.state !== "not-attempted") return "Reconcile publication or owner controls before source repair";
  if (operation.outcome.sourceRetention?.commitId !== operation.commitId) return "No durable retained source acknowledgement";
  if (operation.outcome.evidenceExpired) return "Retained source expired under the runner's retention policy";
  if (!["gate", "conflict"].includes(operation.outcome.classification?.cause ?? "")) return "Only a confirmed pre-publication gate or conflict failure accepts a coding repair claim";
  if (operation.runs.some((run) => ["migration_generate", "migration_verify", "finalization"].includes(run.purpose ?? ""))) return "Migration/finalisation evidence requires existing reconciliation";
  return null;
}

export function repairAdmission(log: OperationLog, request: SubmitRequest): string | null {
  const authority = repairAuthority(log, request.repo, request.changeId);
  if (!authority.claimed && !request.repair) return null;
  const claim = authority.active, proof = request.repair;
  if (!claim || !proof || proof.operationId !== claim.operationId || proof.claimId !== claim.claimId || repairTokenHash(proof.token) !== claim.tokenSha256)
    return "Repair ownership changed or is missing; obtain the current repair claim before submitting source";
  if (log.paused()) return "Runner is paused; no repaired source was admitted";
  return null;
}

export function publicRepairClaim(claim: RepairClaim | null): Omit<RepairClaim, "tokenSha256" | "type"> | null {
  if (!claim) return null;
  const { tokenSha256: _token, type: _type, ...view } = claim;
  return view;
}
