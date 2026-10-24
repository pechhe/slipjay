import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OWNER_KILL_REASON, RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { test, jj, fixture, until, generations, stagesOf, seqOf, exactPrefixGate } from "./fixtures/runner-queue-fixture.ts";

test("a migration-bearing change lands with one generated migration, finalized before publication", async () => {
  const f = await fixture(true);
  try {
    const id = f.submit(await f.candidate("schema/table.ts"));
    const landed = await f.land(id);
    assert.equal(landed?.type, "landed", JSON.stringify(landed));
    if (landed?.type !== "landed") throw new Error("Expected landing");
    assert.equal(f.main(), landed.commitId);
    const shape = f.log.events({ operationId: id }).findLast((row) => row.event.type === "change_shape")?.event;
    assert.ok(shape?.type === "change_shape");
    const shapes = f.log.events({ operationId: id }).flatMap((row) => row.event.type === "change_shape" ? [row.event] : []);
    assert.equal(shapes.length, 3, "migration generation preserves every shape observation");
    assert.notEqual(shapes.at(-2)!.fileSet, shape.fileSet, "generated artifacts require a fresh tree observation");
    const verifiedTree = execFileSync("git", ["--git-dir", f.origin, "rev-parse", `${landed.commitId}^{tree}`], { encoding: "utf8" }).trim();
    assert.equal(shape.fileSet, createHash("sha256").update(verifiedTree).digest("hex"), "source evidence includes generated migration artifacts verified by the gate");
    assert.equal(shape.migrationBearing, true);
    assert.equal(f.remoteFile("migrations/0001.sql"), "-- 1");
    assert.deepEqual(await f.development(), [{ commit: landed.commitId, migrations: ["0001.sql"] }]);
    assert.deepEqual(f.log.events({ operationId: id }).flatMap((stored) => stored.event.type === "stage" ? [stored.event.stage] : []), ["fetching", "rebasing", "installing", "verifying", "integrating", "finalizing", "publishing"]);
    // Generation, verification, the target probe and finalization all share the executor.
    assert.equal(f.log.operation(id)!.runs.length, 5);
    assert.deepEqual(f.log.operation(id)!.runs.map((run) => run.purpose), ["migration_generate", "migration_verify", "gate", "finalization", "finalization"]);
    const contexts = f.requestedTimeouts.flatMap((request) => request.migrationContext ? [JSON.parse(request.migrationContext) as { baseCommit: string; candidateChangeId: string; candidateCommit: string }] : []);
    assert.equal(contexts.length, 2, "both migration commands retain authoritative provenance through the runner");
    assert.deepEqual(contexts[0], contexts[1]);
    assert.equal(contexts[0]!.baseCommit, landed.base);
    const operation = f.log.operation(id)!;
    assert.equal(contexts[0]!.candidateChangeId, operation.kind === "landing" && operation.changeId);
    assert.notEqual(contexts[0]!.candidateCommit, landed.commitId, "provenance remains bound to the semantic source before generation");
    assert.ok(f.log.operation(id)!.runs.every((run) => run.host === f.executor.host && run.exitCode === 0));
    // A committed artifact is refused: landing generates them.
    const before = f.main();
    const committed = f.submit(await f.candidate("migrations/9999.sql"));
    const refused = await f.land(committed);
    assert.equal(refused?.type, "failed", JSON.stringify(refused));
    assert.match(refused?.type === "failed" ? refused.reason : "", /must be generated during landing/);
    assert.equal(f.main(), before);
  } finally { await f.dispose(); }
}, 180_000);

test("migration-bearing changes submitted together land one after the other with consecutive migrations", async () => {
  const f = await fixture(true);
  try {
    const a = f.submit(await f.candidate("schema/a.ts"));
    const b = f.submit(await f.candidate("schema/b.ts"));
    await f.land(b);
    const first = f.result(a), second = f.result(b);
    if (first?.type !== "landed" || second?.type !== "landed") throw new Error(JSON.stringify({ first, second }));
    assert.equal(second.base, first.commitId);
    assert.equal(f.remoteFile("migrations/0001.sql"), "-- 1");
    assert.equal(f.remoteFile("migrations/0002.sql"), "-- 2");
    assert.deepEqual(await f.development(), [
      { commit: first.commitId, migrations: ["0001.sql"] },
      { commit: second.commitId, migrations: ["0001.sql", "0002.sql"] },
    ]);
    assert.equal(generations(f, [a, b]), 2);
  } finally { await f.dispose(); }
}, 180_000);

