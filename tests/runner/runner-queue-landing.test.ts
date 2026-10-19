import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import type { StoredEvent } from "../../src/lib/runner/runner-contract.ts";
import { newOperationId } from "../../src/lib/runner/runner-log.ts";
import { createReceiptDrain } from "../../src/lib/build/build-receipts.ts";
import { applyPolicyPatch, POLICY_BASE_TRAILER, policyDigest } from "../../src/lib/policy/policy-settings.ts";
import type { PolicyPatch } from "../../src/lib/policy/policy-settings.ts";
import { gate, command, test, jj, fixture, until, generate } from "./fixtures/runner-queue-fixture.ts";

test("queued candidates land in arrival order on the previous candidate, with runner gate records and streamed logs", async () => {
  const f = await fixture();
  try {
    const a = f.submit(await f.candidate("a.txt"));
    const b = f.submit(await f.candidate("b.txt"));
    assert.equal(f.log.operation(a)!.position, 1);
    assert.equal(f.log.operation(b)!.position, 2);
    assert.equal(await f.queue.readLog("unknown"), null);
    f.queue.wake(); f.queue.wake();
    await f.queue.idle();
    const first = f.result(a);
    const second = f.result(b);
    assert.equal(first?.type, "landed", JSON.stringify(first));
    assert.equal(second?.type, "landed", JSON.stringify(second));
    if (first?.type !== "landed" || second?.type !== "landed") throw new Error("Expected landed candidates");
    assert.equal(second.base, first.commitId);
    assert.equal(f.main(), second.commitId);
    assert.equal(f.remoteFile("a.txt"), "a.txt");
    assert.equal(f.remoteFile("b.txt"), "b.txt");
    assert.deepEqual(f.published.filter((stored) => stored.event.type === "landed").map((stored) => stored.operationId), [a, b]);
    for (const id of [a, b]) {
      const operation = f.log.operation(id)!;
      assert.equal(operation.runs.length, 1);
      assert.equal(operation.runs[0]!.host, f.executor.host);
      assert.equal(operation.runs[0]!.command, command);
      assert.equal(operation.runs[0]!.timeoutMs, f.requestedTimeouts.find((request) => request.command === command)!.timeoutMs);
      assert.equal(operation.runs[0]!.exitCode, 0);
      const evidence = f.log.events({ operationId: id }).map((row) => row.event);
      const shape = evidence.findLast((event) => event.type === "change_shape");
      assert.ok(shape?.type === "change_shape");
      assert.equal(shape.files, 1);
      assert.equal(shape.insertions, 1);
      assert.equal(shape.migrationBearing, false);
      assert.match(shape.fileSet, /^[a-f0-9]{64}$/);
      assert.ok(evidence.some((event) => event.type === "queue_snapshot" && event.depth >= event.position));
      assert.ok(evidence.some((event) => event.type === "verification_base" && event.base === (id === a ? first.base : second.base)));
      assert.ok(evidence.some((event) => event.type === "stage_detail" && event.stage === "verifying" && event.durationMs >= 0));
      assert.equal(operation.runs[0]!.killed, false);
      assert.ok(Number.isFinite(operation.runs[0]!.outputBytes));
      assert.deepEqual(f.log.events({ operationId: id }).filter((stored) => stored.event.type === "stage").map((stored) => stored.event.type === "stage" && stored.event.stage), ["fetching", "rebasing", "installing", "verifying", "integrating", "finalizing", "publishing"]);
      assert.equal(f.queue.logPath(id), join(f.home, "logs", `${id}.log`));
      const lines = (await f.queue.readLog(id))!.trim().split("\n").map((line) => JSON.parse(line) as StoredEvent);
      assert.deepEqual(lines, f.published.filter((stored) => stored.operationId === id));
    }
    assert.equal(execFileSync("git", ["--git-dir", f.origin, "for-each-ref", "refs/heads/slipjay/changes"], { encoding: "utf8" }), "");
    // The runner's jj settings come from its config and defaults, set in the warm checkout, not from the host.
    const repoConfig = jj(join(f.home, "repos", "fixture/repo"), ["config", "list", "--repo"]);
    for (const setting of ['user.name = "Runner Identity"', 'user.email = "runner@example.com"', 'snapshot.max-new-file-size = "64MiB"'])
      assert.ok(repoConfig.includes(setting), repoConfig);
  } finally { await f.dispose(); }
}, 120_000);

