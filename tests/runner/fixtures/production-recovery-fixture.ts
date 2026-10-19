import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newOperationId } from "../../../src/lib/runner/runner-log.ts";
import { fixture } from "./runner-queue-fixture.ts";

export async function productionRecovery(scenario: "first activation" | "failed restore" | "forbidden compensation" | "missing activation URL" | "failed pointer return") {
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
}
