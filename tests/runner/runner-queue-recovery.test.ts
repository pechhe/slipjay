import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RUNNER_CONTROL_ID, TERMINAL_EVENT_TYPES } from "../../src/lib/runner/runner-contract.ts";
import { importSubmissionSource, retainSubmissionSource } from "../../src/lib/landing/submission-source.ts";
import { TEST_SLICE } from "../support/executor.ts";
import { test, jj, fixture, until, exactPrefixGate } from "./fixtures/runner-queue-fixture.ts";

test("recovery fails interrupted verification and leaves queued operations for wake", async () => {
  const f = await fixture();
  try {
    const interrupted = f.submit(await f.candidate("interrupted.txt"));
    f.log.append(interrupted, { type: "stage", stage: "verifying" });
    const queued = f.submit(await f.candidate("queued.txt"));
    await f.queue.recover();
    assert.deepEqual(f.result(interrupted), { type: "failed", stage: "verifying", reason: "runner restarted during verifying; land again" });
    assert.equal(f.log.operation(queued)!.status, "queued");
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.result(queued)?.type, "landed", JSON.stringify(f.result(queued)));
  } finally { await f.dispose(); }
}, 120_000);

test("restart recovery closes both interrupted lanes once, preserves a pause and leaves unrelated queued work recoverable", async () => {
  const f = await fixture(false, true, undefined, false, { other: true });
  try {
    const integration = f.main();
    const releaseBase = f.releaseRef();
    const candidate = await f.candidate("interrupted.txt");
    const landing = f.submit(candidate);
    const release = f.submitRelease(integration);
    const other = f.submit(await f.candidate("queued.txt", f.otherAuthor, "fixture/other"));
    f.log.append(landing, { type: "stage", stage: "verifying" });
    f.log.append(release, { type: "stage", stage: "verifying" });
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    await f.queue.recover();
    await f.queue.recover();
    for (const id of [landing, release]) {
      assert.equal(f.result(id)?.type, "failed");
      assert.equal(f.log.events({ operationId: id }).filter(({ event }) => TERMINAL_EVENT_TYPES.includes(event.type as never)).length, 1);
    }
    assert.equal(f.main(), integration);
    assert.equal(f.releaseRef(), releaseBase);
    assert.equal(f.log.operation(other)!.stage, "paused");
    f.queue.wake();
    await f.queue.idle();
    assert.equal(f.log.operation(other)!.status, "queued");
    // Recovery never invents a source retry or publication for either interrupted operation.
    assert.equal(jj(f.author, ["--ignore-working-copy", "log", "-r", candidate.commitId, "--no-graph", "-T", "commit_id"]), candidate.commitId);
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "owner" });
    assert.equal((await f.land(other))?.type, "landed");
    assert.equal(f.result(landing)?.type, "failed");
    assert.equal(f.result(release)?.type, "failed");
  } finally { await f.dispose(); }
}, 120_000);

test("recovery recognizes an integrated commit published before the runner stopped", async () => {
  const f = await fixture();
  try {
    const request = await f.candidate("published.txt");
    const original = f.submit(request);
    f.queue.wake(); await f.queue.idle();
    const landed = f.result(original);
    assert.equal(landed?.type, "landed", JSON.stringify(landed));
    if (landed?.type !== "landed") throw new Error("Expected publication");
    const interrupted = f.submit(request);
    f.log.append(interrupted, { type: "stage", stage: "publishing" });
    f.log.append(interrupted, { type: "integrated", base: landed.base, commitId: landed.commitId });
    const checkout = join(f.home, "repos", "fixture/repo");
    jj(checkout, ["git", "remote", "set-url", "origin", join(f.root, "unavailable-origin.git")]);
    try {
      await f.queue.recover();
      assert.deepEqual(f.result(interrupted), { type: "failed", stage: "publishing", reason: "runner restarted during publishing; land again" });
      const [hold] = f.log.snapshot(f.executor.host).held;
      assert.ok(hold);
      assert.equal(hold.repo, "fixture/repo");
      assert.equal(hold.commitId, landed.commitId);
      assert.match(hold.reason, /unconfirmed/);
      assert.equal(f.log.openOperations().length, 0);
      await f.queue.recover();
      assert.deepEqual(f.log.snapshot(f.executor.host).held, [hold]);
    } finally {
      jj(checkout, ["git", "remote", "set-url", "origin", f.origin]);
    }
    await f.queue.recover();
    assert.deepEqual(f.log.snapshot(f.executor.host).held, []);
    const recovering = f.submit(request);
    f.log.append(recovering, { type: "stage", stage: "publishing" });
    f.log.append(recovering, { type: "integrated", base: landed.base, commitId: landed.commitId });
    await f.queue.recover();
    assert.deepEqual(f.result(recovering), landed);
    const unpublished = f.submit(request);
    f.log.append(unpublished, { type: "stage", stage: "publishing" });
    f.log.append(unpublished, { type: "integrated", base: landed.base, commitId: "f".repeat(40) });
    await f.queue.recover();
    assert.deepEqual(f.result(unpublished), { type: "failed", stage: "publishing", reason: "runner restarted during publishing; land again" });
  } finally { await f.dispose(); }
}, 120_000);

