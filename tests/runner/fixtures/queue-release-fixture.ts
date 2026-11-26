import { deployCapability } from "../../../src/lib/runner/queue-deploy-capability.ts";
import { releaseCapability } from "../../../src/lib/runner/queue-release-capability.ts";
import { fixtureWith } from "./runner-queue-fixture.ts";

export * from "./runner-queue-fixture.ts";
export const fixture = fixtureWith({ deploy: deployCapability, release: releaseCapability });
