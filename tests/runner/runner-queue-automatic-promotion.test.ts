import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newOperationId } from "../../src/lib/runner/runner-log.ts";
import { test, fixture, jj, until } from "./fixtures/runner-queue-fixture.ts";

const REPO = "fixture/repo";
const settle = async (f: Awaited<ReturnType<typeof fixture>>) => { f.queue.wake(); await f.queue.idle(); await f.queue.idle(); };

test("process development promotes a green, pre-verified commit by itself and records why", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false, { process: "development" });
  try {
    const before = f.releaseRef();
    await f.land(f.submit(await f.candidate("a.txt")));
    await settle(f);
    const green = f.main();
    const [release, ...others] = f.log.releases(REPO);
    assert.equal(others.length, 0);
    assert.equal(release?.commitId, green);
    assert.deepEqual(release?.automatic, { setting: "process", value: "development" });
    assert.match(release!.submittedBy, /:automatic$/);
    assert.ok(release?.result?.type === "released" && release.result.deploy, JSON.stringify(release?.result));
    assert.notEqual(f.releaseRef(), before);
    assert.ok(f.log.events({ operationId: release.id }).some((stored) => stored.event.type === "progress" && /automatically: process is "development"/.test(stored.event.line)));
    const [production] = f.log.deployments(REPO, "production");
    assert.equal(production?.id, release.result.deploy);
    assert.ok(production?.result?.type === "deployed", JSON.stringify(production?.result));
    assert.deepEqual(production.promotion?.automatic, { setting: "process", value: "development" });
    assert.equal(f.log.verifications(REPO)[0]?.status, "verified", "it reused the pre-verification");
    assert.deepEqual(f.log.deployments(REPO, "staging"), [], "development has no staging deploy");
    const landed = f.log.events({}).map((stored) => stored.event).find((event) => event.type === "landed");
    assert.ok(landed?.type === "landed" && landed.process === "development" && landed.declaredEnvironments && !landed.declaredEnvironments.includes("staging"), JSON.stringify(landed));

    // Idempotent: asking again, or a restart, releases nothing twice.
    await f.queue.recover();
    await settle(f);
    assert.equal(f.log.releases(REPO).length, 1);
    assert.equal(f.log.deployments(REPO, "production").length, 1);

    // The next green candidate is promoted on its own.
    await f.land(f.submit(await f.candidate("b.txt")));
    await settle(f);
    assert.deepEqual(f.log.releases(REPO).map((entry) => entry.commitId), [f.main(), green]);
    assert.ok(f.log.releases(REPO)[0]?.result?.type === "released");
  } finally { await f.dispose(); }
}, 240_000);

for (const level of [undefined, "standard", "light"]) {
  test(`process ${level ?? "(default)"} never promotes without a human confirm`, async () => {
    const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false, level ? { process: level } : {});
    try {
      const before = f.releaseRef();
      const landed = await f.land(f.submit(await f.candidate("a.txt")));
      assert.ok(landed?.type === "landed" && landed.process === "standard");
      await settle(f);
      assert.equal(f.log.verifications(REPO)[0]?.status, "verified", "pre-verification still passes");
      assert.deepEqual(f.log.releases(REPO), []);
      assert.deepEqual(f.log.deployments(REPO, "production"), []);
      assert.ok(f.log.deployments(REPO, "staging").length > 0, "outside development a landing still deploys staging");
      assert.equal(f.releaseRef(), before);
      const confirm = f.submitRelease(f.main());
      await f.land(confirm);
      await f.queue.idle();
      const outcome = f.result(confirm);
      assert.ok(outcome?.type === "released", JSON.stringify(outcome));
      assert.equal(f.log.releases(REPO)[0]?.automatic, undefined);
    } finally { await f.dispose(); }
  }, 240_000);
}

