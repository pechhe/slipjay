import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newOperationId } from "../../src/lib/runner/runner-log.ts";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle } from "./fixtures/automatic-promotion.ts";

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

