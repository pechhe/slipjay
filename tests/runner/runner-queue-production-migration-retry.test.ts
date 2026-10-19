import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "./fixtures/runner-queue-fixture.ts";
import { productionMigrations } from "./fixtures/production-migrations-fixture.ts";

test("production migration apply failures retain authority through retries until the schema is current", async () => {
  const { f, promote, order, first } = await productionMigrations();
  try {
    await writeFile(join(f.root, "fail-apply"), "");
    const partial = await promote(first);
    assert.ok(partial.result?.type === "failed" && partial.result.deployment?.migrations?.status === "apply_failed", JSON.stringify(partial.result));
    assert.match(partial.result.reason, /not rolled back automatically, because applying the migrations failed and the database may be partly migrated: the owner decides$/);
    const merge = f.releaseRef();
    assert.equal(f.parents(merge).at(-1), first, "the release branch keeps the release");
    assert.deepEqual(await order(), ["health app", "health hq", "health www", "verify", "apply"]);
    await rm(join(f.root, "fail-apply"));

    // A rerun that stops before the migrations still follows an earlier deploy of the commit that part-applied them.
    await writeFile(join(f.root, "fail-health-hq"), "");
    const rerun = (await promote(first)).result;
    assert.ok(rerun?.type === "failed" && rerun.deployment, JSON.stringify(rerun));
    assert.equal(rerun.deployment.migrations, undefined);
    assert.equal(rerun.deployment.rollback?.automatic, false, JSON.stringify(rerun.deployment.rollback));
    assert.equal(f.releaseRef(), merge, "the release branch keeps the release");
    await rm(join(f.root, "fail-health-hq"));
    await order();

    const applied = await promote(first);
    assert.ok(applied.result?.type === "deployed", JSON.stringify(applied.result));
    assert.deepEqual(applied.result.record.migrations, { artifacts: ["migrations/0001.sql"], status: "applied" }, "the rerun confirm keeps the promotion's migrations");
    assert.deepEqual(await order(), ["health app", "health hq", "health www", "verify", "apply", "verify", "activate app", "activate hq", "activate www"]);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, "production-db.json"), "utf8")), ["0001.sql"]);

    await f.land(f.submit(await f.candidate("b.txt")));
    await f.queue.idle();
    const current = await promote(f.main());
    assert.ok(current.result?.type === "deployed", JSON.stringify(current.result));
    assert.deepEqual(current.result.record.migrations, { artifacts: [], status: "current" }, "a promotion without migrations still verifies production");
    assert.deepEqual((await order()).filter((step) => !step.includes(" ")), ["verify"]);

  } finally { await f.dispose(); }
}, 300_000);