test("depth-two restart uses exact publication intent when integration was not yet recorded", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2 });
  try {
    const request = await f.candidate("a.txt");
    const first = f.submit(request);
    const result = await f.land(first);
    assert.ok(result?.type === "landed", JSON.stringify(result));
    const interrupted = f.submit(request);
    f.log.append(interrupted, { type: "stage", stage: "integrating" });
    f.log.append(interrupted, { type: "publication_intent", attempt: 1, base: result.base, candidate: result.commitId });
    await f.queue.recover();
    assert.equal(f.result(interrupted)?.type, "landed", JSON.stringify(f.result(interrupted)));
    assert.deepEqual(f.log.events({ operationId: interrupted }).filter((row) => row.event.type === "integrated").map((row) => row.event),
      [{ type: "integrated", base: result.base, commitId: result.commitId }]);
    assert.equal(f.main(), result.commitId);
  } finally { await f.dispose(); }
}, 120_000);


test("depth-two second remote move exhausts the one-rebuild bound and retains both attempts", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  let unsubscribe = () => {};
  try {
    const moved: string[] = [];
    unsubscribe = f.log.subscribe((row) => {
      if (row.event.type !== "verification_passed") return;
      const base = f.main();
      const commit = execFileSync("git", ["--git-dir", f.origin, "commit-tree", `${base}^{tree}`, "-p", base, "-m", `external move ${moved.length + 1}`],
        { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "f@example.com", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "f@example.com" } }).trim();
      execFileSync("git", ["--git-dir", f.origin, "update-ref", "refs/heads/main", commit, base]);
      moved.push(commit);
    });
    const request = await f.candidate("a.txt");
    const a = f.submit(request);
    await f.land(a);
    assert.equal(f.result(a)?.type, "failed", JSON.stringify(f.result(a)));
    assert.match(JSON.stringify(f.result(a)), /Remote integration changed/);
    assert.equal(moved.length, 2);
    assert.equal(f.main(), moved[1]);
    const events = f.log.events({ operationId: a }).map((row) => row.event);
    const prepared = events.filter((event) => event.type === "attempt_prepared");
    assert.deepEqual(prepared.map((event) => event.attempt), [1, 2]);
    assert.equal(events.filter((event) => event.type === "attempt_invalidated").length, 2);
    assert.ok(!events.some((event) => event.type === "integrated"));
    for (const event of prepared) {
      assert.equal(event.source, request.commitId);
      assert.equal(jj(event.checkout, ["log", "-r", event.candidate, "--no-graph", "-T", "commit_id"]), event.candidate);
    }
    await f.queue.recover(); await f.queue.recover();
    assert.deepEqual(f.result(a)?.type, "failed");
    assert.equal(f.log.events({ operationId: a }).filter((row) => row.event.type === "failed").length, 1);
  } finally { unsubscribe(); await f.dispose(); }
}, 120_000);

