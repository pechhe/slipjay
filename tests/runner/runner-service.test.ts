import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { repositoryLane, runnerConfigProblem } from "../../src/lib/runner/runner-contract.ts";
import { startRunner } from "../../src/lib/runner/runner-service.ts";
import { newOperationId, openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { directExecutor } from "../support/executor.ts";

test("the runner refuses to start without the commit identity its config must name", async () => {
  const home = await mkdtemp(join(tmpdir(), "slipjay-runner-"));
  try {
    await writeFile(join(home, "config.json"), JSON.stringify({ repos: {}, jj: { "user.name": "Runner Identity" } }));
    await assert.rejects(startRunner({ home, env: { SLIPJAY_RUNNER_TOKEN: "token" }, port: 0 }), /sets no user\.email under "jj"/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("runner controls reach a connected metrics stream through the durable log", async () => {
  const home = await mkdtemp(join(tmpdir(), "slipjay-runner-stream-"));
  let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
  const controller = new AbortController();
  let cancelStream: (() => Promise<void>) | undefined;
  try {
    await writeFile(join(home, "config.json"), JSON.stringify({ name: "stream-runner", repos: {},
      jj: { "user.name": "Runner Identity", "user.email": "runner@example.com" } }));
    runner = await startRunner({ home, env: { SLIPJAY_RUNNER_TOKEN: "token" }, port: 0 });
    const headers = { authorization: "Bearer token" };
    const response = await fetch(`${runner.url}/v1/metrics/events?since=0`, {
      headers: { ...headers, accept: "text/event-stream" },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    cancelStream = () => reader.cancel();
    const pause = await fetch(`${runner.url}/v1/runner/pause`, {
      method: "POST", headers, body: JSON.stringify({ by: "test-owner" }),
    });
    assert.deepEqual(await pause.json(), { paused: true });
    const decoder = new TextDecoder();
    let frame = "";
    while (!frame.includes("\n\n")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      assert.ok(chunk.value);
      frame += decoder.decode(chunk.value, { stream: true });
    }
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(data, frame);
    const stored = JSON.parse(data.slice(6));
    assert.equal(stored.event.type, "paused");
    assert.equal(stored.event.by, "test-owner");
    const snapshot = await (await fetch(`${runner.url}/v1/queue`, { headers })).json() as { seq: number; paused: { by: string } };
    assert.equal(snapshot.seq, stored.seq);
    assert.equal(snapshot.paused.by, "test-owner");
  } finally {
    controller.abort();
    await cancelStream?.().catch(() => {});
    await runner?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("the runner answers health and its queue while recovery is still running", async () => {
  const home = await mkdtemp(join(tmpdir(), "slipjay-runner-recovery-"));
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
  try {
    await writeFile(join(home, "config.json"), JSON.stringify({ name: "recovery-runner", repos: {},
      jj: { "user.name": "Runner Identity", "user.email": "runner@example.com" } }));
    // Recovery starts with the executor's own: holding that open keeps recovery running.
    runner = await startRunner({ home, env: { SLIPJAY_RUNNER_TOKEN: "token" }, port: 0,
      executor: { ...directExecutor("test"), recover: () => held } });
    let recovered = false;
    void runner.recovered.then(() => { recovered = true; });
    const headers = { authorization: "Bearer token" };
    assert.equal((await fetch(`${runner.url}/v1/health`, { headers })).status, 200);
    assert.equal((await fetch(`${runner.url}/v1/queue`, { headers })).status, 200);
    assert.equal(recovered, false, "the API answered before recovery finished");
    release();
    await runner.recovered;
  } finally {
    release();
    await runner?.close();
    await rm(home, { recursive: true, force: true });
  }
});

/** Poll `check` until it holds, or fail: recovery is a race the test must not paper over with a sleep. */
async function until(check: () => boolean, budgetMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > budgetMs) throw new Error("timed out waiting for the runner");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A ledger holding one queued deploy of a repository the runner has no checkout of: it can only leave `queued` by starting. */
function queuedDeploy(home: string): string {
  const log = openOperationLog(join(home, "operations.sqlite"));
  const id = newOperationId();
  log.append(id, { type: "submitted", kind: "deploy", repo: "owner/repo", environment: "staging", commitId: "c".repeat(40), submittedBy: "owner:schedule" });
  log.close();
  return id;
}

const deployConfiguration = JSON.stringify({ name: "recovery-runner", repos: { "owner/repo": { url: "https://example.invalid/owner/repo" } },
  jj: { "user.name": "Runner Identity", "user.email": "runner@example.com" } });
const deployStatus = (home: string, id: string) => {
  const log = openOperationLog(join(home, "operations.sqlite"), {}, {});
  try { return log.operation(id)?.status; } finally { log.close(); }
};

test("a restart's queued deploy waits for recovery instead of starting under it", async () => {
  const home = await mkdtemp(join(tmpdir(), "slipjay-runner-deploy-"));
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
  try {
    await writeFile(join(home, "config.json"), deployConfiguration);
    const id = queuedDeploy(home);
    runner = await startRunner({ home, env: { SLIPJAY_RUNNER_TOKEN: "token" }, port: 0,
      executor: { ...directExecutor("test"), recover: () => held } });
    // A wake while recovery runs must start nothing.
    await fetch(`${runner.url}/v1/runner/pause`, { method: "POST", headers: { authorization: "Bearer token" }, body: JSON.stringify({ by: "test-owner" }) });
    await fetch(`${runner.url}/v1/runner/resume`, { method: "POST", headers: { authorization: "Bearer token" }, body: JSON.stringify({ by: "test-owner" }) });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(deployStatus(home, id), "queued", "the deploy waited for recovery");
    release();
    await until(() => deployStatus(home, id) !== "queued");
  } finally {
    release();
    await runner?.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

test("a recovery that cannot stop the previous process starts nothing until the runner restarts", async () => {
  const home = await mkdtemp(join(tmpdir(), "slipjay-runner-held-"));
  let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
  try {
    await writeFile(join(home, "config.json"), deployConfiguration);
    const id = queuedDeploy(home);
    runner = await startRunner({ home, env: { SLIPJAY_RUNNER_TOKEN: "token" }, port: 0,
      executor: { ...directExecutor("test"), recover: async () => { throw new Error("previous commands could not be stopped"); } } });
    await runner.recovered;
    // It still answers, and the pause/resume pair that would normally release the queue starts nothing.
    const headers = { authorization: "Bearer token" };
    assert.equal((await fetch(`${runner.url}/v1/health`, { headers })).status, 200);
    await fetch(`${runner.url}/v1/runner/pause`, { method: "POST", headers, body: JSON.stringify({ by: "test-owner" }) });
    await fetch(`${runner.url}/v1/runner/resume`, { method: "POST", headers, body: JSON.stringify({ by: "test-owner" }) });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(deployStatus(home, id), "queued", "nothing started after a failed recovery");
  } finally {
    await runner?.close();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

test("the runner refuses a config whose workers, limits or lanes it cannot honour", () => {
  const base = { repos: { "Owner/Repo": { url: "git@example.com:owner/repo.git" } }, jj: { "user.name": "Runner", "user.email": "runner@example.com" } };
  assert.equal(runnerConfigProblem(base), null);
  assert.equal(runnerConfigProblem({ ...base, workers: 2, limits: { memoryHigh: "40G", memoryMax: "48G", cpuQuota: "1400%", tasksMax: 4096 } }), null);
  for (const workers of [0, 1.5, "2" as unknown as number, Number.NaN]) assert.match(runnerConfigProblem({ ...base, workers }) ?? "", /"workers"/);
  assert.match(runnerConfigProblem({ ...base, limits: { memoryMax: "lots" } }) ?? "", /"limits"/);
  for (const origin of ["https://hq.example.com", "http://localhost:3290", "http://127.0.0.1:3290/"]) assert.equal(runnerConfigProblem({ ...base, build: { origin } }), null, origin);
  for (const origin of ["http://hq.example.com", "https://hq.example.com/api", "", "localhost:3290"]) assert.match(runnerConfigProblem({ ...base, build: { origin } }) ?? "", /"build.origin"/, origin);
  assert.match(runnerConfigProblem({ ...base, limits: { tasksMax: 0 } }) ?? "", /"limits"/);
  assert.match(runnerConfigProblem({ ...base, limits: { swapMax: "1G" } as never }) ?? "", /"limits"/);
  assert.match(runnerConfigProblem({ ...base, repos: { "Owner/Repo": { url: "x", lane: " " } } }) ?? "", /"lane"/);
  assert.equal(repositoryLane({ repos: { "Owner/Repo": { url: "x", lane: "shared" }, "Owner/Other": { url: "y" } } }, "owner/repo"), "shared");
  assert.equal(repositoryLane({ repos: { "Owner/Repo": { url: "x", lane: "shared" }, "Owner/Other": { url: "y" } } }, "owner/other"), "owner/other");
});
