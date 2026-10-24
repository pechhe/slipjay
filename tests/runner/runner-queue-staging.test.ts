import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newOperationId } from "../../src/lib/runner/runner-log.ts";
import { test, byProject, fixture, until, stagesOf, deployStep } from "./fixtures/runner-queue-fixture.ts";

test("a landing deploys staging from an exact view of the landed commit and records it; the next records the changes since", async () => {
  const f = await fixture(false, false, { minIntervalMs: 0 });
  try {
    const a = await f.land(f.submit(await f.candidate("a.txt")));
    assert.ok(a?.type === "landed");
    assert.deepEqual([a.repo, a.declaredEnvironments], ["fixture/repo", ["staging"]], "the landing records what its commit declares, for Build");
    await f.queue.idle();
    const [first] = f.log.deployments("fixture/repo", "staging");
    assert.equal(first?.status, "deployed", JSON.stringify(first?.result));
    assert.ok(first?.result?.type === "deployed");
    const firstRecord = first.result.record;
    assert.equal(firstRecord.commitId, f.main());
    assert.equal(firstRecord.previous, null);
    assert.deepEqual(firstRecord.changes.map((change) => change.subject), ["Add a.txt"]);
    assert.deepEqual(firstRecord.projects, ["app", "hq"].map((name) => ({ name, ok: true, url: `https://${name}-${f.main().slice(0, 7)}.example` })));
    assert.deepEqual(byProject((await f.lines("deploys.jsonl")).map((line) => JSON.parse(line))), ["app", "hq"].map((project) =>
      ({ project, environment: "staging", commit: f.main(), key: "from-runner", head: f.main() })), "each project ran in the exact commit with the declared key");
    assert.deepEqual(first.runs.map((run) => run.exitCode), [0, 0]);
    const deployCommands = new Set(["app", "hq"].map((name) => ["node", "-e", deployStep(f.root, name)].join(" ")));
    const deployRequests = f.requestedTimeouts.filter((request) => deployCommands.has(request.command));
    assert.equal(deployRequests.length, 2);
    assert.deepEqual(deployRequests.map((request) => request.timeoutMs), [30_000, 30_000]);
    for (const run of first.runs) {
      assert.equal(run.timeoutMs, 30_000);
      assert.equal(run.commandEvidence?.status, "recorded");
    }
    await writeFile(join(f.root, "fail-deploy-hq"), "");
    await f.land(f.submit(await f.candidate("b.txt")));
    await f.land(f.submit(await f.candidate("c.txt")));
    await f.queue.idle();
    const deploys = f.log.deployments("fixture/repo", "staging");
    const latest = deploys[0]!;
    assert.equal(latest.commitId, f.main(), "the latest landing is deployed");
    assert.ok(latest.result?.type === "failed" && latest.result.deployment);
    assert.equal(latest.result.reason, "deploy failed: hq (exited 5: hq build failed)");
    // The landing of b deployed app but not hq: staging served b, so c's changes start there.
    assert.equal(latest.result.deployment.previous, deploys[1]!.commitId);
    assert.notEqual(deploys[1]!.commitId, firstRecord.commitId);
    assert.ok(latest.result.deployment.changes.map((change) => change.subject).includes("Add c.txt"));
    assert.deepEqual(latest.result.deployment.projects.map((project) => [project.name, project.ok]), [["app", true], ["hq", false]]);
    assert.match(latest.result.deployment.projects[1]!.reason!, /exited 5: hq build failed/);
    await rm(join(f.root, "fail-deploy-hq"));
    await f.land(f.submit(await f.candidate("d.txt")));
    await f.queue.idle();
    const next = f.log.deployments("fixture/repo", "staging")[0]!;
    assert.ok(next.result?.type === "deployed", JSON.stringify(next.result));
    assert.equal(next.result.record.previous, latest.commitId, "a deploy that reached some projects is what the environment served");
    // A commit that never landed is refused before any project runs.
    const unlanded = await f.candidate("e.txt");
    const refused = newOperationId();
    f.log.append(refused, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "staging", commitId: unlanded.commitId, submittedBy: "test" });
    f.queue.wake(); await f.queue.idle();
    const outcome = f.result(refused);
    assert.ok(outcome?.type === "failed" && !outcome.deployment, JSON.stringify(outcome));
    assert.match(outcome.reason, /is not on main; only landed commits deploy/);
  } finally { await f.dispose(); }
}, 120_000);