test("depth-two executor loss invalidates dependent evidence and releases verifier ownership", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate });
  const run = f.executor.run;
  try {
    await writeFile(join(f.root, "hold-a"), "");
    await writeFile(join(f.root, "a-gone"), "");
    const original = await f.candidate("a.txt");
    const a = f.submit(original);
    const b = f.submit(await f.candidate("b.txt"));
    f.executor.run = async (request) => {
      if (request.args.includes(exactPrefixGate(f.root)) && await stat(join(request.cwd, "a.txt")).then(() => true, () => false)
        && !await stat(join(request.cwd, "b.txt")).then(() => true, () => false)) {
        await until(() => f.log.operation(b)?.stage === "waiting-for-predecessor" || f.result(b) || undefined);
        throw new Error("fixture executor connection lost");
      }
      return run(request);
    };
    await f.land(a);
    assert.equal(f.result(a)?.type, "failed", JSON.stringify(f.result(a)));
    assert.match(JSON.stringify(f.result(a)), /executor connection lost/);
    // B's combined evidence is invalidated; it rebuilds alone on the unchanged base and lands.
    await until(() => f.result(b));
    assert.equal(f.result(b)?.type, "landed", JSON.stringify(f.result(b)));
    assert.ok(f.log.events({ operationId: b }).some((row) => row.event.type === "attempt_invalidated" && /predecessor/i.test(row.event.reason)));
    assert.ok(!f.log.events({ operationId: a }).some((row) => row.event.type === "integrated"));
    assert.equal(f.log.operation(a)!.runs.length, 1);
    assert.equal(f.log.operation(a)!.runs[0]!.exitCode, null);
    const artifacts = [a, b].flatMap((id) => f.log.events({ operationId: id }).map((row) => row.event).filter((event) => event.type === "attempt_prepared"));
    assert.equal(artifacts.length, 3, "A's attempt, B's invalidated attempt and B's rebuild");
    f.executor.run = run;
    await rm(join(f.root, "hold-a"));
    const next = f.submit(await f.candidate("next.txt"));
    assert.equal((await f.land(next))?.type, "landed", JSON.stringify(f.result(next)));
    for (const event of artifacts)
      assert.equal(jj(event.checkout, ["log", "-r", event.candidate, "--no-graph", "-T", "commit_id"]), event.candidate);
    await f.queue.recover(); await f.queue.recover();
    assert.equal(f.log.events({ operationId: a }).filter((row) => row.event.type === "failed").length, 1);
    assert.deepEqual(f.log.events({ operationId: b }).filter((row) => row.event.type === "failed" || row.event.type === "landed").map((row) => row.event.type), ["landed"]);
  } finally { f.executor.run = run; await rm(join(f.root, "hold-a"), { force: true }); await f.dispose(); }
}, 120_000);


