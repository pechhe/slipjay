import { boundedKeys, boundedOutput, boundedTests, flakyVerifies, PREBUILD_KEY, runBatchCheck } from "../release/batch-check.ts";
import type { BatchCapability } from "./runner-queue-capabilities.ts";

export const batchCapability: BatchCapability = {
  boundedKeys,
  boundedOutput,
  boundedTests,
  flakyVerifies,
  PREBUILD_KEY,
  runBatchCheck,
};