test("development leaves a candidate unpromoted when verification failed", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false, { process: "development" });
  try {
    const before = f.releaseRef();
    await writeFile(join(f.root, "fail-release"), "");
    await f.land(f.submit(await f.candidate("a.txt")));
    await settle(f);
    assert.equal(f.log.verifications(REPO)[0]?.status, "failed");
    assert.deepEqual(f.log.releases(REPO), []);
    assert.equal(f.releaseRef(), before);
    assert.ok(f.log.events({ operationId: f.log.verifications(REPO)[0]!.id }).some((stored) => stored.event.type === "progress" && /Not promoting .* automatically: its pre-verification failed/.test(stored.event.line)));
    await rm(join(f.root, "fail-release"));
    // A newer green candidate is retried and promoted.
    await f.land(f.submit(await f.candidate("b.txt")));
    await settle(f);
    assert.deepEqual(f.log.releases(REPO).map((entry) => entry.commitId), [f.main()]);
  } finally { await f.dispose(); }
}, 240_000);

test("development leaves a candidate with non-additive migrations for the owner", async () => {
  const f = await fixture(true, true, { minIntervalMs: 0, production: "migrations" }, false, { process: "development" });
  try {
    const before = f.releaseRef();
    await f.land(f.submit(await f.candidate("schema/drop")));
    await settle(f);
    assert.equal(f.log.verifications(REPO)[0]?.status, "verified");
    assert.deepEqual(f.log.releases(REPO), []);
    assert.equal(f.releaseRef(), before);
    assert.deepEqual(f.log.deployments(REPO, "production"), []);
    assert.ok(f.log.events({ operationId: f.log.verifications(REPO)[0]!.id }).some((stored) => stored.event.type === "progress" && /non-additive migrations/.test(stored.event.line)));
    assert.deepEqual(f.log.deployments(REPO, "staging"), [], "it was never rehearsed on staging");
    // A human's confirm is not the runner's own promotion: it still needs the staging deploy that development mode skipped.
    const confirm = f.submitRelease(f.main());
    await f.land(confirm);
    await f.queue.idle();
    const outcome = f.result(confirm);
    assert.ok(outcome?.type === "failed" && /Staging is not green/.test(outcome.reason), JSON.stringify(outcome));
  } finally { await f.dispose(); }
}, 240_000);

const openAuditFailure = (f: Awaited<ReturnType<typeof fixture>>) => {
  const audit = newOperationId();
  f.log.append(audit, { type: "submitted", kind: "audit", repo: REPO, commitId: "0".repeat(40), slot: new Date().toISOString(), submittedBy: "test" });
  f.log.append(audit, { type: "failed", stage: "verifying", reason: "the suite is broken" });
};

test("an audit refusal is read from the release base, so a candidate cannot remove its own safeguard", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false, { process: "development", failingAudit: true });
  try {
    const before = f.releaseRef();
    openAuditFailure(f);
    // The candidate drops `audit` from its own policy.
    jj(f.author, ["new", "main@origin"]);
    const policy = JSON.parse(await readFile(join(f.author, "slipjay.json"), "utf8")) as Record<string, unknown>;
    delete policy.audit;
    await writeFile(join(f.author, "slipjay.json"), JSON.stringify(policy));
    jj(f.author, ["describe", "-m", "Drop audit"]);
    await f.land(f.submit(await f.push()));
    await settle(f);
    assert.equal(f.log.verifications(REPO)[0]?.status, "verified");
    assert.deepEqual(f.log.releases(REPO), []);
    assert.equal(f.releaseRef(), before);
    assert.ok(f.log.events({ operationId: f.log.verifications(REPO)[0]!.id }).some((stored) => stored.event.type === "progress" && /latest audit failed/.test(stored.event.line)));
  } finally { await f.dispose(); }
}, 240_000);

const queuedAutomatic = (f: Awaited<ReturnType<typeof fixture>>, commitId: string) => {
  const id = newOperationId();
  f.log.append(id, { type: "submitted", kind: "release", repo: REPO, commitId, migrationsReady: false, submittedBy: "test:automatic", automatic: { setting: "process", value: "development" } });
  return id;
};

