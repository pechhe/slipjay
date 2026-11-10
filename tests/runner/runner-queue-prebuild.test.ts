import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle } from "./fixtures/automatic-promotion.ts";
import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";
import type { LeaseBuildMachine, MachineLease, RemoteVerification } from "../../src/lib/runner/runner-types.ts";
import { nextPromotionAt } from "../../src/lib/policy/promotion-schedule.ts";

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

test("a background check builds its head beside its checks, and its build is part of the check", async () => {
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
    assert.match(started(f, check.id)[0] ?? "", /building .* on peach-box beside this check/);
    assert.ok(s.prebuilt().includes(`production ${check.commitId} ssh-peach-box`));
    assert.equal(f.log.operation(check.id)?.result?.type, "verified");
    assert.ok(!s.leases.some((lease) => lease.startsWith("boat")), "a background check never builds on boat");
  } finally { await f.dispose(); }
}, 180_000);

for (const stopWhileWaiting of [false, true]) test(stopWhileWaiting
  ? "a background check stopped while a busy host holds it back builds nothing"
  : "a background check on a busy host starts its build only once the host admits its checks", async () => {
  let clock = Date.now();
  const s = stand();
  const host = { busy: false };
  const hostShell = () => async (script: string) => script.includes("flock") ? "claimed\n" : `${host.busy ? "99 99" : "1 1"} 1.00 1/100 200\n14\n`;
  const f = await fixture(false, true, { minIntervalMs: 0, production: true, machine: "images", prebuild: s.prebuild }, false,
    { process: "development", promotionSchedule: schedule(600), now: () => clock, batchVerification: { machine: "release-check", everyMinutes: 20 },
      hostShell, machineBuilds: { images: { machine: "peach-box", lease: s.machine } }, releaseGates: () => ['console.log("release checks pass")'] });
  try {
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    clock = promotedAt + 60_000;
    await f.land(f.submit(await f.candidate("two.txt")));
    await settle(f);
    const head = f.log.lastLanded(REPO)!.commitId;
    host.busy = true;
    clock = promotedAt + 21 * 60_000;
    await f.queue.recover();
    const check = await until(() => f.log.verifications(REPO).find((entry) => entry.submittedBy.endsWith(":background")));
    await until(() => f.log.events({ operationId: check.id }).some(({ event }) => event.type === "stage" && event.stage === "waiting-for-budget") || undefined);
    assert.ok(!s.prebuilt().some((line) => line.includes(head)), "nothing builds while the host holds the check back");
    if (stopWhileWaiting) {
      assert.equal(f.queue.kill(check.id).status, "killed");
      assert.equal((await until(() => f.log.operation(check.id)?.result ?? undefined)).type, "cancelled");
      host.busy = false;
      await f.queue.idle();
      assert.ok(!s.prebuilt().some((line) => line.includes(head)), "a check stopped while it waited builds nothing");
      return;
    }
    host.busy = false;
    await until(() => f.log.operation(check.id)?.result ?? undefined);
    await f.queue.idle();
    const events = f.log.events({ operationId: check.id }).map(({ event }) => event);
    const waited = events.findIndex((event) => event.type === "host_budget_waited");
    const built = events.findIndex((event) => event.type === "progress" && event.line.startsWith("[prebuild] building"));
    assert.ok(waited >= 0 && built > waited, "the build starts after the admission");
    assert.equal(f.log.operation(check.id)?.result?.type, "verified");
  } finally { await f.dispose(); }
}, 180_000);

test("a head whose images do not build fails its check, names the landing that broke them, and is not deployed", async () => {
  const s = stand();
  const f = await fixture(false, true, { minIntervalMs: 0, production: true, machine: "images",
    prebuild: `${s.prebuild}; if (require("node:fs").existsSync("broken.txt")) { console.error("Error: the app does not build"); process.exit(1) }` }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "release-check" }, batchRemote: s.boat,
      machineBuilds: { images: { machine: "peach-box", lease: s.machine } }, releaseGates: () => ['console.log("release checks pass")'] });
  try {
    const landing = f.submit(await f.candidate("broken.txt"));
    await f.land(landing);
    await settle(f);
    const check = f.log.verifications(REPO)[0]!;
    await until(() => f.log.operation(check.id)?.result ?? undefined);
    await f.queue.idle();
    const result = f.log.operation(check.id)?.result;
    assert.equal(result?.type, "failed");
    assert.match(result?.type === "failed" ? result.reason : "", /failed: prebuild; culprits/);
    const outcome = f.log.events({ operationId: check.id }).map((row) => row.event).find((event) => event.type === "batch_outcome");
    assert.equal(outcome?.type === "batch_outcome" ? outcome.outcome : undefined, "red");
    assert.deepEqual(outcome?.type === "batch_outcome" && outcome.outcome === "red" ? (outcome.culprits ?? []).map((culprit) => culprit.keys) : [], [["prebuild"]]);
    assert.equal(s.prebuilt().filter((line) => line.includes(check.commitId)).length, 2, "it rebuilt once to rule out a flaky build");
    assert.deepEqual(f.log.deployments(REPO).filter((entry) => entry.environment === "production"), [], "nothing deployed");
  } finally { await f.dispose(); }
}, 120_000);