test("a failed publication holds the finalized integration; relanding publishes it without regenerating, before other changes", async () => {
  const f = await fixture(true);
  try {
    const before = f.main();
    const request = await f.candidate("schema/held.ts");
    const other = await f.candidate("other.txt");
    await writeFile(join(f.root, "reject-push"), "");
    const held = f.submit(request);
    const failure = await f.land(held);
    assert.equal(failure?.type, "failed", JSON.stringify(failure));
    if (failure?.type !== "failed") throw new Error("Expected publication failure");
    assert.equal(failure.stage, "publishing");
    assert.match(failure.reason, /remote unavailable/);
    assert.match(failure.reason, /The runner holds [0-9a-f]{12}, integrated but not published/);
    assert.equal(f.main(), before);
    const [finalized] = await f.development();
    assert.deepEqual(finalized?.migrations, ["0001.sql"]);
    const checkout = join(f.home, "repos", "fixture/repo");
    assert.equal(jj(checkout, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]), finalized!.commit);
    assert.equal(jj(checkout, ["log", "-r", "parents(@)", "--no-graph", "-T", "commit_id"]), finalized!.commit);
    assert.equal(jj(checkout, ["log", "-r", "@", "--no-graph", "-T", "conflict"]), "false");
    const [hold] = f.log.snapshot(f.executor.host).held;
    assert.ok(hold);
    assert.equal(hold.repo, "fixture/repo");
    assert.equal(hold.commitId, finalized!.commit);
    assert.equal(hold.retries, 0);
    assert.match(hold.reason, /remote unavailable/);
    assert.equal(f.log.openOperations().length, 0);
    // Recovery must inspect warm checkouts even when every operation is terminal.
    f.log.append(RUNNER_CONTROL_ID, { type: "integration_recovered", repo: hold.repo, commitId: hold.commitId });
    assert.deepEqual(f.log.snapshot(f.executor.host).held, []);
    await f.queue.recover();
    await f.queue.idle();
    const [rediscovered] = f.log.snapshot(f.executor.host).held;
    assert.equal(rediscovered?.commitId, hold.commitId);
    // The recovery it queued tried the outage once, and only the hold is left.
    assert.equal(rediscovered?.retries, 1);
    // Another change cannot land past the held integration, and does not discard it.
    const blocked = f.submit(other);
    const refusal = await f.land(blocked);
    assert.equal(refusal?.type, "failed", JSON.stringify(refusal));
    assert.equal(refusal?.type === "failed" && refusal.stage, "publishing");
    const [retried] = f.log.snapshot(f.executor.host).held;
    assert.equal(retried?.since, rediscovered!.since);
    assert.equal(retried?.commitId, hold.commitId);
    assert.equal(retried?.retries, 2);
    await rm(join(f.root, "reject-push"));
    const reland = f.submit(request);
    const landed = await f.land(reland);
    assert.deepEqual(landed, { type: "landed", base: before, commitId: finalized!.commit, branch: "main", remote: "origin", ...landed?.type === "landed" && { repo: landed.repo, declaredEnvironments: landed.declaredEnvironments } });
    assert.equal(landed?.type === "landed" && landed.repo, "fixture/repo");
    assert.equal(f.main(), finalized!.commit);
    assert.deepEqual(f.log.snapshot(f.executor.host).held, []);
    assert.equal(generations(f, [held, blocked, reland]), 1);
    assert.equal((await f.development()).length, 1);
    // A stale hold may have recovered externally; ordinary fetch must observe it.
    f.log.append(RUNNER_CONTROL_ID, { type: "integration_held", repo: "fixture/repo", commitId: finalized!.commit,
      reason: "Recorded before external publication was observed" });
    const after = f.submit(other);
    const second = await f.land(after);
    assert.equal(second?.type, "landed", JSON.stringify(second));
    assert.equal(second?.type === "landed" && second.base, finalized!.commit);
    assert.deepEqual(f.log.snapshot(f.executor.host).held, []);
  } finally { await f.dispose(); }
}, 240_000);

test("a failed finalization reports its output, holds the integration and retries it before the next landing", async () => {
  const f = await fixture(true);
  try {
    const before = f.main();
    await writeFile(join(f.root, "fail-finalize"), "");
    const id = f.submit(await f.candidate("schema/retry.ts"));
    const failure = await f.land(id);
    assert.equal(failure?.type, "failed", JSON.stringify(failure));
    if (failure?.type !== "failed") throw new Error("Expected finalization failure");
    assert.equal(failure.stage, "finalizing");
    assert.match(failure.output ?? "", /development migrate failed/);
    const [hold] = f.log.snapshot(f.executor.host).held;
    assert.ok(hold);
    assert.equal(hold.repo, "fixture/repo");
    assert.equal(hold.retries, 0);
    assert.match(hold.reason, /Post-integration/);
    assert.equal(f.log.openOperations().length, 0);
    await f.queue.recover();
    assert.deepEqual(f.log.snapshot(f.executor.host).held, [hold]);
    assert.equal(f.main(), before);
    await rm(join(f.root, "fail-finalize"));
    const next = f.submit(await f.candidate("next.txt"));
    const landed = await f.land(next);
    if (landed?.type !== "landed") throw new Error(JSON.stringify(landed));
    const [finalized] = await f.development();
    assert.deepEqual(finalized?.migrations, ["0001.sql"]);
    assert.equal(landed.base, finalized!.commit);
    assert.deepEqual(f.log.snapshot(f.executor.host).held, []);
    assert.equal(f.remoteFile("migrations/0001.sql"), "-- 1");
  } finally { await f.dispose(); }
}, 240_000);