test("a renamed integration bookmark is fetched and tracked without deleting the old bookmark", async () => {
  const f = await fixture();
  try {
    jj(f.author, ["new", "main"]);
    const policyPath = join(f.author, "slipjay.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    await writeFile(policyPath, JSON.stringify({ ...policy, integrationBranch: "renamed" }));
    jj(f.author, ["describe", "-m", "Rename integration"]);
    const rename = await f.land(f.submit(await f.push()));
    assert.equal(rename?.type, "landed", JSON.stringify(rename));
    const oldTip = f.main();
    jj(f.author, ["git", "fetch", "--remote", "origin", "--branch", "main"]);
    jj(f.author, ["git", "push", "--remote", "origin", "--named", "renamed=main@origin"]);
    const checkout = join(f.home, "repos", "fixture/repo");
    assert.equal(jj(checkout, ["log", "--no-graph", "-r", 'bookmarks("renamed")', "-T", "commit_id"]), "");
    const next = await f.land(f.submit(await f.candidate("after-rename.txt")));
    assert.equal(next?.type, "landed", JSON.stringify(next));
    if (next?.type !== "landed") throw new Error("Expected renamed landing");
    assert.equal(next.branch, "renamed");
    assert.equal(execFileSync("git", ["--git-dir", f.origin, "rev-parse", "renamed"], { encoding: "utf8" }).trim(), next.commitId);
    assert.equal(f.main(), oldTip, "old remote bookmark remains unchanged");
    assert.equal(jj(checkout, ["log", "--no-graph", "-r", "main", "-T", "commit_id"]), oldTip, "old local bookmark remains unchanged");
    assert.equal(jj(checkout, ["log", "--no-graph", "-r", 'tracked_remote_bookmarks(exact:"renamed")', "-T", "commit_id"]), next.commitId);
  } finally { await f.dispose(); }
}, 120_000);

test("a missing renamed integration bookmark names the local and remote failure", async () => {
  const f = await fixture();
  try {
    jj(f.author, ["new", "main"]);
    const policyPath = join(f.author, "slipjay.json");
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    await writeFile(policyPath, JSON.stringify({ ...policy, integrationBranch: "missing" }));
    jj(f.author, ["describe", "-m", "Rename integration"]);
    assert.equal((await f.land(f.submit(await f.push())))?.type, "landed");
    const oldTip = f.main();
    const next = await f.land(f.submit(await f.candidate("after-rename.txt")));
    assert.equal(next?.type, "failed", JSON.stringify(next));
    assert.match(JSON.stringify(next), /integration bookmark 'missing'.*locally.*remote 'origin'/);
    assert.equal(f.main(), oldTip);
  } finally { await f.dispose(); }
}, 120_000);

for (const verificationDepth of [1, 2] as const) test(`a two-commit landing preserves feature attribution at depth ${verificationDepth}`, async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth });
  try {
    const base = f.main();
    jj(f.author, ["new", "main", "-m", "feat: deliver the feature\n\nFeature body.\n\nIssue: pechhe/slipjay#59"]);
    await writeFile(join(f.author, "feature.txt"), "feature\n");
    jj(f.author, ["new", "@", "-m", "fix: answer review\n\nReview body."]);
    await writeFile(join(f.author, "review.txt"), "review\n");
    const result = await f.land(f.submit(await f.push()));
    assert.equal(result?.type, "landed", JSON.stringify(result));
    const description = execFileSync("git", ["--git-dir", f.origin, "show", "-s", "--format=%B", f.main()], { encoding: "utf8" }).trim();
    if (verificationDepth === 2) {
      assert.equal(description, "feat: deliver the feature\n\nFeature body.\n\nIssue: pechhe/slipjay#59\n\nfix: answer review\n\nReview body.");
      assert.equal(f.parents(f.main())[0], base, "folded artifact extends integration directly");
    } else {
      assert.equal(description, "fix: answer review\n\nReview body.");
      const first = f.parents(f.main())[0]!;
      assert.equal(execFileSync("git", ["--git-dir", f.origin, "show", "-s", "--format=%B", first], { encoding: "utf8" }).trim(),
        "feat: deliver the feature\n\nFeature body.\n\nIssue: pechhe/slipjay#59");
      assert.equal(f.parents(first)[0], base, "serial landing preserves both commits");
    }
    assert.equal(f.remoteFile("feature.txt"), "feature");
    assert.equal(f.remoteFile("review.txt"), "review");
  } finally { await f.dispose(); }
}, 120_000);

