import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "./fixtures/runner-queue-fixture.ts";
import { productionMigrations } from "./fixtures/production-migrations-fixture.ts";

test("production migration verification and health failures activate nothing and return the release branch", async () => {
  const { f, promote, order, first, before } = await productionMigrations();
  try {
    await writeFile(join(f.root, "fail-verify"), "");
    const refused = (await promote(first)).result;
    assert.ok(refused?.type === "failed" && refused.deployment, JSON.stringify(refused));
    assert.deepEqual(refused.deployment.migrations, { artifacts: ["migrations/0001.sql"], status: "verify_failed",
      reason: "verify exited 1: [REDACTED_URL] refused" }, "the database URL never reaches the record");
    assert.match(refused.reason, /^deploy failed: migrations \(verify exited 1: \[REDACTED_URL\] refused\); rolled back: /);
    assert.equal(f.releaseRef(), before, "nothing was applied, so the release branch returns");
    assert.deepEqual(await order(), ["health app", "health hq", "health www", "verify"], "nothing applied or activated");
    await rm(join(f.root, "fail-verify"));

    // A deploy that stopped at a health check never reached the migrations, so the schema is untouched and earlier code still fits it.
    await writeFile(join(f.root, "fail-health-hq"), "");
    const unhealthy = (await promote(first)).result;
    assert.ok(unhealthy?.type === "failed" && unhealthy.deployment, JSON.stringify(unhealthy));
    assert.equal(unhealthy.deployment.migrations, undefined);
    assert.equal(unhealthy.deployment.rollback?.automatic, true, JSON.stringify(unhealthy.deployment.rollback));
    assert.equal(f.releaseRef(), before, "nothing was applied, so the release branch returns");
    assert.ok(!(await order()).includes("verify"), "the migrations were never reached");
    await rm(join(f.root, "fail-health-hq"));

  } finally { await f.dispose(); }
}, 300_000);
