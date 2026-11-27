import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { test, jj, fixture, until, generations } from "./fixtures/runner-queue-fixture.ts";

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
    assert.equal(shapes.length, 2, "migration generation preserves every shape observation");
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
    assert.deepEqual(landed, { type: "landed", base: before, commitId: finalized!.commit, branch: "main", remote: "origin", ...landed?.type === "landed" && { repo: landed.repo, declaredEnvironments: landed.declaredEnvironments, process: landed.process } });
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
