import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { test, fixture, until, seqOf } from "./fixtures/runner-queue-fixture.ts";

for (const recover of [false, true]) {
  for (const first of ["reset", "release"] as const) {
    test(`paused ${first}-first reset/release admission preserves exclusion${recover ? " after recovery" : ""}`, async () => {
      const f = await fixture(false, true, undefined, true, { workers: 2 });
      try {
        assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
        f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
        const submit = { reset: () => f.submitReset(), release: () => f.submitRelease(f.main()) };
        const second = first === "reset" ? "release" : "reset";
        const a = submit[first]();
        const b = submit[second]();
        if (recover) await f.queue.recover();
        f.queue.wake();
        assert.equal(f.log.operation(a)!.status, "queued");
        assert.equal(f.log.operation(b)!.status, "queued");
        f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "owner" });
        f.queue.wake();
        await f.queue.idle();
        assert.equal(f.result(a)?.type, first === "reset" ? "reset" : "released", JSON.stringify(f.result(a)));
        assert.equal(f.result(b)?.type, second === "reset" ? "reset" : "released", JSON.stringify(f.result(b)));
        assert.ok(seqOf(f, b, "stage") > seqOf(f, a, first === "reset" ? "reset" : "released"),
          "the second operation starts only after the first finishes, including pending lane callbacks");
      } finally { await f.dispose(); }
    }, 120_000);
  }
}

test("a release and a reset of one repository never overlap, and each says which it waits for", async () => {
  const f = await fixture(false, true, undefined, true);
  try {
    await writeFile(join(f.root, "hold-reset"), "");
    const reset = f.submitReset();
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "reset-started")).then(() => true, () => undefined));
    const release = f.submitRelease(f.main());
    f.queue.wake();
    assert.equal(f.log.operation(release)!.waitingFor, `reset ${f.log.operation(reset)!.commitId.slice(0, 12)}`);
    await rm(join(f.root, "hold-reset"));
    await f.queue.idle();
    assert.equal(f.result(reset)?.type, "reset", JSON.stringify(f.result(reset)));
    assert.equal(f.result(release)?.type, "released", JSON.stringify(f.result(release)));
    assert.ok(seqOf(f, release, "stage") > seqOf(f, reset, "reset"), "the release verified after the reset ended");

    await writeFile(join(f.root, "hold-release"), "");
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    await rm(join(f.root, "release-started"), { force: true });
    const second = f.submitRelease(f.main());
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "release-started")).then(() => true, () => undefined));
    const again = f.submitReset();
    f.queue.wake();
    assert.equal(f.log.operation(again)!.waitingFor, `release ${f.main().slice(0, 12)}`);
    await rm(join(f.root, "hold-release"));
    await f.queue.idle();
    assert.equal(f.result(second)?.type, "released", JSON.stringify(f.result(second)));
    assert.equal(f.result(again)?.type, "reset", JSON.stringify(f.result(again)));
    assert.ok(seqOf(f, again, "stage") > seqOf(f, second, "released"), "the reset ran after the release published");
  } finally { await f.dispose(); }
}, 120_000);

test("a release whose release branch moved while it verified publishes nothing", async () => {
  const f = await fixture(false, true);
  try {
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    await writeFile(join(f.root, "hold-release"), "");
    const release = f.submitRelease(f.main());
    f.queue.wake();
    await until(async () => await readFile(join(f.root, "release-started")).then(() => true, () => undefined));
    const git = (args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "--git-dir", f.origin, ...args], { encoding: "utf8" }).trim();
    const moved = git(["commit-tree", "release^{tree}", "-p", "release", "-m", "Hotfix"]);
    git(["update-ref", "refs/heads/release", moved]);
    await rm(join(f.root, "hold-release"));
    await f.queue.idle();
    const outcome = f.result(release);
    assert.ok(outcome?.type === "failed" && /release@origin moved during the release; rerun it/.test(outcome.reason), JSON.stringify(outcome));
    assert.equal(f.releaseRef(), moved);
  } finally { await f.dispose(); }
}, 120_000);

test("a failed release verification publishes nothing and reports its output verbatim", async () => {
  const f = await fixture(false, true);
  try {
    const base = f.releaseRef();
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    await writeFile(join(f.root, "fail-release"), "");
    const outcome = await f.land(f.submitRelease(f.main()));
    assert.ok(outcome?.type === "failed", JSON.stringify(outcome));
    assert.equal(outcome.stage, "verifying");
    assert.match(outcome.output ?? "", /release boom/);
    assert.equal(f.releaseRef(), base);
  } finally { await f.dispose(); }
}, 120_000);

test("a release of a candidate the release branch already holds verifies nothing and names the release that shipped it", async () => {
  const f = await fixture(false, true);
  try {
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const older = f.main();
    assert.equal((await f.land(f.submit(await f.candidate("b.txt"))))?.type, "landed");
    const newer = f.main();
    const shipped = await f.land(f.submitRelease(newer));
    assert.ok(shipped?.type === "released" && shipped.result.status === "released", JSON.stringify(shipped));
    const again = await f.land(f.submitRelease(older));
    assert.ok(again?.type === "released" && again.result.status === "released_by", JSON.stringify(again));
    assert.equal(again.result.releasedBy, newer);
    assert.equal(again.result.merge, shipped.result.merge);
    assert.equal((await f.lines("release-verified.log")).length, 1);
  } finally { await f.dispose(); }
}, 120_000);

test("recovery fails an interrupted release with the command that reruns it", async () => {
  const f = await fixture(false, true);
  try {
    const release = f.submitRelease(f.main());
    f.log.append(release, { type: "stage", stage: "verifying" });
    await f.queue.recover();
    assert.deepEqual(f.result(release), { type: "failed", stage: "verifying",
      reason: `runner restarted during verifying; rerun slipjay promote --confirm ${f.main().slice(0, 12)}` });
  } finally { await f.dispose(); }
}, 120_000);
