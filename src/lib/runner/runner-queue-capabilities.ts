import type { createDeployScheduler } from "../release/deploy-scheduler.ts";
import type { createResetScheduler } from "../release/reset-scheduler.ts";
import type { auditInconclusive, auditSummary, promotionRefusal } from "../release/audit-ledger.ts";
import type { createAuditScheduler } from "../release/audit-scheduler.ts";
import type { runReset } from "../release/reset.ts";
import type { ensureDeployCommit, ensureOnIntegrationBranch, prebuildRelease, runDeploy, schemaMayHaveChanged } from "../release/deploy.ts";
import type { confirmRelease, passedVerification, planRelease, returnRelease, unverifiedCandidateReason, verifyRelease } from "../release/release.ts";
import type { boundedKeys, boundedOutput, boundedTests, flakyVerifies, PREBUILD_KEY, runBatchCheck } from "../release/batch-check.ts";
import type { machineBuildLease, machineConnections, machineVerification } from "./machine-verifier.ts";
import type { hostMachine, openHostAttempt } from "./host-verifier.ts";

export type DeployCapability = {
  createDeployScheduler: typeof createDeployScheduler;
  ensureDeployCommit: typeof ensureDeployCommit;
  ensureOnIntegrationBranch: typeof ensureOnIntegrationBranch;
  prebuildRelease: typeof prebuildRelease;
  runDeploy: typeof runDeploy;
  schemaMayHaveChanged: typeof schemaMayHaveChanged;
};

export type ReleaseCapability = {
  confirmRelease: typeof confirmRelease;
  passedVerification: typeof passedVerification;
  planRelease: typeof planRelease;
  returnRelease: typeof returnRelease;
  unverifiedCandidateReason: typeof unverifiedCandidateReason;
  verifyRelease: typeof verifyRelease;
};

export type BatchCapability = {
  boundedKeys: typeof boundedKeys;
  boundedOutput: typeof boundedOutput;
  boundedTests: typeof boundedTests;
  flakyVerifies: typeof flakyVerifies;
  PREBUILD_KEY: typeof PREBUILD_KEY;
  runBatchCheck: typeof runBatchCheck;
};

export type MaintenanceCapability = {
  createResetScheduler: typeof createResetScheduler;
  runReset: typeof runReset;
  createAuditScheduler: typeof createAuditScheduler;
  auditInconclusive: typeof auditInconclusive;
  auditSummary: typeof auditSummary;
  promotionRefusal: typeof promotionRefusal;
};

export type VerifierCapability = {
  machineBuildLease: typeof machineBuildLease;
  machineConnections: typeof machineConnections;
  machineVerification: typeof machineVerification;
  hostMachine: typeof hostMachine;
  openHostAttempt: typeof openHostAttempt;
  isHostCapacityUnavailable: (error: unknown) => boolean;
};

/** Optional runner queue subsystems supplied by `runner-service.ts` (or focused test fixtures). */
export type QueueCapabilities = {
  deploy?: DeployCapability;
  release?: ReleaseCapability;
  batch?: BatchCapability;
  maintenance?: MaintenanceCapability;
  verifiers?: VerifierCapability;
};