test("a queued automatic release of an older candidate never ships; the newer green candidate is submitted and released", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false, { process: "development" });
  try {
    // A is green but its pre-verification failed, so it stays unpromoted. Its landing is setup no assertion
    // reads, so seed the commit and deploy it for real; the landings it bypasses are covered by the cases
    // `seedMain` lists.
    await writeFile(join(f.root, "fail-release"), "");
    const seeded = await f.seedMain({ "a.txt": "a.txt\n" });
    const staged = await f.deploy(seeded);
    const deployed = f.result(staged);
    assert.ok(deployed?.type === "deployed", JSON.stringify(deployed));
    assert.equal(deployed.record.commitId, seeded, "the queue deployed the seeded commit");
    await settle(f);
    const older = f.main();
    const [failed] = f.log.verifications(REPO);
    assert.equal(failed?.commitId, seeded, "the seeded commit's staging deploy was pre-verified");
    assert.equal(failed?.status, "failed", JSON.stringify(failed?.result));
    assert.deepEqual(f.log.releases(REPO), []);
    await rm(join(f.root, "fail-release"));
    // An automatic release of A is still in the queue when B turns green.
    const stale = queuedAutomatic(f, older);
    await f.land(f.submit(await f.candidate("b.txt")));
    await settle(f);
    const state = f.log.operation(stale)?.status;
    assert.ok(state === "superseded" || state === "failed", `stale release is ${state}`);
    const [newest, ...rest] = f.log.releases(REPO).filter((entry) => entry.id !== stale);
    assert.equal(rest.length, 0);
    assert.equal(newest?.commitId, f.main());
    assert.ok(newest?.result?.type === "released", JSON.stringify(newest?.result));
    assert.ok(!f.log.deployments(REPO, "production").some((entry) => entry.commitId === older), "the older candidate never reached production");
  } finally { await f.dispose(); }
}, 240_000);

test("an automatic release refuses once its commit is no longer the newest green candidate", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false, { process: "development" });
  try {
    // Both commits are setup: seed them in turn and deploy each for real, so both staging deploys and both
    // failed pre-verifications still run. The landings they bypass are covered by the cases `seedMain` lists.
    await writeFile(join(f.root, "fail-release"), "");
    const a = await f.seedMain({ "a.txt": "a.txt\n" });
    const stagedA = await f.deploy(a);
    const older = f.main();
    const b = await f.seedMain({ "b.txt": "b.txt\n" });
    const stagedB = await f.deploy(b);
    await settle(f);
    const deployedA = f.result(stagedA);
    assert.ok(deployedA?.type === "deployed", JSON.stringify(deployedA));
    assert.equal(deployedA.record.commitId, a, "the queue deployed A's seeded commit");
    const deployedB = f.result(stagedB);
    assert.ok(deployedB?.type === "deployed", JSON.stringify(deployedB));
    assert.equal(deployedB.record.commitId, b, "the queue deployed B's seeded commit");
    assert.deepEqual(f.log.verifications(REPO).map((entry) => [entry.commitId, entry.status]), [[b, "failed"], [a, "failed"]],
      "both seeded staging deploys were pre-verified, and both pre-verifications failed");
    await rm(join(f.root, "fail-release"));
    const stale = queuedAutomatic(f, older);
    await settle(f);
    const outcome = f.result(stale);
    assert.ok(outcome?.type === "failed" && /superseded by/.test(outcome.reason), JSON.stringify(outcome));
    assert.deepEqual(f.log.deployments(REPO, "production"), []);
  } finally { await f.dispose(); }
}, 240_000);

const landed = async (f: Awaited<ReturnType<typeof fixture>>, name: string) => {
  const id = f.submit(await f.candidate(name));
  f.queue.wake();
  await until(() => f.result(id));
  assert.equal(f.result(id)?.type, "landed");
};

// A lands while its pre-verification is held; B lands and is staged behind it, so A is verified while B is still unverified.
const landBehindHeldVerification = async (f: Awaited<ReturnType<typeof fixture>>, landB = true) => {
  await writeFile(join(f.root, "hold-release"), "");
  await landed(f, "a.txt");
  const a = f.main();
  await until(async () => await readFile(join(f.root, "release-started")).then(() => true, () => undefined));
  if (landB) {
    await landed(f, "b.txt");
    await until(() => f.log.verifications(REPO).length === 2 || undefined);
  }
  return a;
};

