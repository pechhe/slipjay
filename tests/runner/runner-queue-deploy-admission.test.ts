import assert from "node:assert/strict";
import { join } from "node:path";
import { newOperationId, openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { runnerConfigProblem } from "../../src/lib/runner/runner-contract.ts";
import { test, fixture, until, hanging, started } from "./fixtures/runner-queue-fixture.ts";

test("two workers verify beside a deploy, while another deploy of the same repository waits", async () => {
  const f = await fixture(false, false, { minIntervalMs: 3_600_000 }, false, { workers: 2, other: true });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const original = f.executor.run.bind(f.executor);
  let entered = false;
  try {
    assert.equal((await f.land(f.submit(await f.candidate("seed.txt"))))?.type, "landed");
    f.executor.run = async (request) => {
      if (request.env?.SLIPJAY_DEPLOY_ENVIRONMENT) { entered = true; await held; }
      return original(request);
    };
    const deploy = () => {
      const id = newOperationId();
      f.log.append(id, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "staging", commitId: f.main(), submittedBy: "test" });
      f.queue.wake();
      return id;
    };
    const first = deploy();
    await until(() => entered || undefined);
    const second = deploy();
    assert.equal(f.log.operation(second)?.status, "queued");
    assert.match(f.log.operation(second)?.waitingFor ?? "", /^deploy /);
    const aPids = join(f.root, "a-pids.json"), bPids = join(f.root, "b-pids.json");
    const a = f.submit(await hanging(f, aPids));
    const b = f.submit(await hanging(f, bPids, f.otherAuthor, "fixture/other"));
    f.queue.wake();
    await Promise.all([started(aPids), started(bPids)]);
    for (const id of [a, b]) assert.equal(f.log.operation(id)?.stage, "verifying");
    assert.equal(f.log.operation(first)?.stage, "deploying");
    assert.equal(f.log.operation(second)?.status, "queued");
    for (const id of [a, b]) assert.equal(f.queue.kill(id).status, "killed");
    release();
    await f.queue.idle();
    assert.equal(f.result(first)?.type, "deployed");
    assert.equal(f.result(second)?.type, "deployed");
  } finally { release(); await f.dispose(); }
}, 120_000);

test("deploy capacity is configurable, per repository, and names its blockers without using landing workers", () => {
  const config = { repos: {}, jj: { "user.name": "Fixture", "user.email": "fixture@example.com" } };
  for (const value of [0, -1, 1.5, NaN, Infinity]) assert.match(runnerConfigProblem({ ...config, deployWorkers: value }) ?? "", /deployWorkers/);
  assert.equal(runnerConfigProblem({ ...config, deployWorkers: 2 }), null);
  const log = openOperationLog(":memory:", { workers: 2, deployWorkers: 2 });
  try {
    for (const [id, repo, running] of [["a", "acme/a", true], ["b", "acme/b", true], ["a2", "ACME/A", false], ["c", "acme/c", false]] as const) {
      log.append(id, { type: "submitted", kind: "deploy", repo, environment: "staging", commitId: id.repeat(40), submittedBy: "test" });
      if (running) log.append(id, { type: "stage", stage: "deploying" });
    }
    assert.match(log.operation("a2")?.waitingFor ?? "", /^deploy /);
    assert.equal(log.operation("c")?.waitingFor?.split(", ").length, 2);
    log.append("a", { type: "failed", stage: "deploying", reason: "fixture" });
    assert.equal(log.operation("c")?.waitingFor, undefined);
    assert.equal(log.operation("a2")?.waitingFor, undefined);
  } finally { log.close(); }
});

test("a spare deploy place admits a newly submitted repository past an older deploy of a busy repository", async () => {
  const f = await fixture(false, false, { minIntervalMs: 3_600_000 }, false, { workers: 2, deployWorkers: 2, other: true });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const original = f.executor.run.bind(f.executor);
  const entered = new Set<string>();
  try {
    await f.land(f.submit(await f.candidate("seed-a.txt")));
    await f.land(f.submit(await f.candidate("seed-b.txt", f.otherAuthor, "fixture/other")));
    f.executor.run = async (request) => {
      if (request.env?.SLIPJAY_DEPLOY_ENVIRONMENT) { entered.add(request.env.SLIPJAY_DEPLOY_COMMIT!); await held; }
      return original(request);
    };
    const submit = (repo: string, commitId: string) => {
      const id = newOperationId();
      f.log.append(id, { type: "submitted", kind: "deploy", repo, environment: "staging", commitId, submittedBy: "test" });
      f.queue.wake(); return id;
    };
    submit("fixture/repo", f.main());
    await until(() => entered.has(f.main()) || undefined);
    const behind = submit("fixture/repo", f.main());
    const beside = submit("fixture/other", f.otherMain());
    await until(() => entered.has(f.otherMain()) || undefined);
    assert.equal(f.log.operation(behind)?.status, "queued");
    assert.equal(f.log.operation(beside)?.stage, "deploying");
    release(); await f.queue.idle();
    assert.equal(f.result(behind)?.type, "deployed");
    assert.equal(f.result(beside)?.type, "deployed");
  } finally { release(); await f.dispose(); }
}, 120_000);

