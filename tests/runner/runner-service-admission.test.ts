import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { candidateBookmark } from "../../src/lib/runner/runner-contract.ts";
import { newOperationId, openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { startRunner } from "../../src/lib/runner/runner-service.ts";
import { directExecutor } from "../support/executor.ts";
import { jj, project } from "../support/workspace-project.ts";

/**
 * A restart must answer the two requests an agent makes while it waits: health, and the submission of a landing. The
 * submission is admitted (retained, recorded and queued) while recovery is still running, and starts only afterwards.
 */
test("a landing submission is admitted while recovery is still running, and starts only once it settles", async () => {
  const base = await project();
  const home = join(base.root, "runner");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.json"), JSON.stringify({ name: "admission-runner", repos: { "owner/repo": { url: base.remote } },
    jj: { "user.name": "Runner Identity", "user.email": "runner@example.com" } }));
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
  try {
    // The candidate `slipjay land` pushes before it submits.
    await writeFile(join(base.repo, "a.txt"), "landing\n");
    jj(base.repo, ["describe", "-m", "a landing"]);
    const commitId = jj(base.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    const changeId = jj(base.repo, ["log", "-r", "@", "--no-graph", "-T", "change_id"]);
    const bookmark = candidateBookmark(changeId);
    execFileSync("git", ["--git-dir", jj(base.repo, ["git", "root"]), "push", "--force", base.remote, `${commitId}:refs/heads/${bookmark}`], { stdio: "pipe" });

    runner = await startRunner({ home, env: { ...process.env, SLIPJAY_RUNNER_TOKEN: "token" }, port: 0,
      executor: { ...directExecutor("test"), recover: () => held } });
    const headers = { authorization: "Bearer token", "content-type": "application/json" };
    // The stated budget, with recovery held: health answers within 2 s (measured 0.7 s on the 113k-event production copy),
    // and a submission within 10 s — it also retains the candidate's source, which is its own I/O; the point of the bound is
    // that neither waits for recovery, which is still running when both answer.
    let recovered = false;
    void runner.recovered.then(() => { recovered = true; });
    const healthStarted = performance.now();
    assert.equal((await fetch(`${runner.url}/v1/health`, { headers })).status, 200);
    assert.ok(performance.now() - healthStarted < 2_000, `health took ${Math.round(performance.now() - healthStarted)} ms`);
    const submitStarted = performance.now();
    const submitted = await fetch(`${runner.url}/v1/operations`, { method: "POST", headers,
      body: JSON.stringify({ repo: "owner/repo", changeId, commitId, bookmark, submittedBy: "author", requestId: newOperationId() }) });
    assert.ok(performance.now() - submitStarted < 10_000, `admission took ${Math.round(performance.now() - submitStarted)} ms`);
    assert.equal(recovered, false, "admission answered while recovery was still running");
    assert.equal(submitted.status, 200, await submitted.clone().text());
    const { operation } = await submitted.json() as { operation: { id: string; status: string; stage: string } };
    assert.equal(operation.status, "queued");

    // Admitted and durable, but held: recovery has not settled, so nothing runs.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const log = openOperationLog(join(home, "operations.sqlite"));
    try {
      const stored = log.operation(operation.id);
      assert.equal(stored?.status, "queued", "admission did not start it under recovery");
      assert.ok(log.events({ operationId: operation.id }).some((row) => row.event.type === "source_retained"), "the submission is durable");
    } finally { log.close(); }

    release();
    await runner.recovered;
    // Once recovery settles it is admitted to the queue and starts; it cannot land without a warm checkout, but that it
    // left `queued` is what proves the queue was released.
    const after = openOperationLog(join(home, "operations.sqlite"));
    try {
      const started = Date.now();
      while (after.operation(operation.id)?.status === "queued") {
        if (Date.now() - started > 10_000) throw new Error("the admitted landing never started");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally { after.close(); }
  } finally {
    release();
    await runner?.close();
    await base.dispose();
  }
}, 120_000);

/** A ledger with `operations` closed attempts of another repository, each with `lines` progress events: history a restart replays. */
function seedHistory(home: string, operations: number, lines: number): void {
  const log = openOperationLog(join(home, "operations.sqlite"));
  try {
    for (let index = 0; index < operations; index++) {
      const id = newOperationId();
      log.append(id, { type: "submitted", repo: "owner/other", changeId: `${index}`.padStart(32, "0"), commitId: `${index}`.padStart(40, "0"),
        bookmark: candidateBookmark(`${index}`.padStart(32, "0")), submittedBy: "author" });
      for (let line = 0; line < lines; line++) log.append(id, { type: "progress", line: `line ${line} of attempt ${index} `.repeat(8) });
      log.append(id, { type: "failed", stage: "verifying", reason: "gate failed" });
    }
  } finally { log.close(); }
}

test("a large ledger does not put health or admission behind recovery", async () => {
  const base = await project();
  const home = join(base.root, "runner");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "config.json"), JSON.stringify({ name: "history-runner", repos: { "owner/repo": { url: base.remote } },
    jj: { "user.name": "Runner Identity", "user.email": "runner@example.com" } }));
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
  try {
    seedHistory(home, 800, 50);
    const seeded = openOperationLog(join(home, "operations.sqlite"));
    const events = seeded.events().length;
    seeded.close();
    assert.ok(events > 40_000, `${events} events`);

    await writeFile(join(base.repo, "b.txt"), "landing\n");
    jj(base.repo, ["describe", "-m", "another landing"]);
    const commitId = jj(base.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    const changeId = jj(base.repo, ["log", "-r", "@", "--no-graph", "-T", "change_id"]);
    const bookmark = candidateBookmark(changeId);
    execFileSync("git", ["--git-dir", jj(base.repo, ["git", "root"]), "push", "--force", base.remote, `${commitId}:refs/heads/${bookmark}`], { stdio: "pipe" });

    runner = await startRunner({ home, env: { ...process.env, SLIPJAY_RUNNER_TOKEN: "token" }, port: 0,
      executor: { ...directExecutor("test"), recover: () => held } });
    let recovered = false;
    void runner.recovered.then(() => { recovered = true; });
    const headers = { authorization: "Bearer token", "content-type": "application/json" };
    const healthStarted = performance.now();
    assert.equal((await fetch(`${runner.url}/v1/health`, { headers })).status, 200);
    assert.ok(performance.now() - healthStarted < 2_000, `health took ${Math.round(performance.now() - healthStarted)} ms`);
    const submitStarted = performance.now();
    const submitted = await fetch(`${runner.url}/v1/operations`, { method: "POST", headers,
      body: JSON.stringify({ repo: "owner/repo", changeId, commitId, bookmark, submittedBy: "author", requestId: newOperationId() }) });
    assert.equal(submitted.status, 200, await submitted.clone().text());
    assert.ok(performance.now() - submitStarted < 10_000, `admission took ${Math.round(performance.now() - submitStarted)} ms`);
    assert.equal(recovered, false, "both answered while recovery was still running");
    release();
    await runner.recovered;
  } finally {
    release();
    await runner?.close();
    await base.dispose();
  }
}, 120_000);
