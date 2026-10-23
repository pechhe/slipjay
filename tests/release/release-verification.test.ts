import { landFile, releaseProject, remoteParents, remoteRef } from "../support/release-project.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vite-plus/test";
import { confirmRelease, verifyRelease } from "../../src/lib/release/release.ts";
import type { OperationEvent, VerificationOperation } from "../../src/lib/runner/runner-types.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "../../src/lib/infra/bounded-process.ts";
import { promotingProject, verificationOf } from "./fixtures/release-fixture.ts";

test("a promotion plan reports its candidate's pre-verification, passed only against the plan's base and checks", async () => {
  const f = await promotingProject();
  try {
    const candidate = await f.commit({ "feature.txt": "a\n" }, "Add the feature");
    const older = await f.commit({ "next.txt": "b\n" }, "Next");
    const base = remoteRef(f, "release");
    const state = async (verifications: VerificationOperation[]) => {
      const plan = await f.plan(candidate, [], verifications);
      assert.ok(plan.ok && plan.status === "planned", JSON.stringify(plan));
      return plan.verification;
    };
    const passed = { type: "verified", base, candidate, checks: f.checks } as OperationEvent;
    assert.deepEqual(await state([]), { status: "none", commit: candidate, operationId: null });
    assert.deepEqual(await state([verificationOf(older, "verified", passed)]), { status: "none", commit: candidate, operationId: null }, "another commit's pass is not this one's");
    assert.equal((await state([verificationOf(candidate, "queued")]))?.status, "queued");
    assert.equal((await state([verificationOf(candidate, "running")]))?.status, "running");
    const pass = verificationOf(candidate, "verified", passed);
    assert.deepEqual(await state([pass]), { status: "passed", commit: candidate, operationId: pass.id });
    assert.equal((await state([verificationOf(candidate, "verified", { ...passed, base: older } as OperationEvent)]))?.status, "none", "a pass against another release base");
    assert.equal((await state([verificationOf(candidate, "verified", { ...passed, checks: [] } as OperationEvent)]))?.status, "none", "a pass with other checks");
    const failed = verificationOf(candidate, "failed", { type: "failed", stage: "verifying", reason: "exited 1", command: "bun run verify:release" });
    assert.deepEqual(await state([failed, pass]), { status: "failed", commit: candidate, operationId: failed.id, failedCommand: "bun run verify:release" }, "the newest counts");
    assert.equal((await state([verificationOf(candidate, "superseded"), pass]))?.status, "passed", "a superseded one is passed over");
  } finally { await f.dispose(); }
});

test("a pre-verification runs the release checks and publishes nothing; a confirm that reuses it publishes without running them", async () => {
  const f = await releaseProject();
  try {
    const base = remoteRef(f, "release");
    const candidate = await landFile(f, "feature.txt");
    const verified = await verifyRelease(f.repo, { candidate });
    assert.ok(verified.ok, JSON.stringify(verified));
    assert.equal(verified.base, base);
    assert.equal(verified.candidate, candidate);
    assert.equal(remoteRef(f, "release"), base, "nothing published");
    assert.equal((await readFile(f.verifiedRelease, "utf8")).split("\n").filter(Boolean).length, 1);

    const result = await confirmRelease(f.repo, { candidate, preverified: (plan) => plan.base === base ? "op_pre" : null });
    assert.ok(result.ok && result.status === "released", JSON.stringify(result));
    assert.deepEqual(result.verification, { preverified: "op_pre" });
    assert.equal((await readFile(f.verifiedRelease, "utf8")).split("\n").filter(Boolean).length, 1, "the confirm ran no check");
    assert.deepEqual(remoteParents(f, remoteRef(f, "release")), [base, candidate]);

    const shipped = await verifyRelease(f.repo, { candidate });
    assert.ok(!shipped.ok && /already on release/.test(shipped.reason), JSON.stringify(shipped));
  } finally { await f.dispose(); }
});

test("an owner kill during release verification schedules no check after the one it stops", async () => {
  const f = await releaseProject({ checks: () => [{ executable: "node", args: ["one"] }, { executable: "node", args: ["two"] }, { executable: "node", args: ["three"] }] });
  try {
    const candidate = await landFile(f, "feature.txt");
    const controller = new AbortController();
    const started: string[] = [];
    const outcome = (over: Partial<BoundedProcessResult>): BoundedProcessResult => ({ stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false,
      exitCode: 0, signal: null, timedOut: false, cancelled: false, outputSha256: "fixture", finishedAt: new Date().toISOString(), ...over });
    const run = async (request: BoundedProcessRequest): Promise<BoundedProcessResult> => {
      const name = request.args[0]!;
      started.push(name);
      if (name === "one") return outcome({ exitCode: 1, stderr: "one failed\n" });
      if (name === "two") {
        controller.abort();
        return outcome({ exitCode: null, signal: "SIGKILL" });
      }
      return outcome({});
    };
    const verified = await verifyRelease(f.repo, { candidate, run, abortSignal: controller.signal });
    assert.ok(!verified.ok && verified.status === "verification_failed", JSON.stringify(verified));
    assert.deepEqual(started, ["one", "two"], "check three is never started");
    assert.deepEqual(verified.evidence.checks.map((check) => check.outcome), ["failed", "failed", "not_run"]);
  } finally { await f.dispose(); }
});
