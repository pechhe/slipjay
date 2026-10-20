import assert from "node:assert/strict";
import { admits, RUNNER_CONTROL_ID, runnerConfigProblem } from "../../src/lib/runner/runner-contract.ts";
import { newOperationId, openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { runnerLogOptions } from "../../src/lib/runner/runner-queue.ts";
import { test, until } from "./fixtures/runner-queue-fixture.ts";
import { landing, queueFixture, SHORT_MS, verified, waiting } from "./fixtures/short-landings.ts";

// The admission rule, the short class and the places a short landing may take (Build #3010); the lifecycle around them is in -lifecycle.

test("the admission rule caps long operations at workers and everything at one more", () => {
  const long = { short: false }, short = { short: true };
  assert.equal(admits(true, [long, long], 2, true), true, "a short landing gets the extra place beside two long operations");
  assert.equal(admits(false, [long, long], 2, true), false, "a long operation never does");
  assert.equal(admits(true, [long, long, short], 2, true), false, "nothing starts once workers + 1 run");
  assert.equal(admits(false, [long, short], 2, true), true, "a long operation starts while fewer than workers long ones run");
  assert.equal(admits(true, [], 2, true), true, "a short landing takes a free worker normally");
  assert.equal(admits(false, [short, short], 2, true), true, "short landings never hold a long operation back from its workers");
  assert.equal(admits(true, [long], 1, false), false, "without the short place nothing changes");
  assert.equal(admits(true, [], 1, false), true);
});

test("a repository is short when its verify p90 over the budget window is at or below the threshold, from enough samples", () => {
  const log = openOperationLog(":memory:", { shortLandingP90Ms: SHORT_MS });
  verified(log, "acme/fast", 10, SHORT_MS);
  verified(log, "acme/slow", 10, SHORT_MS + 1);
  verified(log, "acme/new", 9, 1_000);
  assert.equal(log.shortRepository("acme/fast"), true, "at the threshold is short");
  assert.equal(log.shortRepository("Acme/Fast"), true, "repositories match as everywhere else, by key");
  assert.equal(log.shortRepository("acme/slow"), false, "above it is not");
  assert.equal(log.shortRepository("acme/new"), false, "too few samples is not");
  assert.equal(log.shortRepository("acme/unknown"), false);
  // The class follows new samples: enough slow landings take the p90 over.
  verified(log, "acme/fast", 3, 600_000);
  assert.equal(log.shortRepository("acme/fast"), false);
  verified(log, "acme/new", 1, 1_000);
  assert.equal(log.shortRepository("acme/new"), true);
  log.close();
});

test("without enforced combined limits, or a threshold, no repository is short", () => {
  const log = openOperationLog(":memory:");
  verified(log, "acme/fast", 10, 1_000);
  assert.equal(log.shortRepository("acme/fast"), false);
  log.close();
  const config = { repos: { "acme/fast": { url: "file:///fast" } }, jj: { "user.name": "R", "user.email": "r@example.com" } };
  assert.equal(runnerLogOptions(config, { combinedLimits: false }).shortLandingP90Ms, undefined);
  assert.equal(runnerLogOptions(config, { combinedLimits: true }).shortLandingP90Ms, SHORT_MS, "the default threshold is 180 s");
  assert.equal(runnerLogOptions({ ...config, shortLandingP90Seconds: 30 }, { combinedLimits: true }).shortLandingP90Ms, 30_000, "the setting overrides it");
  assert.match(runnerConfigProblem({ ...config, shortLandingP90Seconds: 0 }) ?? "", /shortLandingP90Seconds/);
  assert.equal(runnerConfigProblem({ ...config, shortLandingP90Seconds: 90 }), null);
});

test("a waiting operation names the places the rule holds it by", () => {
  const log = openOperationLog(":memory:", { workers: 2, shortLandingP90Ms: SHORT_MS });
  for (const repo of ["acme/a", "acme/b", "acme/e"]) verified(log, repo, 10, 400_000);
  for (const repo of ["acme/c", "acme/d"]) verified(log, repo, 10, 20_000);
  const a = landing(log, "acme/a", "long"), b = landing(log, "acme/b", "long");
  const c = landing(log, "acme/c");
  assert.equal(waiting(log, c), undefined, "a short landing has a place beside two long ones");
  log.append(c, { type: "stage", stage: "fetching", shortLanding: true });
  const d = landing(log, "acme/d"), e = landing(log, "acme/e");
  assert.match(waiting(log, d) ?? "", /^every place \(landing .+, landing .+, landing .+\)$/, "a second short landing waits while three run");
  assert.match(waiting(log, e) ?? "", /^a worker \(landing [^,]+, landing [^,]+\)$/, "a long landing waits for the two long ones");
  assert.equal(log.openOperations().find((operation) => operation.id === c)?.shortLanding, true);
  log.append(a, { type: "landed", base: "main", commitId: "a".repeat(40), branch: "main", remote: "origin" });
  assert.equal(waiting(log, e), undefined, "once A finishes the long landing has a worker, while C still runs");
  assert.equal(waiting(log, d), undefined);
  void b;
  log.close();
});

test("a depth-two successor counts as long and names the workers holding it", () => {
  const log = openOperationLog(":memory:", { workers: 2, shortLandingP90Ms: SHORT_MS, depth: (repo) => repo === "acme/t" ? 2 : 1 });
  verified(log, "acme/a", 10, 400_000);
  verified(log, "acme/t", 10, 20_000);
  const a = landing(log, "acme/a", "long");
  const head = landing(log, "acme/t", "long");
  const successor = landing(log, "acme/t");
  assert.match(waiting(log, successor) ?? "", /^a worker \(/, "the successor waits for a worker, not the short place");
  log.append(a, { type: "landed", base: "main", commitId: "a".repeat(40), branch: "main", remote: "origin" });
  assert.match(waiting(log, successor) ?? "", /^landing /, "with a worker free it waits only on its own queue's head");
  void head;
  log.close();
});

test("an older release of its repository holds a depth-two successor back, and the successor names it", () => {
  const log = openOperationLog(":memory:", { workers: 2, shortLandingP90Ms: SHORT_MS, depth: (repo) => repo === "acme/t" ? 2 : 1 });
  verified(log, "acme/t", 10, 20_000);
  landing(log, "acme/t", "long");
  const release = newOperationId();
  log.append(release, { type: "submitted", kind: "release", repo: "acme/t", commitId: "e".repeat(40), migrationsReady: false, submittedBy: "test" });
  const successor = landing(log, "acme/t");
  assert.match(waiting(log, successor) ?? "", /^release /, "the queue fences it on the release, so the log names the release");
  log.close();
});

test("an older release of its repository holds a depth-two head back too, and the head names it", () => {
  const log = openOperationLog(":memory:", { workers: 2, shortLandingP90Ms: SHORT_MS, depth: (repo) => repo === "acme/t" ? 2 : 1 });
  verified(log, "acme/t", 10, 20_000);
  const release = newOperationId();
  log.append(release, { type: "submitted", kind: "release", repo: "acme/t", commitId: "e".repeat(40), migrationsReady: false, submittedBy: "test" });
  const head = landing(log, "acme/t");
  assert.match(waiting(log, head) ?? "", /^release /, "the queue fences a head on an older release as it does a successor");
  log.close();
});

test("a short landing starts beside two long ones, one more waits, and a long one starts when a long one ends", async () => {
  const { f, held, release, status, running, settle } = await queueFixture();
  try {
    for (const repo of ["fixture/c", "fixture/d"]) verified(f.log, repo, 10, 20_000, "failed");
    const a = await held("fixture/repo", "a"), b = await held("fixture/other", "b");
    await settle();
    await running(a); await running(b);
    const c = await held("fixture/c", "c");
    await settle();
    await running(c);
    assert.equal(f.log.operation(c)!.shortLanding, true, "the ledger records the place it took");
    // E arrives first: places go oldest first, so the worker A frees is E's.
    const e = await held("fixture/e", "e"), d = await held("fixture/d", "d");
    await settle();
    assert.equal(status(d), "queued", "a second short landing waits while three operations run");
    assert.match(f.log.operation(d)!.waitingFor ?? "", /^every place \(/);
    assert.equal(status(e), "queued", "a long landing waits for a worker");
    assert.match(f.log.operation(e)!.waitingFor ?? "", /^a worker \(/);
    await release("a");
    await until(() => f.result(a));
    assert.equal(f.result(a)?.type, "landed");
    await running(e);
    assert.equal(status(c), "running", "E started while C still runs");
    assert.equal(status(d), "queued");
    // A named kill of C frees its place for D.
    assert.equal(f.queue.kill(c).status, "killed");
    await until(() => f.result(c));
    await running(d);
    for (const name of ["b", "d", "e"]) await release(name);
    await f.queue.idle();
    for (const id of [b, d, e]) assert.equal(f.result(id)?.type, "landed", JSON.stringify(f.result(id)));
    assert.equal(f.result(c)?.type, "cancelled");
  } finally { for (const name of ["a", "b", "c", "d", "e"]) await release(name); await f.dispose(); }
}, 180_000);

test("short landings take free workers normally, and a long operation still gets its worker beside them", async () => {
  const { f, held, release, running, settle } = await queueFixture({ other: false, extra: ["Fixture/C", "Fixture/D"] });
  try {
    for (const repo of ["fixture/c", "fixture/d"]) verified(f.log, repo, 10, 20_000, "failed");
    const c = await held("fixture/c", "c"), d = await held("fixture/d", "d");
    await settle();
    await running(c); await running(d);
    assert.equal(f.log.operation(c)!.shortLanding, true);
    const a = await held("fixture/repo", "a");
    await settle();
    await running(a);
    for (const name of ["a", "c", "d"]) await release(name);
    await f.queue.idle();
  } finally { for (const name of ["a", "c", "d"]) await release(name); await f.dispose(); }
}, 180_000);

test("a release never takes the short place, and a pause admits nothing", async () => {
  const { f, held, release, status, running, settle } = await queueFixture({ extra: ["Fixture/C", "Fixture/E"] }, true);
  try {
    // The release's own repository is short: the class is a landing's alone.
    for (const repo of ["fixture/repo", "fixture/c"]) verified(f.log, repo, 10, 20_000, "failed");
    const b = await held("fixture/other", "b"), e = await held("fixture/e", "e");
    await settle();
    await running(b); await running(e);
    const promotion = f.submitRelease(f.main());
    await settle();
    assert.equal(status(promotion), "queued", "a release counts as long");
    assert.match(f.log.operation(promotion)!.waitingFor ?? "", /^a worker \(/);
    f.log.append(RUNNER_CONTROL_ID, { type: "paused", by: "owner" });
    const c = await held("fixture/c", "c");
    await settle();
    assert.equal(status(c), "queued", "paused, not even a short landing starts");
    f.log.append(RUNNER_CONTROL_ID, { type: "resumed", by: "owner" });
    await settle();
    await running(c);
    assert.equal(status(promotion), "queued");
    for (const name of ["b", "c", "e"]) await release(name);
    await f.queue.idle();
    assert.equal(f.result(promotion)?.type, "released", JSON.stringify(f.result(promotion)));
  } finally { for (const name of ["b", "c", "e"]) await release(name); await f.dispose(); }
}, 180_000);

test("resets, audits and recoveries of short repositories never take the short place, and a short landing never passes its lane's older work", async () => {
  const { f, held, release, status, running, settle } = await queueFixture({ extra: ["Fixture/C", "Fixture/D", "Fixture/E", "Fixture/F"] }, false, true);
  try {
    for (const repo of ["fixture/repo", "fixture/c", "fixture/d", "fixture/f"]) verified(f.log, repo, 10, 20_000, "failed");
    const b = await held("fixture/other", "b"), e = await held("fixture/e", "e");
    await settle();
    await running(b); await running(e);
    const reset = f.submitReset();
    const audit = newOperationId();
    f.log.append(audit, { type: "submitted", kind: "audit", repo: "fixture/d", commitId: "", slot: new Date().toISOString(), submittedBy: "test" });
    const recovery = newOperationId();
    f.log.append(recovery, { type: "submitted", kind: "recovery", repo: "fixture/f", commitId: "f".repeat(40), submittedBy: "test" });
    // A short landing behind its own repository's reset, and one of another short repository.
    const behind = await held("fixture/repo", "r"), c = await held("fixture/c", "c");
    await settle();
    await running(c);
    for (const id of [reset, audit, recovery]) {
      assert.equal(status(id), "queued", `a ${f.log.operation(id)!.kind} of a short repository counts as long`);
      assert.match(f.log.operation(id)!.waitingFor ?? "", /^a worker \(/);
    }
    assert.equal(status(behind), "queued", "the short place does not let a landing pass its repository's reset");
    assert.equal(f.log.operation(behind)!.waitingFor, `reset ${f.log.operation(reset)!.commitId.slice(0, 12)}`, "and it says so");
    for (const name of ["b", "c", "e", "r"]) await release(name);
    await f.queue.idle();
    const first = (id: string) => f.log.events({ operationId: id }).find(({ event }) => event.type === "stage")?.seq ?? Infinity;
    assert.ok(first(reset) < first(behind), "the reset started first");
    for (const id of [reset, audit, recovery, behind]) assert.notEqual(status(id), "queued");
  } finally { for (const name of ["b", "c", "e", "r"]) await release(name); await f.dispose(); }
}, 180_000);