test("a rebase conflict in the policy returns the runner to integration before an independent landing", async () => {
  const f = await fixture();
  try {
    const makePolicyCandidate = async (projectCode: string) => {
      jj(f.author, ["new", "main"]);
      const path = join(f.author, "slipjay.json");
      const policy = JSON.parse(await readFile(path, "utf8"));
      policy.projectCode = projectCode;
      await writeFile(path, JSON.stringify(policy));
      jj(f.author, ["describe", "-m", `Set project code ${projectCode}`]);
      return f.push();
    };
    const first = await makePolicyCandidate("aa");
    const conflicting = await makePolicyCandidate("bb");
    const independent = await f.candidate("independent.txt");
    assert.equal((await f.land(f.submit(first)))?.type, "landed");
    const failed = f.submit(conflicting);
    const failure = await f.land(failed);
    assert.ok(failure?.type === "failed", JSON.stringify(failure));
    assert.equal(failure.stage, "rebasing");
    assert.match(failure.reason, /conflict/i);
    const checkout = join(f.home, "repos", "fixture/repo");
    assert.equal(jj(checkout, ["log", "-r", "@", "--no-graph", "-T", "conflict"]), "false");
    assert.equal(jj(checkout, ["log", "-r", "parents(@)", "--no-graph", "-T", "commit_id"]), f.main());
    assert.equal(f.candidateAtVerdict.get(failed), false);
    assert.equal(JSON.parse(await readFile(join(checkout, "slipjay.json"), "utf8")).projectCode, "aa");
    assert.equal((await f.land(f.submit(independent)))?.type, "landed");
    assert.equal(f.remoteFile("independent.txt"), "independent.txt");
  } finally { await f.dispose(); }
}, 120_000);

test("a candidate on an older base lands without abandoning the integration published since, on a branch jj does not call trunk", async () => {
  const f = await fixture(false, false, undefined, false, { branch: "rollover" });
  try {
    const stale = await f.candidate("stale.txt");
    const first = await f.land(f.submit(await f.candidate("first.txt")));
    const second = await f.land(f.submit(await f.candidate("second.txt")));
    assert.ok(first?.type === "landed" && second?.type === "landed", JSON.stringify([first, second]));
    // `jj git clone` names the remote's default branch trunk(); a fork whose default is another
    // branch (pechhe/t3code integrates on rollover) has no such alias, so jj calls only main trunk.
    const checkout = join(f.home, "repos", "fixture/repo");
    jj(checkout, ["config", "unset", "--repo", 'revset-aliases."trunk()"']);
    // `stale` was made before both: the runner's cleanup must keep them, and land it on top.
    const landed = await f.land(f.submit(stale));
    assert.ok(landed?.type === "landed", JSON.stringify(landed));
    assert.equal(landed.base, second.commitId);
    assert.deepEqual(f.parents(second.commitId), [first.commitId]);
    assert.equal(jj(checkout, ["log", "-r", "rollover", "--no-graph", "-T", "commit_id"]), f.main());
    // A later landing still finds its integration branch.
    assert.equal((await f.land(f.submit(await f.candidate("after.txt"))))?.type, "landed");
  } finally { await f.dispose(); }
}, 120_000);

