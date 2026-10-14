import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { repositoryLane, runnerConfigProblem } from "../src/lib/runner-contract.ts";
import { startRunner } from "../src/lib/runner-service.ts";

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

test("the runner refuses a config whose workers, limits or lanes it cannot honour", () => {
  const base = { repos: { "Owner/Repo": { url: "git@example.com:owner/repo.git" } }, jj: { "user.name": "Runner", "user.email": "runner@example.com" } };
  assert.equal(runnerConfigProblem(base), null);
  assert.equal(runnerConfigProblem({ ...base, workers: 2, limits: { memoryHigh: "40G", memoryMax: "48G", cpuQuota: "1400%", tasksMax: 4096 } }), null);
  for (const workers of [0, 1.5, "2" as unknown as number, Number.NaN]) assert.match(runnerConfigProblem({ ...base, workers }) ?? "", /"workers"/);
  assert.match(runnerConfigProblem({ ...base, limits: { memoryMax: "lots" } }) ?? "", /"limits"/);
  assert.match(runnerConfigProblem({ ...base, limits: { tasksMax: 0 } }) ?? "", /"limits"/);
  assert.match(runnerConfigProblem({ ...base, limits: { swapMax: "1G" } as never }) ?? "", /"limits"/);
  assert.match(runnerConfigProblem({ ...base, repos: { "Owner/Repo": { url: "x", lane: " " } } }) ?? "", /"lane"/);
  assert.equal(repositoryLane({ repos: { "Owner/Repo": { url: "x", lane: "shared" }, "Owner/Other": { url: "y" } } }, "owner/repo"), "shared");
  assert.equal(repositoryLane({ repos: { "Owner/Repo": { url: "x", lane: "shared" }, "Owner/Other": { url: "y" } } }, "owner/other"), "owner/other");
});
