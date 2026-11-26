import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, fixture, until } from "./fixtures/runner-queue-fixture.ts";
import { REPO, settle, schedule } from "./fixtures/automatic-promotion.ts";
import type { RemoteVerification } from "../../src/lib/runner/runner-types.ts";
import { stand, started, deployProgress } from "./fixtures/prebuild-fixture.ts";

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

test("a check whose build is still running frees its machine before it waits for the build", async () => {
  const s = stand();
  const order: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), "prebuild-release-"));
  const [closed, done] = [join(directory, "closed"), join(directory, "done")];
  // The check machine holds its memory claim until it is closed, so closing it must not wait for the build.
  const machine: RemoteVerification = { ...s.boat, async open(input) {
    const attempt = await s.boat.open(input);
    return { ...attempt, async close() { order.push(existsSync(done) ? "closed after the build" : "closed during the build"); writeFileSync(closed, ""); } };
  } };
  // The build ends once the machine is closed, however slow the host; one that is never closed first ends after 20 s,
  // inside the build's own 30 s limit.
  const build = `const fs = require("node:fs"); const started = Date.now(); const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(closed)}) && Date.now() - started < 20000) return;
    clearInterval(timer); fs.writeFileSync(${JSON.stringify(done)}, ""); }, 50)`;
  const f = await fixture(false, true, { minIntervalMs: 0, production: true, machine: "images", prebuild: `${s.prebuild}; ${build}` }, false,
    { process: "development", promotionSchedule: schedule(30), batchVerification: { machine: "release-check" }, batchRemote: machine,
      machineBuilds: { images: { machine: "peach-box", lease: s.machine } }, releaseGates: () => ['console.log("release checks pass")'] });
  try {
    await f.land(f.submit(await f.candidate("one.txt")));
    await settle(f);
    const check = f.log.verifications(REPO)[0]!;
    await until(() => f.log.operation(check.id)?.result ?? undefined);
    await f.queue.idle();
    assert.equal(f.log.operation(check.id)?.result?.type, "verified");
    assert.deepEqual(order, ["closed during the build"]);
  } finally { await f.dispose(); }
}, 120_000);