test("a Build-bound landing never starts before admission, holds no place in its lane, and once admitted still waits out a pause", async () => {
  const f = await fixture();
  try {
    const binding = { specId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", ticketIds: [], bodyRevision: null, bindGeneration: 1, sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" };
    const bound = newOperationId();
    f.log.append(bound, { type: "submitted", ...await f.candidate("bound.txt"), admission: { binding, specBodyHash: null, helperRevisions: [], repairsOperationId: null, supersedes: null } });
    const other = f.submit(await f.candidate("other.txt"));
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.result(other)?.type, "landed", JSON.stringify(f.result(other)));
    const pending = f.log.operation(bound)!;
    assert.ok(pending.kind === "landing" && pending.admission === "pending" && pending.status === "queued" && pending.runs.length === 0);
    assert.equal(pending.waitingFor, "Build admission");
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    f.log.append(bound, { type: "build_admitted", sequence: 1, sessionId: binding.sessionId, recordedAt: null });
    f.queue.wake(); await f.queue.idle();
    assert.deepEqual([f.log.operation(bound)!.status, f.log.operation(bound)!.stage], ["queued", "paused"]);
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "owner" });
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.result(bound)?.type, "landed", JSON.stringify(f.result(bound)));
  } finally { await f.dispose(); }
}, 120_000);

test("an admitted candidate waits while a newer one of its change awaits admission, and runs once Build refuses that one", async () => {
  const f = await fixture();
  try {
    const binding = { specId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", ticketIds: [], bodyRevision: null, bindGeneration: 1, sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" };
    const record = { binding, specBodyHash: null, helperRevisions: [], repairsOperationId: null, supersedes: null };
    const source = await f.candidate("held.txt");
    const admitted = newOperationId(), newer = newOperationId();
    f.log.append(admitted, { type: "submitted", ...source, admission: record });
    f.log.append(admitted, { type: "build_admitted", sequence: 1, sessionId: binding.sessionId, recordedAt: null });
    f.log.append(newer, { type: "submitted", ...source, admission: { ...record, supersedes: admitted } });
    f.queue.wake(); await f.queue.idle();
    const waiting = f.log.operation(admitted)!;
    assert.ok(waiting.status === "queued" && waiting.runs.length === 0 && waiting.waitingFor === "Build admission of a newer candidate", JSON.stringify(waiting));
    // Build refuses the newer one (a stale bind): the drain records it, and the queue starts the admitted candidate.
    const drain = createReceiptDrain({ log: f.log, route: () => Promise.resolve({ kind: "refused", code: "bind_generation_stale" }), onAdmissionSettled: f.queue.wake });
    drain.wake(); await drain.idle(); drain.close();
    await until(() => f.result(admitted)?.type === "landed" ? true : undefined);
    assert.equal(f.log.operation(newer)!.status, "declined");
  } finally { await f.dispose(); }
}, 120_000);

test("the candidate bookmark is gone from origin before any landing verdict, including after a restart or a queued cancel", async () => {
  const f = await fixture();
  try {
    const landed = f.submit(await f.candidate("landed.txt"));
    assert.equal((await f.land(landed))?.type, "landed");
    const failed = f.submit(await f.candidate("fail"));
    assert.equal((await f.land(failed))?.type, "failed");
    const interrupted = f.submit(await f.candidate("interrupted.txt"));
    f.log.append(interrupted, { type: "stage", stage: "verifying" });
    await f.queue.recover();
    assert.equal(f.result(interrupted)?.type, "failed");
    assert.deepEqual([landed, failed, interrupted].map((id) => f.candidateAtVerdict.get(id)), [false, false, false]);
    const request = await f.candidate("cancelled.txt");
    const cancelled = f.submit(request);
    f.log.append(cancelled, { type: "cancelled", reason: "cancelled by the author" });
    f.queue.cancelled(f.log.operation(cancelled)!);
    await f.queue.idle();
    assert.equal(execFileSync("git", ["--git-dir", f.origin, "for-each-ref", `refs/heads/${request.bookmark}`], { encoding: "utf8" }), "");
  } finally { await f.dispose(); }
}, 120_000);

test("unknown repositories and stale submitted commits fail without publishing", async () => {
  const f = await fixture();
  try {
    const before = f.main();
    const request = await f.candidate("stale.txt");
    const unknown = f.submit({ ...request, repo: "unknown/repo" });
    const stale = f.submit({ ...request, commitId: "f".repeat(40) });
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.result(unknown)?.type, "failed");
    assert.equal(f.result(stale)?.type, "failed");
    for (const id of [unknown, stale]) {
      const result = f.result(id);
      assert.ok(result?.type === "failed");
      assert.match(result.reason, id === unknown ? /not configured/ : /does not resolve to submitted commit/);
    }
    assert.equal(f.main(), before);
  } finally { await f.dispose(); }
}, 120_000);

