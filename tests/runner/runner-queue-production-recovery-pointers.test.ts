import { test } from "./fixtures/runner-queue-fixture.ts";
import { productionRecovery } from "./fixtures/production-recovery-fixture.ts";

for (const scenario of ["missing activation URL", "failed pointer return"] as const) {
  test(`production recovery records traffic and release pointer evidence after ${scenario}`, async () => {
    await productionRecovery(scenario);
  }, 180_000);
}
