import { test } from "./fixtures/queue-release-fixture.ts";
import { productionRecovery } from "./fixtures/production-recovery-fixture.ts";

for (const scenario of ["first activation", "failed restore", "forbidden compensation"] as const) {
  test(`production recovery records traffic and release pointer evidence after ${scenario}`, async () => {
    await productionRecovery(scenario);
  }, 180_000);
}
