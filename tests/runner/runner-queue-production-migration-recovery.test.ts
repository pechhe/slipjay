import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newOperationId } from "../../src/lib/runner/runner-log.ts";
import { test } from "./fixtures/runner-queue-fixture.ts";
import { productionMigrations } from "./fixtures/production-migrations-fixture.ts";

test("production retains a migrated release after activation failure or an interrupted deployment", async () => {
  const { f, promote, first } = await productionMigrations();
  try {
    assert.equal((await promote(first)).status, "deployed");
    // Applied, then an activation fails: the earlier code may not run on the migrated schema, so nothing moves back.
    await f.land(f.submit(await f.candidate("schema/more")));
    await f.queue.idle();
    const merged = f.releaseRef();
    await writeFile(join(f.root, "fail-activate-hq"), "");
    const stuck = (await promote(f.main())).result;
    assert.ok(stuck?.type === "failed" && stuck.deployment?.migrations?.status === "applied", JSON.stringify(stuck));
    assert.equal(stuck.deployment.rollback?.automatic, false);
    assert.match(stuck.reason, /not rolled back automatically, because the promotion carries non-additive migrations \(migrations\/0002\.sql\): the owner decides$/);
    assert.notEqual(f.releaseRef(), merged, "the release branch keeps the release");
    await rm(join(f.root, "fail-activate-hq"));

    // A restart cut a deploy of the commit short and left no record, so a rerun that fails before the migrations still cannot say the schema is untouched.
    await f.land(f.submit(await f.candidate("schema/third")));
    await f.queue.idle();
    const third = f.main();
    const cut = newOperationId();
    f.log.append(cut, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "production", commitId: third, submittedBy: "promotion:test" });
    f.log.append(cut, { type: "stage", stage: "deploying" });
    await f.queue.recover();
    assert.match(f.result(cut)?.type === "failed" ? (f.result(cut) as { reason: string }).reason : "", /runner restarted during deploying; deploy again with slipjay promote --confirm/);
    await writeFile(join(f.root, "fail-health-hq"), "");
    const afterRestart = (await promote(third)).result;
    assert.ok(afterRestart?.type === "failed" && afterRestart.deployment, JSON.stringify(afterRestart));
    assert.equal(afterRestart.deployment.migrations, undefined);
    assert.equal(afterRestart.deployment.rollback?.automatic, false, JSON.stringify(afterRestart.deployment.rollback));
  } finally { await f.dispose(); }
}, 300_000);