test("depth-two actual runner process loss retains durable attempts and recovers each outcome once", async () => {
  const f = await fixture(false, false, undefined, false, { verificationDepth: 2, prefixGate: exactPrefixGate, durable: true });
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  let stderr = "";
  try {
    const base = f.main();
    const original = await f.candidate("a.txt");
    const a = f.submit(original);
    const b = f.submit(await f.candidate("b.txt"));
    const driver = `
      import { createRunnerQueue } from ${JSON.stringify(new URL("../../src/lib/runner/runner-queue.ts", import.meta.url).href)};
      import { localExecutor } from ${JSON.stringify(new URL("../../src/lib/runner/local-executor.ts", import.meta.url).href)};
      import { openOperationLog } from ${JSON.stringify(new URL("../../src/lib/runner/runner-log.ts", import.meta.url).href)};
      import { existsSync } from 'node:fs'; import { join } from 'node:path';
      const local = localExecutor({ slice: ${JSON.stringify(TEST_SLICE)} });
      const executor = { host: local.host, combinedLimits: true, run: (request) => {
        // The worker loses its process while awaiting its external executor: no child gate is orphaned by this fixture.
        if (existsSync(join(request.cwd, 'a.txt')) && !existsSync(join(request.cwd, 'b.txt')))
          return new Promise(() => {});
        return local.run(request);
      }};
      const log = openOperationLog(${JSON.stringify(f.logPath)});
      const queue = createRunnerQueue({log, executor, home:${JSON.stringify(f.home)}, config:{repos:{'Fixture/Repo':{url:${JSON.stringify(f.origin)},verificationDepth:2}},jj:{'user.name':'Runner Identity','user.email':'runner@example.com'}}});
      queue.wake(); setInterval(()=>{},1000);
    `;
    child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", driver], { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr!.on("data", (data) => { stderr += data.toString(); });
    exited = new Promise((resolve) => child!.once("exit", resolve));
    await until(() => {
      assert.equal(child!.exitCode, null, stderr);
      return f.log.operation(b)?.stage === "waiting-for-predecessor" || undefined;
    });
    const artifacts = [a, b].flatMap((id) => f.log.events({ operationId: id }).map((row) => row.event).filter((event) => event.type === "attempt_prepared"));
    assert.equal(artifacts.length, 2);
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "fixture-owner" });
    child.kill("SIGKILL"); await exited;
    await f.queue.recover(); await f.queue.recover();
    assert.equal(f.main(), base);
    assert.ok(f.log.paused());
    for (const id of [a, b]) {
      assert.equal(f.result(id)?.type, "failed", JSON.stringify(f.result(id)));
      assert.match(JSON.stringify(f.result(id)), /runner restarted/);
      assert.equal(f.log.events({ operationId: id }).filter((row) => row.event.type === "failed").length, 1);
      assert.ok(!f.log.events({ operationId: id }).some((row) => row.event.type === "integrated"));
    }
    const retry = f.submit(original);
    f.queue.wake(); await f.queue.idle();
    assert.equal(f.log.operation(retry)?.status, "queued");
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "fixture-owner" });
    assert.equal((await f.land(retry))?.type, "landed", JSON.stringify(f.result(retry)));
    assert.equal(f.log.operation(retry)!.commitId, original.commitId);
    assert.equal(f.log.events().filter((row) => row.event.type === "integrated").length, 1);
    for (const event of artifacts)
      assert.equal(jj(event.checkout, ["log", "-r", event.candidate, "--no-graph", "-T", "commit_id"]), event.candidate);
  } finally { child?.kill("SIGKILL"); await exited; await f.dispose(); }
}, 120_000);


test("recovery finds a retained submission's integration under its duplicate's change ID before it was recorded", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.land(f.submit(await f.candidate("first.txt"))))?.type, "landed");
    const request = await f.candidate("retained.txt");
    const id = f.submit(request);
    const retained = await retainSubmissionSource({ home: f.home, operationId: id, request, url: f.origin, executor: f.executor });
    f.log.append(id, retained);
    // The runner verified a duplicate of the source, moved the integration bookmark to it, and stopped before recording that.
    const checkout = join(f.home, "repos", "fixture/repo");
    await importSubmissionSource(f.home, request.repo, id, retained, checkout);
    jj(checkout, ["duplicate", request.commitId, "--onto", "main@origin"]);
    const duplicate = jj(checkout, ["log", "-r", `heads(main@origin+ ~ ${request.commitId}) & description(substring:"retained.txt")`, "--no-graph", "-T", "commit_id"]);
    assert.match(duplicate, /^[a-f0-9]{40}$/);
    jj(checkout, ["bookmark", "set", "main", "-r", duplicate]);
    f.log.append(id, { type: "stage", stage: "verifying" });
    f.log.append(id, { type: "verification_passed", base: f.main(), candidate: duplicate });
    f.log.append(id, { type: "stage", stage: "integrating" });
    await f.queue.recover();
    const events = f.log.events({ operationId: id }).map((row) => row.event);
    assert.ok(events.some((event) => event.type === "integrated" && event.commitId === duplicate), "the unrecorded integration is recognised, not dropped");
    assert.ok(f.log.snapshot(f.executor.host).held.some((entry) => entry.commitId === duplicate));
  } finally { await f.dispose(); }
}, 120_000);

