import { createResetScheduler } from "../release/reset-scheduler.ts";
import { runReset } from "../release/reset.ts";
import { createAuditScheduler } from "../release/audit-scheduler.ts";
import { auditInconclusive, auditSummary, promotionRefusal } from "../release/audit-ledger.ts";
import type { MaintenanceCapability } from "./runner-queue-capabilities.ts";

export const maintenanceCapability: MaintenanceCapability = {
  createResetScheduler,
  runReset,
  createAuditScheduler,
  auditInconclusive,
  auditSummary,
  promotionRefusal,
};
