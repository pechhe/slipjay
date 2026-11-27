import { createBatchOrchestrator } from "./queue-batch-orchestrator.ts";
import type { BatchCapability } from "./runner-queue-capabilities.ts";

export const batchCapability: BatchCapability = {
  createBatchOrchestrator,
};
