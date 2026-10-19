import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newOperationId } from "../../src/lib/runner/runner-log.ts";
import { test, fixture } from "./fixtures/runner-queue-fixture.ts";

test("a promotion that fails its health check activates nothing and returns the release branch; one whose activation fails moves the activated projects back", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true });
  const activations = async () => (await f.lines("activate.jsonl")).map((line) => JSON.parse(line) as { project: string; url: string });
  const url = (project: string, commit: string) => `https://${project}-${commit.slice(0, 7)}.example`;
  const promote = async (commit: string) => {
    const promotion = f.submitRelease(commit);
    await f.land(promotion);
    await f.queue.idle();
    const outcome = f.result(promotion);
    assert.ok(outcome?.type === "released" && outcome.deploy, JSON.stringify(outcome));
    return f.log.operation(outcome.deploy)!;
  };
  try {
    await f.land(f.submit(await f.candidate("a.txt")));
    await f.queue.idle();
    const first = f.main();
    // The first promotion has no earlier deployment to move app back to.
    await writeFile(join(f.root, "fail-activate-hq"), "");
    const incomplete = (await promote(first)).result;
    assert.ok(incomplete?.type === "failed", JSON.stringify(incomplete));
    assert.match(incomplete.reason, /rollback incomplete/);
    assert.match(incomplete.reason, /app.*no earlier deployment is recorded/);
    assert.match(incomplete.reason, /hq.*no earlier deployment is recorded/);
    assert.ok(incomplete.deployment);
    assert.equal(incomplete.deployment.rollback?.automatic, false);
    assert.deepEqual(incomplete.deployment.projects.map(({ name, activated }) => [name, activated]),
      [["app", true], ["hq", "unknown"], ["www", false]]);
    assert.equal(await readFile(join(f.root, "active-hq.txt"), "utf8"), url("hq", first));
    assert.deepEqual(await f.lines("active-www.txt"), [], "later unattempted project is unchanged");
    assert.deepEqual((await f.lines("rollback-authority.jsonl")).map((line) => JSON.parse(line)), [
      { project: "app", allowed: "1", restore: null }, { project: "hq", allowed: "1", restore: null },
    ], "first activation receives runner authority despite declared spoofed environment key");
    const merge = f.releaseRef();
    assert.deepEqual(f.parents(merge).at(-1), first, "production partly serves the release, so the release branch keeps it");
    await rm(join(f.root, "fail-activate-hq"));

    // A rerun confirm of a promotion that carried a non-additive migration keeps that restriction.
    const original = newOperationId();
    f.log.append(original, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "production", commitId: first, submittedBy: "promotion:test",
      promotion: { merge, nonAdditiveMigrations: ["migrations/0002.sql"] } });
    f.log.append(original, { type: "failed", stage: "deploying", reason: "an earlier failure" });
    await writeFile(join(f.root, "fail-health-app"), "");
    const held = await promote(first);
    assert.deepEqual(held.kind === "deploy" && held.promotion, { merge, nonAdditiveMigrations: ["migrations/0002.sql"] });
    assert.ok(held.result?.type === "failed" && held.result.deployment?.rollback?.automatic === false, JSON.stringify(held.result));
    assert.match(held.result.reason, /not rolled back automatically, because the promotion carries non-additive migrations \(migrations\/0002\.sql\): the owner decides$/);
    assert.equal(f.releaseRef(), merge, "the release branch is left where it was");
    await rm(join(f.root, "fail-health-app"));
    assert.equal((await promote(first)).status, "deployed");
    assert.deepEqual((await f.lines("rollback-authority.jsonl")).slice(2).map((line) => JSON.parse(line)), [
      { project: "app", allowed: "0", restore: null }, { project: "hq", allowed: "0", restore: null }, { project: "www", allowed: "0", restore: null },
    ], "non-additive promotion denies downstream compensation despite spoofed environment value");

    await f.land(f.submit(await f.candidate("b.txt")));
    await f.queue.idle();
    const second = f.main();
    const before = f.releaseRef();
    await writeFile(join(f.root, "fail-health-hq"), "");
    const unhealthy = await promote(second);
    const failure = unhealthy.result;
    assert.ok(failure?.type === "failed" && failure.deployment, JSON.stringify(failure));
    assert.match(failure.reason, /^deploy failed: hq \(health check failed: exited 6: hq health failed\); rolled back: production serves what it served before, and the release branch is back on /);
    assert.deepEqual(failure.deployment.rollback, { automatic: true, releaseBranch: before, reason: failure.deployment.rollback?.reason });
    assert.equal(f.releaseRef(), before, "the release branch matches what production serves");
    assert.equal((await activations()).length, 4, "nothing was activated");
    assert.ok(failure.deployment.projects.every((project) => project.activated === false));

    await rm(join(f.root, "fail-health-hq"));
    await writeFile(join(f.root, "fail-activate-www"), "");
    const partial = await promote(second);
    const moved = partial.result;
    assert.ok(moved?.type === "failed" && moved.deployment, JSON.stringify(moved));
    assert.match(moved.reason, /www \(activation failed: exited 6: www activate failed\); rolled back/);
    assert.deepEqual((await activations()).slice(4), [
      { project: "app", url: url("app", second) }, { project: "hq", url: url("hq", second) },
      { project: "app", url: url("app", first), restore: true }, { project: "hq", url: url("hq", first), restore: true }, { project: "www", url: url("www", first), restore: true },
    ], "app and hq moved to the new deployment and back to the one they served before");
    assert.deepEqual((await f.lines("rollback-authority.jsonl")).slice(5).map((line) => JSON.parse(line)), [
      { project: "app", allowed: "1", restore: null }, { project: "hq", allowed: "1", restore: null }, { project: "www", allowed: "1", restore: null },
      { project: "app", allowed: "1", restore: "1" }, { project: "hq", allowed: "1", restore: "1" }, { project: "www", allowed: "1", restore: "1" },
    ], "ordinary activation and compensation receive runner permission, with restore separately marked");
    assert.deepEqual(moved.deployment.projects.map(({ name, activated, restored }) => [name, activated, restored ?? false]),
      [["app", false, true], ["hq", false, true], ["www", false, true]]);
    assert.equal(moved.deployment.rollback?.automatic, true);
    for (const project of ["app", "hq", "www"])
      assert.equal(await readFile(join(f.root, `active-${project}.txt`), "utf8"), url(project, first), "actual traffic pointer returned");
    assert.equal(f.releaseRef(), before);
  } finally { await f.dispose(); }
}, 300_000);