test("a green staging deploy pre-verifies its commit, a landing that arrives neither stops it nor waits for it, and a confirm of it publishes without verifying again", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true });
  try {
    const verifications = () => f.log.verifications("fixture/repo");
    const releaseChecks = async () => (await f.lines("release-verified.log")).length;
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    await f.queue.idle();
    const [first] = verifications();
    assert.ok(first?.result?.type === "verified", JSON.stringify(first));
    assert.equal(first.commitId, f.main());
    assert.equal(first.result.base, f.releaseRef());
    assert.equal(await releaseChecks(), 1, "it ran the release checks");
    assert.equal(f.releaseRef(), first.result.base, "and published nothing");

    // b's pre-verification is running when a landing arrives: both run, and c's green deploy then queues its own.
    await rm(join(f.root, "release-started"));
    await writeFile(join(f.root, "hold-release"), "");
    f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "release-started")).then(() => true, () => undefined));
    const beside = verifications()[0]!;
    assert.equal(beside.status, "running");
    const c = f.submit(await f.candidate("c.txt"));
    f.queue.wake();
    await until(() => f.result(c));
    assert.equal(f.result(c)?.type, "landed", "the landing did not wait for the pre-verification");
    assert.equal(f.log.operation(beside.id)?.status, "running", "and did not stop it");
    await until(() => verifications().length === 3 || undefined);
    await rm(join(f.root, "hold-release"));
    await f.queue.idle();
    assert.ok(!f.log.events({ operationId: beside.id }).some((stored) => stored.event.type === "yielded"));
    assert.equal(f.log.operation(beside.id)?.status, "verified", "it ran to its end");
    const latest = verifications()[0]!;
    assert.ok(latest.result?.type === "verified", JSON.stringify(latest.result));
    assert.equal(latest.commitId, f.main());

    const checksBefore = await releaseChecks();
    const promotion = f.submitRelease(latest.commitId);
    await f.land(promotion);
    await f.queue.idle();
    const outcome = f.result(promotion);
    assert.ok(outcome?.type === "released" && outcome.result.status === "released", JSON.stringify(outcome));
    assert.deepEqual(outcome.result.verification, { preverified: latest.id });
    assert.equal(await releaseChecks(), checksBefore, "the confirm ran no release check");
    assert.ok(!stagesOf(f, promotion).includes("verifying"));
    assert.deepEqual(f.parents(f.releaseRef()), [latest.result.base, latest.commitId]);
  } finally { await f.dispose(); }
}, 180_000);

test("a confirm of a commit waits for its running pre-verification and reuses its pass, and one that passed is verified again when staging redeploys it", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true });
  try {
    // A's landing is setup no assertion reads: seed the commit, then deploy it for real so staging is green on it
    // and its pre-verification passes. The landings it bypasses are covered by the cases `seedMain` lists; C still
    // lands end to end below.
    const seeded = await f.seedMain({ "a.txt": "a.txt\n" });
    const staged = await f.deploy(seeded);
    const deployed = f.result(staged);
    assert.ok(deployed?.type === "deployed", JSON.stringify(deployed));
    assert.equal(deployed.record.commitId, seeded, "staging deployed the seeded commit");
    await f.queue.idle();
    const a = f.main();
    const [preverified] = f.log.verifications("fixture/repo");
    assert.equal(preverified?.commitId, a, "the seeded staging deploy was pre-verified");
    assert.equal(f.log.verifications("fixture/repo")[0]?.status, "verified");
    // Staging deploys a again: its pass may be against a release base that has moved, so it is verified again.
    const redeploy = newOperationId();
    f.log.append(redeploy, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "staging", commitId: a, submittedBy: "test" });
    f.queue.wake(); await f.queue.idle();
    assert.deepEqual(f.log.verifications("fixture/repo").map((entry) => [entry.commitId, entry.status]), [[a, "verified"], [a, "verified"]]);

    await rm(join(f.root, "release-started"));
    await writeFile(join(f.root, "hold-release"), "");
    f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "release-started")).then(() => true, () => undefined));
    const running = f.log.verifications("fixture/repo")[0]!;
    const promotion = f.submitRelease(running.commitId);
    const c = f.submit(await f.candidate("c.txt"));
    f.queue.wake();
    await until(() => f.result(c));
    assert.equal(f.result(c)?.type, "landed");
    assert.equal(f.log.operation(running.id)?.status, "running", "it kept running beside the landing");
    assert.ok(!f.log.events({ operationId: running.id }).some((stored) => stored.event.type === "yielded"));
    await rm(join(f.root, "hold-release"));
    await f.queue.idle();
    const outcome = f.result(promotion);
    assert.ok(outcome?.type === "released" && outcome.result.status === "released", JSON.stringify(outcome));
    assert.deepEqual(outcome.result.verification, { preverified: running.id });
  } finally { await f.dispose(); }
}, 180_000);