test("a repository's first landing resets its target at once from the integration tip, with the declared key, keeping the output out of the log", async () => {
  const f = await fixture(false, false, undefined, true);
  try {
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const [reset] = f.log.resets("fixture/repo");
    assert.ok(reset, "the landing scheduled a reset");
    assert.deepEqual(reset.result, { type: "reset", target: "fixture-development-db", source: f.main() });
    assert.doesNotMatch(JSON.stringify(f.log.events({ operationId: reset.id })), /private-customer-record-fixture/);
    assert.match(await readFile(join(f.home, "logs", `${reset.id}.reset-output`), "utf8"), /private-customer-record-fixture/);
    assert.equal(reset.submittedBy, `${f.executor.host}:schedule`);
    assert.deepEqual(stagesOf(f, reset.id), ["fetching", "resetting"]);
    assert.deepEqual(reset.runs.map((run) => run.exitCode), [0, 0], "probe and command ran through the executor");
    assert.deepEqual((await f.lines("reset.jsonl")).map((line) => JSON.parse(line)),
      [{ target: "fixture-development-db", source: f.main(), reasonFile: true, key: "from-runner", head: f.main() }]);
    const output = join(f.home, "logs", `${reset.id}.reset-output`);
    assert.match(await readFile(output, "utf8"), /owner:from-runner@/);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(f.log.events({ operationId: reset.id })) + await f.queue.readLog(reset.id), /from-runner/);
    // The next landing falls within the interval.
    assert.equal((await f.land(f.submit(await f.candidate("b.txt"))))?.type, "landed");
    assert.equal(f.log.resets("fixture/repo").length, 1);
  } finally { await f.dispose(); }
}, 120_000);

test("a failed reset reports the step's reason line and keeps its output out of events; a probe that names another target runs nothing", async () => {
  const f = await fixture(false, false, undefined, true);
  try {
    await writeFile(join(f.root, "fail-reset"), "");
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    const [failed] = f.log.resets("fixture/repo");
    const result = failed?.result;
    assert.ok(result?.type === "failed", JSON.stringify(result));
    assert.equal(result.stage, "resetting");
    assert.equal(result.reason, `Reset command failed: Scrub refused:  a real-customer tenant; its output is in ${join(f.home, "logs", `${failed!.id}.reset-output`)}`);
    assert.doesNotMatch(JSON.stringify(f.log.events({ operationId: failed!.id })), /from-runner|second-line/);
    await rm(join(f.root, "fail-reset"));
    await writeFile(join(f.root, "wrong-target"), "");
    const mismatched = await f.land(f.submitReset());
    assert.deepEqual(mismatched, { type: "failed", stage: "resetting", reason: "The reset target probe did not confirm fixture-development-db; the reset command did not run" });
    assert.equal((await f.lines("reset.jsonl")).length, 1, "only the first reset's command ran");
    await rm(join(f.root, "wrong-target"));
    assert.equal((await f.land(f.submitReset()))?.type, "reset");
    assert.equal(f.log.resets("fixture/repo").length, 3, "a failed reset is not retried on its own");
  } finally { await f.dispose(); }
}, 120_000);

test("the owner's kill stops a running reset: cancelled, never passed, and the schedule does not start it again", async () => {
  const f = await fixture(false, false, undefined, true);
  try {
    await writeFile(join(f.root, "hold-reset"), "");
    f.submit(await f.candidate("a.txt"));
    f.queue.wake();
    await until(async () => await stat(join(f.root, "reset-started")).then(() => true, () => undefined));
    assert.equal(f.queue.kill().status, "killed");
    await f.queue.idle();
    const resets = f.log.resets("fixture/repo");
    assert.equal(resets.length, 1);
    assert.deepEqual(resets[0]!.result, { type: "cancelled", reason: OWNER_KILL_REASON });
    assert.deepEqual(await f.lines("reset.jsonl"), []);
  } finally { await rm(join(f.root, "hold-reset"), { force: true }); await f.dispose(); }
}, 120_000);

