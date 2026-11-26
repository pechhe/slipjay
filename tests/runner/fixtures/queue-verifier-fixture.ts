import { deployCapability } from "../../../src/lib/runner/queue-deploy-capability.ts";
import { maintenanceCapability } from "../../../src/lib/runner/queue-maintenance-capability.ts";
import { verifierCapability } from "../../../src/lib/runner/queue-verifier-capability.ts";
import { fixtureWith } from "./runner-queue-fixture.ts";

export * from "./runner-queue-fixture.ts";
export const fixture = fixtureWith({ deploy: deployCapability, maintenance: maintenanceCapability, verifiers: verifierCapability });
