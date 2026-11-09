import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle } from "./fixtures/automatic-promotion.ts";
import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";
import type { LeaseBuildMachine, MachineLease, RemoteVerification } from "../../src/lib/runner/runner-types.ts";

const schedule = (everyMinutes: number) => ({ everyMinutes, from: "00:00", until: "23:59", timeZone: "Europe/London" });

/** Records each lease, and what the prebuild command was given in a file it writes. */
function stand() {
  const directory = mkdtempSync(join(tmpdir(), "prebuild-"));
  const marker = join(directory, "prebuilt");
  const prebuild = `require("node:fs").appendFileSync(${JSON.stringify(marker)}, [process.env.SLIPJAY_DEPLOY_ENVIRONMENT, process.env.SLIPJAY_DEPLOY_COMMIT, process.env.SLIPJAY_MACHINE_SSH].join(" ") + "\\n")`;
  const leased = (machine: MachineLease["machine"]): MachineLease => ({
    machine,
    env: { SLIPJAY_MACHINE_SSH: `ssh-${machine.name}`, SLIPJAY_MACHINE_GIT_DIR: `git-${machine.name}` },
    async close() { return null; },
  });
  const leases: string[] = [];
  const state = { reachable: true };
  const machine: LeaseBuildMachine = async ({ commitId }) => {
    if (!state.reachable) throw new Error("peach-box unreachable");
    leases.push(`machine ${commitId}`);
    return leased({ verifier: "machine", id: "peach-box/build", name: "peach-box", size: "machine", image: "fixed SSH machine" });
  };
  const boat: RemoteVerification = {
    async open() {
      return { executor: { host: "boat", run: runBoundedProcess }, machine: { verifier: "boat", id: "vm-1", name: "release-check", size: "fixture", image: "fixture" },
        tree: "tree", usage: null, async finish() { return { tree: "tree", trackedChanges: 0, usage: null }; }, async close() {} };
    },
    async lease({ commitId }) {
      leases.push(`boat ${commitId}`);
      return leased({ verifier: "boat", id: "vm-2", name: "boat-images", size: "fixture", image: "fixture" });
    },
  };
  return { marker, prebuild, leases, machine, boat, state, prebuilt: () => existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n") : [] };
}

const started = (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  f.log.events({ operationId: id }).flatMap((row) => row.event.type === "progress" && row.event.line.startsWith("[prebuild]") ? [row.event.line] : []);
const deployProgress = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.log.deployments(REPO).filter((entry) => entry.environment === "production").flatMap((entry) => f.log.events({ operationId: entry.id }))
    .flatMap((row) => row.event.type === "progress" ? [row.event.line] : []);

test("a release's check starts building on the fixed machine, and its deploy uses that machine too", async () => {
  const s = stand();
  const f = await fixture(false, true, { minIntervalMs: 0, production: true, machine: "images", prebuild: s.prebuild }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "release-check" }, batchRemote: s.boat,
      machineBuilds: { images: { machine: "peach-box", lease: s.machine } }, releaseGates: () => ['console.log("release checks pass")'] });
  try {
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const check = f.log.verifications(REPO)[0]!;
    await until(() => f.log.operation(check.id)?.result ?? undefined);
    await f.queue.idle();
    const head = check.commitId;
    assert.match(started(f, check.id)[0] ?? "", /building .* on peach-box beside this check/);
    assert.deepEqual(s.prebuilt(), [`production ${head} ssh-peach-box`], "it ran once, for the head, with the deploy's environment and the machine's ssh");
    assert.ok(s.leases.includes(`machine ${head}`));
    assert.ok(!s.leases.some((lease) => lease.startsWith("boat")), "boat built nothing");
    assert.ok(deployProgress(f).includes("[deploy] on peach-box"));
  } finally { await f.dispose(); }
}, 120_000);

test("a fixed machine that cannot be reached skips the prebuild without failing the release, and the deploy goes to boat", async () => {
  const s = stand();
  s.state.reachable = false;
  const f = await fixture(false, true, { minIntervalMs: 0, production: true, machine: "images", prebuild: s.prebuild }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "release-check" }, batchRemote: s.boat,
      machineBuilds: { images: { machine: "peach-box", lease: s.machine } }, releaseGates: () => ['console.log("release checks pass")'] });
  try {
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const check = f.log.verifications(REPO)[0]!;
    await until(() => f.log.operation(check.id)?.result ?? undefined);
    await f.queue.idle();
    assert.equal(f.log.operation(check.id)?.result?.type, "verified");
    assert.deepEqual(s.prebuilt(), []);
    assert.deepEqual(s.leases, [`boat ${check.commitId}`], "only the deploy leased, and from boat");
    const progress = deployProgress(f);
    assert.ok(progress.some((line) => /warning: peach-box cannot build for this deploy \(peach-box unreachable\); it builds on boat instead/.test(line)));
    assert.ok(progress.includes("[deploy] on boat-images"));
  } finally { await f.dispose(); }
}, 120_000);

test("with no fixed machine for the pool, a check starts no prebuild, so boat is never started for one", async () => {
  const s = stand();
  const f = await fixture(false, true, { minIntervalMs: 0, production: true, machine: "images", prebuild: s.prebuild }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "release-check" }, batchRemote: s.boat,
      releaseGates: () => ['console.log("release checks pass")'] });
  try {
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const check = f.log.verifications(REPO)[0]!;
    await until(() => f.log.operation(check.id)?.result ?? undefined);
    await f.queue.idle();
    assert.deepEqual(started(f, check.id), []);
    assert.deepEqual(s.prebuilt(), []);
    assert.deepEqual(s.leases, [`boat ${check.commitId}`]);
  } finally { await f.dispose(); }
}, 120_000);

test("a background check starts no prebuild", async () => {
  let clock = Date.now();
  const s = stand();
  const f = await fixture(false, true, { minIntervalMs: 0, production: true, machine: "images", prebuild: s.prebuild }, false,
    { process: "development", promotionSchedule: schedule(600), now: () => clock, batchVerification: { machine: "release-check", everyMinutes: 20 }, batchRemote: s.boat,
      machineBuilds: { images: { machine: "peach-box", lease: s.machine } }, releaseGates: () => ['console.log("release checks pass")'] });
  try {
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    clock = promotedAt + 60_000;
    await f.land(f.submit(await f.candidate("two.txt")));
    await settle(f);
    clock = promotedAt + 21 * 60_000;
    await f.queue.recover();
    await settle(f);
    const check = await until(() => f.log.verifications(REPO).find((entry) => entry.submittedBy.endsWith(":background") && entry.result));
    await f.queue.idle();
    assert.deepEqual(started(f, check.id), []);
    assert.ok(!s.prebuilt().some((line) => line.includes(check.commitId)));
  } finally { await f.dispose(); }
}, 180_000);
