import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "./fixtures/runner-queue-fixture.ts";
import { productionMigrations } from "./fixtures/production-migrations-fixture.ts";

test("additive production migrations apply before the health checks, which need the tables they create", async () => {
  const { f, promote, order, first } = await productionMigrations({ additive: true });
  try {
    await writeFile(join(f.root, "health-needs-schema"), "");
    const applied = await promote(first);
    assert.ok(applied.result?.type === "deployed", JSON.stringify(applied.result));
    assert.deepEqual(applied.result.record.migrations, { artifacts: ["migrations/0001.sql"], status: "applied" });
    assert.deepEqual(await order(), ["verify", "apply", "verify", "health app", "health hq", "health www", "activate app", "activate hq", "activate www"]);

    // Earlier code fits an added schema, so a failed activation after an apply still moves back automatically.
    await f.land(f.submit(await f.candidate("schema/more")));
    await f.queue.idle();
    const served = await readFile(join(f.root, "active-app.txt"), "utf8");
    await writeFile(join(f.root, "fail-activate-hq"), "");
    const stuck = (await promote(f.main())).result;
    assert.ok(stuck?.type === "failed" && stuck.deployment?.migrations?.status === "applied", JSON.stringify(stuck));
    assert.equal(stuck.deployment.rollback?.automatic, true, JSON.stringify(stuck.deployment.rollback));
    assert.equal(await readFile(join(f.root, "active-app.txt"), "utf8"), served, "app serves what it served before");
  } finally { await f.dispose(); }
}, 300_000);

test("additive production migrations that fail leave nothing deployed", async () => {
  const { f, promote, order, first, before } = await productionMigrations({ additive: true });
  try {
    await writeFile(join(f.root, "fail-verify"), "");
    const refused = (await promote(first)).result;
    assert.ok(refused?.type === "failed" && refused.deployment, JSON.stringify(refused));
    assert.equal(refused.deployment.migrations?.status, "verify_failed");
    assert.deepEqual(refused.deployment.projects, []);
    assert.equal(refused.deployment.rollback?.automatic, true, JSON.stringify(refused.deployment.rollback));
    assert.equal(f.releaseRef(), before, "nothing was applied, so the release branch returns");
    assert.deepEqual(await order(), ["verify"]);
    await rm(join(f.root, "fail-verify"));

    await writeFile(join(f.root, "fail-apply"), "");
    const partial = (await promote(first)).result;
    assert.ok(partial?.type === "failed" && partial.deployment?.migrations?.status === "apply_failed", JSON.stringify(partial));
    assert.deepEqual(partial.deployment.projects, []);
    assert.equal(partial.deployment.rollback?.automatic, false, "a part-migrated database is the owner's to decide");
    assert.deepEqual(await order(), ["verify", "apply"]);
  } finally { await f.dispose(); }
}, 300_000);
