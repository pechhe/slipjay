import { createDeployScheduler } from "../release/deploy-scheduler.ts";
import { ensureDeployCommit, ensureOnIntegrationBranch, prebuildRelease, runDeploy, schemaMayHaveChanged } from "../release/deploy.ts";
import type { DeployCapability } from "./runner-queue-capabilities.ts";

export const deployCapability: DeployCapability = {
  createDeployScheduler,
  ensureDeployCommit,
  ensureOnIntegrationBranch,
  prebuildRelease,
  runDeploy,
  schemaMayHaveChanged,
};
