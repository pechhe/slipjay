import {
  gatedReleaseCheck, openReleaseGate, publishFile, releaseProject, remoteParents, remoteRef, remoteTree, until, verifiedCandidates,
  type ReleaseFixture,
} from "./support/release-project.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

// Concurrent `slipjay release --confirm` runs, each in its own process as agent
// sessions run them, against a release check held shut until the test opens it.
// Every candidate is published before the first release starts.
const launcher = fileURLToPath(new URL("../src/launcher/workspace.mjs", import.meta.url));
// Several processes, each polling the release slot every two seconds, on a machine that may be busy.
const TIMEOUT_MS = 480_000;

type Release = { ok: boolean; status: string; candidate?: string; merge?: string; releasedBy?: string | null; base?: string };

function confirm(f: ReleaseFixture, candidate: string) {
  const child = spawn(process.execPath, [launcher, "release", "--confirm", candidate], {
    cwd: f.repo, env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = new Promise<Release>((resolve, reject) => child.on("close", (code) => {
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`release --confirm exited ${code}: ${stderr}${stdout}`)); }
  }));
  // Never leave a rejection unobserved while the test is still arranging others.
  result.catch(() => {});
  return {
    result,
    progress: () => stderr,
    /** Resolves once this release reports waiting for `release <prefix>`. */
    waitingFor: (awaited: string) => until(() => stderr.includes(`[release] waiting for release ${awaited.slice(0, 12)}`),
      `${candidate.slice(0, 12)} to wait for ${awaited.slice(0, 12)}`),
    kill: () => child.kill(),
  };
}

type Confirmed = ReturnType<typeof confirm>;

function scenario(name: string, run: (f: ReleaseFixture, started: (candidate: string) => Confirmed) => Promise<void>) {
  test(name, async () => {
    const f = await releaseProject({ checks: gatedReleaseCheck });
    const releases: Confirmed[] = [];
    try {
      await run(f, (candidate) => { const release = confirm(f, candidate); releases.push(release); return release; });
    } finally {
      await openReleaseGate(f, { slow: true }).catch(() => {});
      for (const release of releases) release.kill();
      await Promise.allSettled(releases.map((release) => release.result));
      await f.dispose();
    }
  }, TIMEOUT_MS);
}

const short = (commit: string) => commit.slice(0, 12);
const verifying = (f: ReleaseFixture, count: number) =>
  until(async () => (await verifiedCandidates(f)).length === count, `${count} release verification(s) to start`);

scenario("two confirms of one candidate verify once and report the same merge", async (f, started) => {
  const candidate = await publishFile(f, "feature.txt");
  const first = started(candidate);
  await verifying(f, 1);
  const second = started(candidate);
  await second.waitingFor(candidate);
  assert.match(second.progress(), new RegExp(`waiting for release ${short(candidate)} \\(contains ${short(candidate)}\\)`));
  await openReleaseGate(f);
  const [one, two] = await Promise.all([first.result, second.result]);
  assert.equal(one.status, "released", JSON.stringify(one));
  assert.equal(two.status, "released_by", JSON.stringify(two));
  assert.ok(two.ok);
  assert.equal(two.merge, one.merge);
  assert.equal(two.releasedBy, candidate);
  assert.deepEqual(await verifiedCandidates(f), [short(candidate)]);
  assert.equal(remoteRef(f, "release"), one.merge);
});

scenario("a newer confirm waits for the older release, then verifies against the base it published", async (f, started) => {
  const older = await publishFile(f, "feature.txt");
  const newer = await publishFile(f, "later.txt");
  const first = started(older);
  await verifying(f, 1);
  const second = started(newer);
  await second.waitingFor(older);
  assert.match(second.progress(), new RegExp(`waiting for release ${short(older)} to finish before ${short(newer)}`));
  await openReleaseGate(f);
  const [one, two] = await Promise.all([first.result, second.result]);
  assert.equal(one.status, "released", JSON.stringify(one));
  assert.equal(two.status, "released", JSON.stringify(two));
  assert.equal(two.base, one.merge, "the newer release planned again against the published older one");
  assert.deepEqual(remoteParents(f, two.merge!), [one.merge, newer]);
  assert.equal(remoteTree(f, two.merge!), remoteTree(f, newer));
  assert.equal(remoteRef(f, "release"), two.merge);
  assert.deepEqual(await verifiedCandidates(f), [short(older), short(newer)]);
});