test("a verified commit is promoted while a newer green commit has no passed verification, as long as it is the newest that has one", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false, { process: "development" });
  try {
    const a = await landBehindHeldVerification(f);
    const b = f.main();
    // B's pre-verification will fail when it starts, after A's finishes.
    await writeFile(join(f.root, "fail-release"), "");
    await rm(join(f.root, "hold-release"));
    await settle(f);
    assert.deepEqual(f.log.verifications(REPO).map((entry) => [entry.commitId, entry.status]), [[b, "failed"], [a, "verified"]]);
    assert.deepEqual(f.log.releases(REPO).map((entry) => entry.commitId), [a], "the older verified commit shipped");
    assert.ok(f.log.releases(REPO)[0]?.result?.type === "released", JSON.stringify(f.log.releases(REPO)[0]?.result));
    assert.deepEqual(f.log.deployments(REPO, "production").map((entry) => entry.commitId), [a]);
    assert.ok(f.log.events({ operationId: f.log.verifications(REPO)[0]!.id }).some((stored) => stored.event.type === "progress" && /Not promoting .* automatically: its pre-verification failed/.test(stored.event.line)));
  } finally { await f.dispose(); }
}, 240_000);

test("a newer commit that passes replaces the verified older one a release was queued for", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false, { process: "development" });
  try {
    const a = await landBehindHeldVerification(f);
    const b = f.main();
    await rm(join(f.root, "hold-release"));
    await settle(f);
    assert.deepEqual(f.log.verifications(REPO).map((entry) => [entry.commitId, entry.status]), [[b, "verified"], [a, "verified"]]);
    const released = f.log.releases(REPO).filter((entry) => entry.result?.type === "released");
    assert.deepEqual(released.map((entry) => entry.commitId), [b], "only the newest verified commit shipped");
    assert.ok(!f.log.deployments(REPO, "production").some((entry) => entry.commitId === a), "the older commit never reached production");
  } finally { await f.dispose(); }
}, 240_000);

test("a queued automatic release of a verified commit survives a newer staged commit whose verification then fails", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true }, false, { process: "development" });
  try {
    const a = await landBehindHeldVerification(f, false);
    // The release of A waits in the release queue behind A's held verification when B is staged.
    const queued = queuedAutomatic(f, a);
    await landed(f, "b.txt");
    assert.equal(f.log.operation(queued)?.status, "queued", "staging B does not replace it");
    await writeFile(join(f.root, "fail-release"), "");
    await rm(join(f.root, "hold-release"));
    await settle(f);
    assert.equal(f.log.verifications(REPO).find((entry) => entry.commitId === f.main())?.status, "failed");
    assert.ok(f.result(queued)?.type === "released", JSON.stringify(f.result(queued)));
    assert.deepEqual(f.log.deployments(REPO, "production").map((entry) => entry.commitId), [a]);
  } finally { await f.dispose(); }
}, 240_000);

test("development without a release branch records and applies the same no-staging path", async () => {
  const f = await fixture(false, false, { minIntervalMs: 0 }, false, { process: "development" });
  try {
    const landed = await f.land(f.submit(await f.candidate("source-only.txt")));
    await settle(f);
    assert.ok(landed?.type === "landed" && landed.process === "development");
    assert.deepEqual(landed.declaredEnvironments, []);
    assert.deepEqual(f.log.deployments(REPO, "staging"), []);
    assert.deepEqual(f.log.releases(REPO), []);
  } finally { await f.dispose(); }
}, 120_000);

test("a candidate cannot select development mode by dropping the repository release branch", async () => {
  const f = await fixture(false, true, { minIntervalMs: 0, production: true });
  try {
    await f.candidate("keep-staging.txt");
    const path = join(f.author, "slipjay.json");
    const policy = JSON.parse(await readFile(path, "utf8"));
    delete policy.releaseBranch;
    delete policy.requiredReleaseVerification;
    policy.process = "development";
    await writeFile(path, JSON.stringify(policy));
    const landed = await f.land(f.submit(await f.push()));
    await settle(f);
    assert.ok(landed?.type === "landed" && landed.process === "standard", JSON.stringify(landed));
    assert.ok(landed.declaredEnvironments?.includes("staging"));
    assert.ok(f.log.deployments(REPO, "staging").length > 0);
    assert.deepEqual(f.log.releases(REPO), []);
  } finally { await f.dispose(); }
}, 120_000);