test("gate commands get a temporary directory of their own checkout, emptied at each turn", async () => {
  const f = await fixture(false, true);
  try {
    for (const file of ["a.txt", "b.txt"]) {
      assert.equal((await f.land(f.submit(await f.candidate(file))))?.type, "landed");
      const outcome = await f.land(f.submitRelease(f.main()));
      assert.ok(outcome?.type === "released" && outcome.result.status === "released", JSON.stringify(outcome));
    }
    const turns = (await f.lines("release-tmp.jsonl")).map((line) => JSON.parse(line) as { tmp: string; stale: boolean });
    assert.equal(turns.length, 2);
    assert.equal(turns[0]!.tmp, turns[1]!.tmp);
    assert.notEqual(turns[0]!.tmp, tmpdir());
    assert.deepEqual(turns.map((turn) => turn.stale), [false, false]);
  } finally { await f.dispose(); }
}, 120_000);

test("a gate run's test reports become per-file rows, a missing or malformed one is recorded as such, and each stage records runner health", async () => {
  const reportingGate = () => 'const fs=require("node:fs"),p=require("node:path"),d=process.env.SLIPJAY_TEST_REPORT_DIR;'
    + 'if(!d)process.exit(9);'
    + 'if(fs.existsSync("report")){fs.writeFileSync(p.join(d,"v.json"),JSON.stringify({testResults:[{name:p.resolve("tests/a.test.ts"),startTime:0,endTime:120,status:"passed"}]}));'
    + 'fs.writeFileSync(p.join(d,"slipjay-test-reports.json"),JSON.stringify({version:1,reports:[{format:"vitest-json",path:"v.json",suite:"vitest",cwd:"."}]}));}'
    + 'if(fs.existsSync("bad-report"))fs.writeFileSync(p.join(d,"slipjay-test-reports.json"),"{");';
  const f = await fixture(false, false, undefined, false, { prefixGate: reportingGate });
  try {
    const reports = (id: string) => f.log.events({ operationId: id }).flatMap((row) => row.event.type === "test_report" ? [row.event] : []);
    // Each candidate builds on the last, so the files that make reports are added in this order.
    const silent = f.submit(await f.candidate("plain.txt"));
    assert.equal((await f.land(silent))?.type, "landed");
    assert.deepEqual(reports(silent).map((report) => report.status), ["missing"], "a gate that writes no report is recorded as missing");
    const reported = f.submit(await f.candidate("report"));
    assert.equal((await f.land(reported))?.type, "landed");
    assert.deepEqual(reports(reported).map(({ status, ...rest }) => [status, "files" in rest ? rest.files : []]),
      [["recorded", [{ file: "tests/a.test.ts", suite: "vitest", ms: 120, status: "passed" }]]]);
    const operation = f.log.operation(reported)!;
    assert.equal(operation.runs.find((run) => run.testReport)?.testReport?.status, "recorded");
    assert.ok(operation.startedAt && operation.startedAt >= operation.submittedAt);
    const stages = f.log.events({ operationId: reported }).flatMap((row) => row.event.type === "stage" ? [row.event] : []);
    assert.ok(stages.length && stages.every((stage) => stage.health && stage.health.cpus > 0 && stage.health.totalMemoryBytes > 0 && stage.health.running >= 1));

    const malformed = f.submit(await f.candidate("bad-report"));
    assert.equal((await f.land(malformed))?.type, "landed", "a malformed report never fails the gate");
    assert.deepEqual(reports(malformed).map((report) => report.status), ["malformed"]);

  } finally { await f.dispose(); }
}, 120_000);