scenario("an older confirm attaches to the newer running release without verifying", async (f, started) => {
  const older = await publishFile(f, "feature.txt");
  const newer = await publishFile(f, "later.txt");
  const first = started(newer);
  await verifying(f, 1);
  const second = started(older);
  await second.waitingFor(newer);
  assert.match(second.progress(), new RegExp(`waiting for release ${short(newer)} \\(contains ${short(older)}\\)`));
  await openReleaseGate(f);
  const [one, two] = await Promise.all([first.result, second.result]);
  assert.equal(one.status, "released", JSON.stringify(one));
  assert.equal(two.status, "released_by", JSON.stringify(two));
  assert.equal(two.merge, one.merge);
  assert.equal(two.releasedBy, newer);
  assert.deepEqual(await verifiedCandidates(f), [short(newer)]);
});

scenario("when the running release fails verification, the older waiter verifies its own candidate", async (f, started) => {
  const older = await publishFile(f, "feature.txt");
  const newer = await publishFile(f, "broken.txt");
  const first = started(newer);
  await verifying(f, 1);
  const second = started(older);
  await second.waitingFor(newer);
  await openReleaseGate(f);
  const [one, two] = await Promise.all([first.result, second.result]);
  assert.equal(one.status, "verification_failed", JSON.stringify(one));
  assert.equal(two.status, "released", JSON.stringify(two));
  assert.equal(remoteParents(f, two.merge!)[1], older);
  assert.deepEqual(await verifiedCandidates(f), [short(newer), short(older)]);
});

scenario("an attached confirm reports as soon as its release publishes, without waiting behind a newer one", async (f, started) => {
  const older = await publishFile(f, "feature.txt");
  const running = await publishFile(f, "later.txt");
  const newest = await publishFile(f, "slow.txt");
  const first = started(running);
  await verifying(f, 1);
  const attached = started(older);
  await attached.waitingFor(running);
  const queued = started(newest);
  await queued.waitingFor(running);
  // The newest release verifies next and holds at its slow gate; the attached one must not wait for it.
  await openReleaseGate(f);
  const one = await first.result;
  const two = await attached.result;
  assert.equal(one.status, "released", JSON.stringify(one));
  assert.equal(two.status, "released_by", JSON.stringify(two));
  assert.equal(two.releasedBy, running);
  assert.equal(two.merge, one.merge);
  await openReleaseGate(f, { slow: true });
  assert.equal((await queued.result).status, "released");
  assert.deepEqual(await verifiedCandidates(f), [short(running), short(newest)]);
});

scenario("of three waiting confirms only the newest verifies; the others are released by it", async (f, started) => {
  const running = await publishFile(f, "a.txt");
  const candidates = [await publishFile(f, "b.txt"), await publishFile(f, "c.txt"), await publishFile(f, "d.txt")];
  const newest = candidates[2]!;
  const first = started(running);
  await verifying(f, 1);
  const waiters = [];
  // Each waits before the next starts, so all three are queued when the running release ends.
  for (const candidate of candidates) {
    const waiter = started(candidate);
    await waiter.waitingFor(running);
    waiters.push(waiter);
  }
  await openReleaseGate(f);
  const [done, b, c, d] = await Promise.all([first.result, ...waiters.map((waiter) => waiter.result)]);
  assert.equal(done!.status, "released", JSON.stringify(done));
  assert.equal(d!.status, "released", JSON.stringify(d));
  for (const older of [b!, c!]) {
    assert.equal(older.status, "released_by", JSON.stringify(older));
    assert.equal(older.releasedBy, newest);
    assert.equal(older.merge, d!.merge);
  }
  assert.deepEqual(await verifiedCandidates(f), [short(running), short(newest)]);
  assert.equal(remoteRef(f, "release"), d!.merge);
});