test("a pre-verification holds its worker until it ends, and another repository's landing waits for it instead of stopping it", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false, { workers: 1, other: true });
  try {
    // A is setup: seed it and deploy it for real, so its staging deploy and pre-verification still run. B and the
    // other repository land for real below; the landings `seedMain` lists stay end to end.
    const seeded = await f.seedMain({ "a.txt": "a.txt\n" });
    const staged = await f.deploy(seeded);
    const deployed = f.result(staged);
    assert.ok(deployed?.type === "deployed", JSON.stringify(deployed));
    assert.equal(deployed.record.commitId, seeded, "staging deployed the seeded commit");
    await f.queue.idle();
    const [preverified] = f.log.verifications("fixture/repo");
    assert.equal(preverified?.commitId, seeded, "the seeded staging deploy was pre-verified");
    assert.equal(preverified?.status, "verified", JSON.stringify(preverified?.result));
    await rm(join(f.root, "release-started"));
    await writeFile(join(f.root, "hold-release"), "");
    f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "release-started")).then(() => true, () => undefined));
    const held = f.log.verifications("fixture/repo")[0]!;
    const other = f.submit(await f.candidate("other.txt", f.otherAuthor, "fixture/other"));
    f.queue.wake();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.log.operation(other)?.status, "queued", "the one worker is held, so concurrency stays bounded");
    assert.equal(f.log.operation(held.id)?.status, "running");
    await rm(join(f.root, "hold-release"));
    await f.queue.idle();
    assert.equal(f.result(other)?.type, "landed", JSON.stringify(f.result(other)));
    assert.equal(f.log.operation(held.id)?.status, "verified");
    assert.ok(!f.log.events({ operationId: held.id }).some((stored) => stored.event.type === "yielded"));
  } finally { await f.dispose(); }
}, 180_000);

test("recovery queues the pre-verification a green staging deploy recorded just before a restart never queued", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true });
  try {
    // A is setup no assertion of its landing reads: seed it and deploy it for real, so its staging deploy is green
    // and its pre-verification passes. The landings it bypasses are covered by the cases `seedMain` lists.
    const seededA = await f.seedMain({ "a.txt": "a.txt\n" });
    const stagedA = await f.deploy(seededA);
    const deployed = f.result(stagedA);
    assert.ok(deployed?.type === "deployed", JSON.stringify(deployed));
    assert.equal(deployed.record.commitId, seededA, "staging deployed the seeded commit");
    await f.queue.idle();
    const [green] = f.log.deployments("fixture/repo", "staging");
    assert.ok(green?.result?.type === "deployed");
    assert.equal(green?.commitId, seededA);
    // b is setup too: seed it and deploy it for real, so its staging deploy fails and nothing pre-verifies it; then the
    // log is made to say it went green, as a deploy recorded just before a restart would.
    await writeFile(join(f.root, "fail-deploy-app"), "");
    const seededB = await f.seedMain({ "b.txt": "b.txt\n" });
    const stagedB = await f.deploy(seededB);
    const failed = f.result(stagedB);
    assert.ok(failed?.type === "failed" && failed.stage === "deploying", JSON.stringify(failed));
    assert.equal(failed.deployment?.commitId, seededB, "its staging deploy ran in the seeded commit");
    assert.equal(failed.reason, "deploy failed: app (exited 5: app build failed)", "the deploy reached its projects");
    assert.deepEqual(failed.deployment?.projects.map((project) => [project.name, project.ok]), [["app", false], ["hq", true]]);
    await f.queue.idle();
    await rm(join(f.root, "fail-deploy-app"));
    const b = f.main();
    assert.equal(b, seededB);
    assert.deepEqual(f.log.verifications("fixture/repo").map((entry) => entry.commitId), [green.commitId]);
    const recorded = newOperationId();
    f.log.append(recorded, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "staging", commitId: b, submittedBy: "test" });
    f.log.append(recorded, { type: "deployed", record: { ...green.result.record, commitId: b } });
    await f.queue.recover();
    await f.queue.idle();
    const [latest] = f.log.verifications("fixture/repo");
    assert.equal(latest?.commitId, b);
    assert.equal(latest?.status, "verified", JSON.stringify(latest?.result));
    await f.queue.recover();
    assert.equal(f.log.verifications("fixture/repo").length, 2, "a second recovery queues nothing more");
  } finally { await f.dispose(); }
}, 180_000);

test("within the interval a landing does not deploy, and recovery fails a deploy interrupted by a restart", async () => {
  const f = await fixture(false, false, { minIntervalMs: 3_600_000 });
  try {
    await f.land(f.submit(await f.candidate("a.txt")));
    await f.queue.idle();
    await f.land(f.submit(await f.candidate("b.txt")));
    await f.queue.idle();
    assert.equal(f.log.deployments("fixture/repo").length, 1, "the second landing waits for the hour");
    const interrupted = newOperationId();
    f.log.append(interrupted, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "staging", commitId: f.main(), submittedBy: "test" });
    f.log.append(interrupted, { type: "stage", stage: "deploying" });
    await f.queue.recover();
    assert.equal(f.result(interrupted)?.type, "failed");
    assert.match(f.result(interrupted)!.type === "failed" ? (f.result(interrupted) as { reason: string }).reason : "", /runner restarted during deploying; deploy again with slipjay deploy staging/);
    const production = newOperationId();
    f.log.append(production, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "production", commitId: f.main(), submittedBy: "promotion:test" });
    f.log.append(production, { type: "stage", stage: "deploying" });
    await f.queue.recover();
    const outcome = f.result(production);
    assert.ok(outcome?.type === "failed" && outcome.reason.endsWith(`deploy again with slipjay promote --confirm ${f.main().slice(0, 12)}`), JSON.stringify(outcome));
  } finally { await f.dispose(); }
}, 120_000);