for (const verificationDepth of [1, 2] as const) {
  test(`retained merge source preserves ancestry through depth-${verificationDepth} preparation and publication`, async () => {
    const f = await fixture(false, false, undefined, false, { verificationDepth });
    try {
      const initial = f.main();
      jj(f.author, ["new", initial, "-m", "Upstream one"]);
      await writeFile(join(f.author, "upstream-one.txt"), "one\n");
      jj(f.author, ["new", "-m", "Upstream two"]);
      await writeFile(join(f.author, "upstream-two.txt"), "two\n");
      const upstream = jj(f.author, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
      jj(f.author, ["new", initial, "-m", "Feature title"]);
      await writeFile(join(f.author, "feature.txt"), "feature\n");
      const feature = jj(f.author, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
      jj(f.author, ["new", feature, upstream, "-m", "Merge upstream"]);
      jj(f.author, ["new", "-m", "Review fix"]);
      await writeFile(join(f.author, "fix.txt"), "fix\n");
      const request = await f.push();
      assert.equal((await f.land(f.submit(await f.candidate("meanwhile.txt"))))?.type, "landed");
      const base = f.main();
      const id = f.submit(request);
      const retained = await retainSubmissionSource({ home: f.home, operationId: id, request, url: f.origin, executor: f.executor });
      f.log.append(id, retained);
      const result = await f.land(id);
      assert.ok(result?.type === "landed", JSON.stringify(result));
      assert.equal(result.base, base);
      assert.equal(f.main(), result.commitId);
      assert.deepEqual(f.parents(result.commitId), [base, upstream], "one assembled feature merge keeps the original upstream parent");
      const git = (...args: string[]) => execFileSync("git", ["--git-dir", f.origin, ...args], { encoding: "utf8" }).trim();
      assert.equal(git("diff", "--name-only", request.commitId, result.commitId), "meanwhile.txt",
        "the full submitted tree is preserved alongside the newer integration change");
      assert.equal(git("log", "-1", "--format=%s", result.commitId), "Feature title");
      assert.deepEqual(git("log", `${base}..${result.commitId}`, "--format=%s").split("\n").sort(),
        ["Feature title", "Upstream one", "Upstream two"], "merged-in commits keep their identity instead of being copied or flattened");
      for (const [file, content] of [["feature.txt", "feature"], ["fix.txt", "fix"], ["upstream-one.txt", "one"], ["upstream-two.txt", "two"], ["meanwhile.txt", "meanwhile.txt"]])
        assert.equal(f.remoteFile(file!), content);
      const passed = f.log.events({ operationId: id }).map(({ event }) => event).find((event) => event.type === "verification_passed");
      assert.ok(passed?.type === "verification_passed" && passed.base === base && passed.candidate === result.commitId);
      assert.equal(f.log.operation(id)!.commitId, request.commitId, "submission identity remains the immutable original");
      const checkout = join(f.home, verificationDepth === 2 ? "verifiers" : "repos", "fixture/repo", ...verificationDepth === 2 ? ["0"] : []);
      assert.equal(jj(checkout, ["log", "-r", request.commitId, "--no-graph", "-T", "commit_id"]), request.commitId);
      f.queue.wake(); await f.queue.idle();
      assert.equal(f.main(), result.commitId, "completed merge publication is not repeated");
    } finally { await f.dispose(); }
  }, 120_000);
}

test("queued retained source lands after author and upstream candidate loss with a cold runner checkout", async () => {
  for (const verificationDepth of [1, 2] as const) {
    const f = await fixture(false, false, undefined, false, { verificationDepth });
    try {
      const request = await f.candidate("retained-candidate.txt");
      const id = f.submit(request);
      const retained = await retainSubmissionSource({ home: f.home, operationId: id, request, url: f.origin, executor: f.executor });
      f.log.append(id, retained);
      execFileSync("git", ["--git-dir", f.origin, "update-ref", "-d", `refs/heads/${request.bookmark}`]);
      execFileSync("git", ["--git-dir", f.origin, "gc", "--prune=now"]);
      await rm(f.author, { recursive: true, force: true });
      const result = await f.land(id);
      assert.equal(result?.type, "landed", JSON.stringify(result));
      assert.equal(f.remoteFile("retained-candidate.txt"), "retained-candidate.txt");
      const before = f.main();
      f.queue.wake(); await f.queue.idle();
      assert.equal(f.main(), before, "following/restarting a completed attempt cannot publish it twice");
    } finally { await f.dispose(); }
  }
}, 120_000);
