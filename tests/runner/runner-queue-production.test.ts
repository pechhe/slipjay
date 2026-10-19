import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newOperationId } from "../../src/lib/runner/runner-log.ts";
import { test, byProject, fixture } from "./fixtures/runner-queue-fixture.ts";

test("a promotion releases only a commit staging deployed, then deploys production from exactly it; a rerun confirm reuses that deploy", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true });
  try {
    await f.land(f.submit(await f.candidate("a.txt")));
    await f.queue.idle();
    const green = f.main();
    assert.equal(f.log.deployments("fixture/repo", "staging")[0]?.status, "deployed");
    await writeFile(join(f.root, "fail-deploy-app"), "");
    await f.land(f.submit(await f.candidate("b.txt")));
    await f.queue.idle();
    await rm(join(f.root, "fail-deploy-app"));
    const red = f.main();
    assert.equal(f.log.deployments("fixture/repo", "staging")[0]?.status, "failed");
    const base = f.releaseRef();

    const refused = f.submitRelease(red);
    await f.land(refused);
    const refusal = f.result(refused);
    assert.ok(refusal?.type === "failed" && /Staging is not green on/.test(refusal.reason), JSON.stringify(refusal));
    assert.equal(f.releaseRef(), base, "nothing was verified or published");
    assert.deepEqual(f.log.deployments("fixture/repo", "production"), []);

    const promotion = f.submitRelease(green);
    await f.land(promotion);
    await f.queue.idle();
    const outcome = f.result(promotion);
    assert.ok(outcome?.type === "released" && outcome.result.status === "released" && outcome.deploy, JSON.stringify(outcome));
    const [production] = f.log.deployments("fixture/repo", "production");
    assert.equal(production?.id, outcome.deploy);
    assert.equal(production?.submittedBy, `promotion:${promotion}`);
    assert.ok(production?.result?.type === "deployed", JSON.stringify(production?.result));
    assert.equal(production.result.record.commitId, green, "production deploys the staging-verified commit, not the release merge");
    assert.deepEqual(production.result.record.projects.map((project) => project.name), ["app", "hq", "www"]);
    assert.deepEqual(byProject((await f.lines("deploys.jsonl")).map((line) => JSON.parse(line)).filter((entry) => entry.environment === "production")),
      ["app", "hq", "www"].map((project) => ({ project, environment: "production", commit: green, key: "from-runner", head: green })));
    const urls = ["app", "hq", "www"].map((project) => ({ project, url: `https://${project}-${green.slice(0, 7)}.example` }));
    assert.deepEqual(byProject((await f.lines("health.jsonl")).map((line) => JSON.parse(line))), urls, "each deployment is checked");
    assert.deepEqual((await f.lines("activate.jsonl")).map((line) => JSON.parse(line)), urls, "then activated");
    assert.ok(production.result.record.projects.every((project) => project.activated === true));

    const rerun = f.submitRelease(green);
    await f.land(rerun);
    await f.queue.idle();
    const again = f.result(rerun);
    assert.ok(again?.type === "released" && again.result.status === "released_by", JSON.stringify(again));
    assert.equal(again.deploy, outcome.deploy, "a deployed promotion is not deployed twice");
    assert.equal(f.log.deployments("fixture/repo", "production").length, 1);
  } finally { await f.dispose(); }
}, 180_000);

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