test("a reset of a repository that declares none fails, and recovery fails a reset interrupted by a restart", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.land(f.submit(await f.candidate("a.txt"))))?.type, "landed");
    assert.equal(f.log.resets("fixture/repo").length, 0, "nothing schedules a reset that is not declared");
    assert.deepEqual(await f.land(f.submitReset()), { type: "failed", stage: "fetching", reason: `${f.main().slice(0, 12)} declares no reset` });
    const interrupted = f.submitReset();
    f.log.append(interrupted, { type: "stage", stage: "resetting" });
    await f.queue.recover();
    assert.deepEqual(f.result(interrupted), { type: "failed", stage: "resetting", reason: "runner restarted during resetting; run slipjay reset again" });
  } finally { await f.dispose(); }
}, 120_000);

test("depth-two restores a migration candidate's generated state in its verifier when the gate fails", async () => {
  const f = await fixture(true, false, undefined, false, { verificationDepth: 2 });
  try {
    const base = f.main();
    // One migration-bearing candidate whose gate fails after generation.
    await f.candidate("schema/a.ts");
    await writeFile(join(f.author, "fail"), "");
    const a = f.submit(await f.push(f.author));
    await f.land(a);
    assert.equal(f.result(a)?.type, "failed", JSON.stringify(f.result(a)));
    assert.equal(f.main(), base);
    const prepared = f.log.events({ operationId: a }).map((row) => row.event).find((event) => event.type === "attempt_prepared");
    assert.ok(prepared?.type === "attempt_prepared");
    // As at depth one: the verifier's candidate change is restored to its submitted tree, not left generated.
    assert.match(jj(prepared.checkout, ["op", "log", "--no-graph", "-T", 'description ++ "\\n"']), /restore/);
  } finally { await f.dispose(); }
}, 120_000);

test("depth-two migration finalization is a barrier and a hold invalidates its waiting dependent", async () => {
  const f = await fixture(true, false, undefined, false, { verificationDepth: 2 });
  try {
    await writeFile(join(f.root, "hold-finalize"), "");
    await writeFile(join(f.root, "fail-finalize"), "");
    const a = f.submit(await f.candidate("schema/a.ts"));
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(() => f.log.operation(a)?.stage === "finalizing" || f.result(a) || undefined);
    assert.equal(f.result(a), undefined, JSON.stringify(f.result(a)));
    assert.ok(!f.log.events({ operationId: b }).some((row) => row.event.type === "attempt_prepared" || row.event.type === "verification_passed"));
    await rm(join(f.root, "hold-finalize")); await f.queue.idle();
    assert.equal(f.result(a)?.type, "failed", JSON.stringify(f.result(a)));
    assert.equal(f.result(b)?.type, "failed", JSON.stringify(f.result(b)));
    assert.equal(f.log.snapshot(f.executor.host).held.length, 1);
    assert.ok(!f.log.events({ operationId: b }).some((row) => row.event.type === "integrated"));
  } finally { await rm(join(f.root, "hold-finalize"), { force: true }); await f.dispose(); }
}, 120_000);

test("depth-two queued reset fences later landing admission and uses the preceding published source", async () => {
  const f = await fixture(false, false, undefined, true, { verificationDepth: 2, prefixGate: exactPrefixGate });
  try {
    await writeFile(join(f.root, "hold-a"), "");
    await writeFile(join(f.root, "hold-reset"), "");
    const a = f.submit(await f.candidate("a.txt"));
    const reset = f.submitReset();
    const b = f.submit(await f.candidate("b.txt"));
    f.queue.wake();
    await until(async () => await stat(join(f.root, "a-started")).then(() => true, () => undefined));
    assert.equal(f.log.operation(reset)?.status, "queued");
    assert.equal(f.log.operation(b)?.status, "queued");
    await rm(join(f.root, "hold-a"));
    await until(async () => await stat(join(f.root, "reset-started")).then(() => true, () => undefined));
    const landed = f.result(a);
    assert.ok(landed?.type === "landed", JSON.stringify(landed));
    assert.equal(f.log.operation(b)?.status, "queued");
    assert.ok(!f.log.events({ operationId: b }).some((row) => row.event.type === "attempt_started"));
    await rm(join(f.root, "hold-reset")); await f.queue.idle();
    assert.equal(f.result(reset)?.type, "reset", JSON.stringify(f.result(reset)));
    assert.equal(f.result(b)?.type, "landed", JSON.stringify(f.result(b)));
    assert.equal(JSON.parse((await f.lines("reset.jsonl"))[0]!).source, landed.commitId);
    assert.ok(seqOf(f, b, "stage") > seqOf(f, reset, "reset"));
  } finally {
    await rm(join(f.root, "hold-a"), { force: true });
    await rm(join(f.root, "hold-reset"), { force: true });
    await f.dispose();
  }
}, 120_000);