test("a build that could not run says nothing about the head, which passes and builds at its deploy", async () => {
  const s = stand();
  const f = await fixture(false, true, { minIntervalMs: 0, production: true, machine: "images",
    prebuild: `${s.prebuild}; console.error("image build lock still held"); process.exit(2)`, prebuildInconclusive: [2] }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "release-check" }, batchRemote: s.boat,
      machineBuilds: { images: { machine: "peach-box", lease: s.machine } }, releaseGates: () => ['console.log("release checks pass")'] });
  try {
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const check = f.log.verifications(REPO)[0]!;
    await until(() => f.log.operation(check.id)?.result ?? undefined);
    await f.queue.idle();
    assert.equal(f.log.operation(check.id)?.result?.type, "verified");
    const lines = f.log.events({ operationId: check.id }).flatMap((row) => row.event.type === "progress" ? [row.event.line] : []);
    assert.ok(lines.some((line) => /prebuild could not build, which says nothing about the source: exited 2/.test(line)));
    const outcome = f.log.events({ operationId: check.id }).map((row) => row.event).find((event) => event.type === "batch_outcome");
    assert.deepEqual(outcome?.type === "batch_outcome" ? outcome.unproven : undefined, ["prebuild"], "a green check that could not build proves nothing about the build");
    assert.ok(deployProgress(f).includes("[deploy] on peach-box"), "the deploy went ahead");
  } finally { await f.dispose(); }
}, 120_000);

test("the build runs beside the release checks, not before them", async () => {
  const s = stand();
  const order = join(mkdtempSync(join(tmpdir(), "prebuild-order-")), "order");
  const write = (line: string) => `require("node:fs").appendFileSync(${JSON.stringify(order)}, ${JSON.stringify(line)} + "\\n")`;
  const f = await fixture(false, true, { minIntervalMs: 0, production: true, machine: "images",
    prebuild: `${s.prebuild}; ${write("build started")}; setTimeout(() => { ${write("build finished")} }, 4000)` }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "release-check" }, batchRemote: s.boat,
      machineBuilds: { images: { machine: "peach-box", lease: s.machine } }, releaseGates: () => [`${write("checks ran")}; console.log("release checks pass")`] });
  try {
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const check = f.log.verifications(REPO)[0]!;
    await until(() => f.log.operation(check.id)?.result ?? undefined);
    await f.queue.idle();
    assert.equal(f.log.operation(check.id)?.result?.type, "verified");
    const lines = readFileSync(order, "utf8").trim().split("\n");
    assert.ok(lines.indexOf("checks ran") < lines.indexOf("build finished"), `the checks ran while the build was still going: ${lines.join(", ")}`);
  } finally { await f.dispose(); }
}, 120_000);

test("a check killed while its build runs is never verified, and stops waiting for the build", async () => {
  const s = stand();
  const checked = join(mkdtempSync(join(tmpdir(), "prebuild-kill-")), "checked");
  const f = await fixture(false, true, { minIntervalMs: 0, production: true, machine: "images",
    prebuild: `${s.prebuild}; setTimeout(() => {}, 60_000)` }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "release-check" }, batchRemote: s.boat,
      machineBuilds: { images: { machine: "peach-box", lease: s.machine } },
      releaseGates: () => [`require("node:fs").writeFileSync(${JSON.stringify(checked)}, "done"); console.log("release checks pass")`] });
  try {
    await f.land(f.submit(await f.candidate("one.txt")));
    await until(() => existsSync(checked) || undefined);
    const check = await until(() => f.log.verifications(REPO)[0]);
    const killedAt = Date.now();
    assert.equal(f.queue.kill(check.id).status, "killed");
    const result = await until(() => f.log.operation(check.id)?.result ?? undefined);
    assert.equal(result.type, "cancelled", "a killed check ends cancelled, never verified");
    assert.ok(Date.now() - killedAt < 30_000, "it did not wait out the build");
  } finally { await f.dispose(); }
}, 120_000);

test("a landing waiting for its scheduled promotion starts building fifteen minutes before it, on the fixed machine", async () => {
  let clock = Date.now();
  const s = stand();
  const f = await fixture(false, true, { minIntervalMs: 0, production: true, machine: "images", prebuild: s.prebuild }, false,
    { process: "development", promotionSchedule: schedule(30), now: () => clock, batchVerification: { machine: "release-check" }, batchRemote: s.boat,
      machineBuilds: { images: { machine: "peach-box", lease: s.machine } }, releaseGates: () => ['console.log("release checks pass")'] });
  try {
    // The first landing promotes at once; the second waits for the slot thirty minutes after it.
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    await f.queue.idle();
    const first = s.prebuilt().length;
    const promotedAt = Date.parse(f.log.releases(REPO)[0]!.submittedAt);
    const due = nextPromotionAt(schedule(30), promotedAt, promotedAt);
    clock = due - 15 * 60_000 - 1_500;
    await f.land(f.submit(await f.candidate("two.txt")));
    await settle(f);
    const head = f.log.lastLanded(REPO)!.commitId;
    await until(() => s.prebuilt().slice(first).find((line) => line.includes(head)));
    assert.deepEqual(s.prebuilt().slice(first), [`production ${head} ssh-peach-box`], "it built the landing the slot will check, once");
    assert.equal(f.log.releases(REPO).length, 1, "it promoted nothing early");
    assert.ok(!s.leases.some((lease) => lease.startsWith("boat")), "boat built nothing");
  } finally { await f.dispose(); }
}, 120_000);