test("the default deploy budget is one, and a host without combined limits names the deploy sharing its only worker", () => {
  for (const separateDeploys of [true, false]) {
    const log = openOperationLog(":memory:", { workers: 1, separateDeploys });
    try {
      log.append("deploy", { type: "submitted", kind: "deploy", repo: "acme/a", environment: "staging", commitId: "a".repeat(40), submittedBy: "test" });
      log.append("deploy", { type: "stage", stage: "deploying" });
      log.append("other-deploy", { type: "submitted", kind: "deploy", repo: "acme/b", environment: "staging", commitId: "b".repeat(40), submittedBy: "test" });
      assert.match(log.operation("other-deploy")?.waitingFor ?? "", /^deploy /);
      log.append("landing", { type: "submitted", repo: "acme/c", changeId: "c".repeat(32), commitId: "c".repeat(40), bookmark: "candidate", submittedBy: "test" });
      if (separateDeploys) assert.equal(log.operation("landing")?.waitingFor, undefined);
      else assert.match(log.operation("landing")?.waitingFor ?? "", /^a worker \(deploy /);
    } finally { log.close(); }
  }
});

test("without combined limits a deploy queued behind a landing runs before a newer landing", async () => {
  const f = await fixture(false, false, { minIntervalMs: 3_600_000 }, false, { combinedLimits: false });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const original = f.executor.run.bind(f.executor);
  let entered = false;
  try {
    await f.land(f.submit(await f.candidate("seed.txt")));
    f.executor.run = async (request) => {
      if (request.env?.SLIPJAY_DEPLOY_ENVIRONMENT) { entered = true; await held; }
      return original(request);
    };
    const firstPids = join(f.root, "first-pids.json"), laterPids = join(f.root, "later-pids.json");
    const first = f.submit(await hanging(f, firstPids));
    f.queue.wake(); await started(firstPids);
    const deploy = newOperationId();
    f.log.append(deploy, { type: "submitted", kind: "deploy", repo: "fixture/repo", environment: "staging", commitId: f.main(), submittedBy: "test" });
    f.queue.wake();
    assert.equal(f.log.operation(deploy)?.status, "queued");
    const later = f.submit(await hanging(f, laterPids));
    f.queue.wake();
    assert.equal(f.log.operation(later)?.status, "queued");
    assert.equal(f.queue.kill(first).status, "killed");
    await until(() => entered || undefined);
    assert.equal(f.log.operation(deploy)?.stage, "deploying");
    assert.equal(f.log.operation(later)?.status, "queued", "the older deploy gets the shared place first");
    assert.match(f.log.operation(later)?.waitingFor ?? "", /deploy /);
    release();
    await started(laterPids);
    assert.equal(f.result(deploy)?.type, "deployed");
    assert.equal(f.queue.kill(later).status, "killed");
    await f.queue.idle();
  } finally {
    release();
    for (const operation of f.log.openOperations()) if (operation.kind === "landing" && operation.status === "running") f.queue.kill(operation.id);
    await f.dispose();
  }
}, 120_000);

test("unexpected deploy completion errors are recorded without losing a committed verdict", async () => {
  const f = await fixture(false, false, { minIntervalMs: 3_600_000 });
  const original = f.log.append.bind(f.log);
  try {
    await f.land(f.submit(await f.candidate("seed.txt")));
    for (const committed of [false, true]) {
      let injected = false;
      f.log.append = (id, event) => {
        if (event.type === "deployed" && !injected) {
          injected = true;
          if (committed) original(id, event);
          throw new Error("fixture completion error");
        }
        return original(id, event);
      };
      const deploy = await f.deploy(f.main());
      assert.equal(injected, true);
      const result = f.result(deploy);
      assert.equal(result?.type, committed ? "deployed" : "failed");
      if (result?.type === "failed") assert.equal(result.reason, "fixture completion error");
      else assert.ok(f.log.events({ operationId: deploy }).some(({ event }) => event.type === "progress" && event.line === "fixture completion error"));
      if (result?.type === "deployed") {
        assert.ok(result.record.durationMs! >= 0);
        assert.ok(Number.isFinite(Date.parse(result.record.startedAt!)));
      }
    }
  } finally { f.log.append = original; await f.dispose(); }
}, 120_000);