test("a settings landing skips the gate only when policy settings are all it changes, and refuses a stale base or an unresolvable check", async () => {
  const f = await fixture();
  try {
    // A change on the integration tip that rewrites the policy and adds `files`; `base` is the digest of the policy it was read from.
    const change = async (edit: (text: string) => string, files: Record<string, string> = {}, base?: string) => {
      jj(f.author, ["git", "fetch", "--remote", "origin"]);
      jj(f.author, ["new", "main@origin"]);
      const text = await readFile(join(f.author, "slipjay.json"), "utf8");
      await writeFile(join(f.author, "slipjay.json"), edit(text));
      for (const [file, content] of Object.entries(files)) {
        await mkdir(join(f.author, file, ".."), { recursive: true });
        await writeFile(join(f.author, file), content);
      }
      jj(f.author, ["describe", "-m", `Settings change${base ? `\n\n${POLICY_BASE_TRAILER}: ${base}` : ""}`]);
      return { request: await f.push() };
    };
    const patch = (fields: PolicyPatch) => (text: string) => applyPolicyPatch(text, fields).text;
    const skipped = (id: string) => f.log.events({ operationId: id }).some((row) => row.event.type === "verification_skipped");
    const gated = (id: string) => f.log.operation(id)!.runs.some((run) => run.command === command);
    const landed = async (id: string) => { const result = await f.land(id); assert.equal(result?.type, "landed", JSON.stringify(result)); };

    // A JSON-only edit of a settings field lands without the gate, recording the skip and its reason.
    const spares = f.submit((await change(patch({ spares: 3 }))).request);
    await landed(spares);
    assert.ok(skipped(spares) && !gated(spares));
    const skip = f.log.events({ operationId: spares }).find((row) => row.event.type === "verification_skipped")?.event;
    assert.ok(skip?.type === "verification_skipped");
    assert.deepEqual(skip.fields, ["spares", "unattendedMergeToIntegration"]);
    assert.match(skip.reason, /landing checks are not run/);
    assert.equal(JSON.parse(f.remoteFile("slipjay.json")).spares, 3);

    // A script alone, or the policy with another file, takes the normal route.
    const script = f.submit(await f.candidate("scripts/settings.ts"));
    await landed(script);
    assert.ok(gated(script) && !skipped(script));
    const mixed = f.submit((await change(patch({ spares: 4 }), { "other.txt": "other\n" })).request);
    await landed(mixed);
    assert.ok(gated(mixed) && !skipped(mixed));

    // Two patches read from one base: the second is refused as stale once the first has changed the policy.
    const read = policyDigest(f.remoteFile("slipjay.json"));
    const firstId = f.submit((await change(patch({ spares: 5 }), {}, read)).request);
    const second = f.submit((await change(patch({ requiredLandingVerification: [{ executable: "node", args: ["-e", gate], concurrent: true }] }), {}, read)).request);
    await landed(firstId);
    const stale = await f.land(second);
    assert.equal(stale?.type, "failed", JSON.stringify(stale));
    assert.match(stale?.type === "failed" ? stale.reason : "", /refused as stale/);
    assert.equal(JSON.parse(f.remoteFile("slipjay.json")).spares, 5);

    // An edit that reaches a migration field is not a settings change.
    const migration = f.submit((await change((text) => JSON.stringify({ ...JSON.parse(text), spares: 6, migrationFinalization: {
      mode: "late_bound_serialized", triggerPaths: ["schema"], artifactPaths: ["migrations"],
      generate: { executable: "node", args: ["-e", generate] }, verify: { executable: "node", args: ["-e", ""] } } }, null, 2))).request);
    await landed(migration);
    assert.ok(gated(migration) && !skipped(migration));

    // A new check whose executable the runner cannot find is refused before integration.
    const before = f.main();
    const missing = f.submit((await change(patch({ requiredLandingVerification: [{ executable: "slipjay-no-such-tool", args: [] }] }))).request);
    const refused = await f.land(missing);
    assert.equal(refused?.type, "failed", JSON.stringify(refused));
    assert.match(refused?.type === "failed" ? refused.reason : "", /slipjay-no-such-tool, which does not resolve on the runner host/);
    assert.equal(f.main(), before);

    // Removing the gate is itself a settings change.
    const removal = f.submit((await change(patch({ requiredLandingVerification: [] }))).request);
    await landed(removal);
    assert.ok(skipped(removal) && !gated(removal));
    assert.deepEqual(JSON.parse(f.remoteFile("slipjay.json")).requiredLandingVerification, []);
  } finally { await f.dispose(); }
}, 300_000);
