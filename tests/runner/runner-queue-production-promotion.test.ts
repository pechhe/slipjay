import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseAlertPayload } from "../../src/lib/runner/runner-types.ts";
import { test, byProject, fixture } from "./fixtures/runner-queue-fixture.ts";

test("a promotion releases only a commit staging deployed, then deploys production from exactly it; a rerun confirm reuses that deploy", async () => {
  const alerts: ReleaseAlertPayload[] = [];
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false, {
    releaseAlertWebhook: { url: "https://example.test/release" },
    sendReleaseAlert: async (_url, payload) => { alerts.push(payload); },
  });
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
    assert.deepEqual(alerts.map(({ timestamp: _timestamp, ...alert }) => alert), [{
      source: "slipjay-runner", repo: "fixture/repo", operationId: refused, headCommitId: red, suites: [],
      logCommand: `slipjay runner log ${refused}`, event: "release_failed", reason: refusal.reason, automatic: false,
    }], "only the release failure alerts, not the failed staging deploy");
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

    // A redeploy (a production deploy no promotion carries) deploys only what production serves when it starts.
    const deployed = (await f.lines("deploys.jsonl")).length;
    const stale = "stale-redeploy";
    f.log.append(stale, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "production", commitId: red, submittedBy: "test" });
    f.queue.wake(); await f.queue.idle();
    const refusedRedeploy = f.result(stale);
    assert.ok(refusedRedeploy?.type === "failed", JSON.stringify(refusedRedeploy));
    assert.equal(refusedRedeploy.reason, `production serves ${green.slice(0, 12)} now, not ${red.slice(0, 12)}: nothing redeployed`);
    assert.equal((await f.lines("deploys.jsonl")).length, deployed, "it ran nothing");
    assert.equal(alerts.length, 2);
    const { timestamp: _timestamp, ...alert } = alerts[1]!;
    assert.deepEqual(alert, {
      source: "slipjay-runner", repo: "fixture/repo", operationId: stale, headCommitId: red, suites: [],
      logCommand: `slipjay runner log ${stale}`, event: "production_deploy_failed", reason: refusedRedeploy.reason,
    });
    const redeploy = "redeploy";
    f.log.append(redeploy, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "production", commitId: green, submittedBy: "test" });
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.result(redeploy)?.type, "deployed", JSON.stringify(f.result(redeploy)));
  } finally { await f.dispose(); }
}, 180_000);

test("a confirm of a commit a later release already shipped deploys nothing: the later release's deploy carries it", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true });
  try {
    await f.land(f.submit(await f.candidate("a.txt")));
    await f.queue.idle();
    const older = f.main();
    await f.land(f.submit(await f.candidate("b.txt")));
    await f.queue.idle();
    const newer = f.main();
    const shipped = f.submitRelease(newer);
    await f.land(shipped);
    await f.queue.idle();
    const first = f.result(shipped);
    assert.ok(first?.type === "released" && first.result.status === "released" && first.deploy, JSON.stringify(first));
    const merge = f.releaseRef();

    const late = f.submitRelease(older);
    await f.land(late);
    await f.queue.idle();
    const outcome = f.result(late);
    assert.ok(outcome?.type === "released" && outcome.result.status === "released_by" && outcome.result.releasedBy === newer, JSON.stringify(outcome));
    assert.equal(outcome.deploy, first.deploy, "it names the deploy that carries it");
    assert.deepEqual(f.log.deployments("fixture/repo", "production").map((entry) => entry.commitId), [newer], "production is not taken back to the older commit");
    assert.equal(f.releaseRef(), merge, "the later release stays on the release branch");
  } finally { await f.dispose(); }
}, 180_000);