for (const scenario of ["first activation", "failed restore", "forbidden compensation", "missing activation URL", "failed pointer return"] as const) {
  test(`production recovery records traffic and release pointer evidence after ${scenario}`, async () => {
    const f = await fixture(false, true, { minIntervalMs: 0, production: true });
    const promote = async (commit: string) => {
      const release = f.submitRelease(commit);
      await f.land(release);
      await f.queue.idle();
      const outcome = f.result(release);
      assert.ok(outcome?.type === "released" && outcome.deploy, JSON.stringify(outcome));
      return f.log.operation(outcome.deploy)!;
    };
    const url = (project: string, commit: string) => `https://${project}-${commit.slice(0, 7)}.example`;
    try {
      await f.land(f.submit(await f.candidate("baseline.txt")));
      await f.queue.idle();
      const baseline = f.main();
      if (scenario !== "first activation") assert.equal((await promote(baseline)).status, "deployed");
      const before = f.releaseRef();
      await f.land(f.submit(await f.candidate("candidate.txt")));
      await f.queue.idle();
      const candidate = f.main();
      const failing = scenario === "first activation" ? "app" : "hq";
      if (scenario === "missing activation URL") await writeFile(join(f.root, "omit-url-www"), "");
      else await writeFile(join(f.root, `fail-activate-${failing}`), "");
      if (scenario === "failed pointer return") await writeFile(join(f.root, "reject-after-restore"), "");
      if (scenario === "failed restore") await writeFile(join(f.root, "fail-restore-hq"), "");
      let authorityBefore = (await f.lines("rollback-authority.jsonl")).length;
      let operation;
      let restrictedMerge: string | undefined;
      if (scenario === "forbidden compensation") {
        // Leave a failed promotion on the release pointer before testing its governed retry.
        await writeFile(join(f.root, "fail-restore-hq"), "");
        assert.equal((await promote(candidate)).status, "failed");
        await rm(join(f.root, "fail-restore-hq"));
        const retainedMerge = f.releaseRef();
        restrictedMerge = retainedMerge;
        authorityBefore = (await f.lines("rollback-authority.jsonl")).length;
        // A retry carries the original migration authority, rather than deriving a new allowance.
        const prior = newOperationId();
        f.log.append(prior, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "production", commitId: candidate, submittedBy: "promotion:test",
          promotion: { merge: retainedMerge, nonAdditiveMigrations: ["migrations/drop.sql"] } });
        f.log.append(prior, { type: "failed", stage: "deploying", reason: "earlier deployment failed" });
        operation = await promote(candidate);
      } else operation = await promote(candidate);
      const result = operation.result;
      assert.ok(result?.type === "failed" && result.deployment, JSON.stringify(result));
      const record = result.deployment;
      if (scenario === "missing activation URL" || scenario === "failed pointer return") {
        assert.equal(record.rollback?.automatic, scenario === "missing activation URL");
        assert.deepEqual(record.projects.map((project) => project.activated), [false, false, false]);
        for (const project of ["app", "hq", "www"])
          assert.equal(await readFile(join(f.root, `active-${project}.txt`), "utf8"), url(project, baseline));
        assert.deepEqual((await f.lines("rollback-authority.jsonl")).slice(authorityBefore).map((line) => JSON.parse(line)), scenario === "missing activation URL" ? [] : [
          { project: "app", allowed: "1", restore: null }, { project: "hq", allowed: "1", restore: null },
          { project: "app", allowed: "1", restore: "1" }, { project: "hq", allowed: "1", restore: "1" },
        ], "only projects whose activation ran are restored");
        if (scenario === "missing activation URL") assert.equal(f.releaseRef(), before);
        else {
          assert.notEqual(f.releaseRef(), before);
          assert.match(result.reason, /rollback incomplete/);
          assert.doesNotMatch(result.reason, /; rolled back:/);
        }
        return;
      }
      assert.equal(record.rollback?.automatic, false);
      assert.equal(record.projects.find((project) => project.name === failing)?.activated, "unknown");
      assert.match(record.projects.find((project) => project.name === failing)?.reason ?? "", /activation failed: exited 6/);
      const attempts = (await f.lines("rollback-authority.jsonl")).slice(authorityBefore).map((line) => JSON.parse(line));
      if (scenario === "first activation") {
        assert.match(record.projects[0]?.reason ?? "", /no earlier deployment is recorded/);
        assert.deepEqual(attempts, [{ project: "app", allowed: "1", restore: null }]);
        assert.deepEqual(await f.lines("active-hq.txt"), []);
        assert.deepEqual(await f.lines("active-www.txt"), []);
      } else {
        assert.equal(record.projects[0]?.activated, scenario === "failed restore" ? false : true);
        assert.equal(await readFile(join(f.root, "active-app.txt"), "utf8"), url("app", scenario === "failed restore" ? baseline : candidate));
        assert.equal(await readFile(join(f.root, "active-www.txt"), "utf8"), url("www", baseline), "later project never moved");
        if (scenario === "failed restore") {
          assert.match(record.projects[1]?.reason ?? "", /could not be moved back: exited 7: hq restore failed/);
          assert.deepEqual(attempts, [
            { project: "app", allowed: "1", restore: null }, { project: "hq", allowed: "1", restore: null },
            { project: "app", allowed: "1", restore: "1" }, { project: "hq", allowed: "1", restore: "1" },
          ]);
        } else assert.deepEqual(attempts, [
          { project: "app", allowed: "0", restore: null }, { project: "hq", allowed: "0", restore: null },
        ], "forbidden compensation makes no recovery calls");
      }
      assert.equal(await readFile(join(f.root, `active-${failing}.txt`), "utf8"), url(failing, candidate), "failure happened after traffic switched");
      if (restrictedMerge) assert.equal(f.releaseRef(), restrictedMerge, "forbidden compensation retains the exact candidate release pointer");
      assert.notEqual(f.releaseRef(), before, "unresolved traffic retains the candidate release pointer");
      assert.equal(f.parents(f.releaseRef()).at(-1), candidate);
      const persisted = f.log.deployments("fixture/repo", "production").find((entry) => entry.id === operation.id)?.result;
      assert.deepEqual(persisted, result, "unknown outcome survives the stored deployment projection");
      assert.doesNotMatch(result.reason, /; rolled back:/);
    } finally { await f.dispose(); }
  }, 180_000);
}

test("a promotion migrates production after every project is healthy and before any activates; a failed verify or apply activates nothing", async () => {
  const f = await fixture(true, true, { minIntervalMs: 0, production: "migrations" });
  const promote = async (commit: string) => {
    const promotion = f.submitRelease(commit);
    await f.land(promotion);
    await f.queue.idle();
    const outcome = f.result(promotion);
    assert.ok(outcome?.type === "released" && outcome.deploy, JSON.stringify(outcome));
    return f.log.operation(outcome.deploy)!;
  };
  // Health checks run side by side, so each unbroken run of them is compared in sorted order.
  const order = async () => {
    const steps = await f.lines("order.log");
    await rm(join(f.root, "order.log"), { force: true });
    return steps.reduce<string[][]>((runs, step) => {
      const last = runs.at(-1);
      if (step.startsWith("health ") && last?.[0]?.startsWith("health ")) last.push(step);
      else runs.push([step]);
      return runs;
    }, []).flatMap((run) => run.sort());
  };
  try {
    // Non-additive, so only a deploy that changed nothing in the schema (a refused first verify, or one that never reached the migrations) is rolled back automatically.
    await f.land(f.submit(await f.candidate("schema/drop")));
    await f.queue.idle();
    const first = f.main();
    const before = f.releaseRef();
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
