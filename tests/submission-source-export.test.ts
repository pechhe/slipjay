import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vite-plus/test";
import { createRunnerHandler } from "../src/lib/runner-api.ts";
import { serveRunner } from "../src/lib/runner-http.ts";
import { openOperationLog } from "../src/lib/runner-log.ts";
import { localExecutor } from "../src/lib/runner-queue.ts";
import { candidateBookmark } from "../src/lib/runner-contract.ts";
import { retainSubmissionSource } from "../src/lib/submission-source.ts";
import { submissionSourceResponse, importSourceBundle } from "../src/lib/submission-source-export.ts";
import { downloadSubmissionSource } from "../src/lib/runner-client.ts";
import { jj, project } from "./support/workspace-project.ts";
import { testExecutor } from "./support/executor.ts";

test("CLI retrieves retained source after author/upstream loss and a cold worker restores using only bundle evidence", async () => {
  const f = await project();
  const log = openOperationLog(":memory:");
  let server: Awaited<ReturnType<typeof serveRunner>> | undefined;
  try {
    const contents = randomBytes(1024 * 1024);
    await writeFile(join(f.repo, "source.bin"), contents);
    jj(f.repo, ["describe", "-m", "Retained recovery source"]);
    const source = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    const changeId = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "change_id"]);
    const bookmark = candidateBookmark(changeId);
    execFileSync("git", ["--git-dir", jj(f.repo, ["git", "root"]), "push", f.remote, `${source}:refs/heads/${bookmark}`], { stdio: "pipe" });
    const home = join(f.root, "runner"); await mkdir(home);
    const operationId = "op_recovery";
    const request = { repo: "owner/repo", changeId, commitId: source, bookmark, submittedBy: "fixture" };
    const retained = await retainSubmissionSource({ home, operationId, request, url: f.remote, executor: testExecutor() });
    log.append(operationId, { type: "submitted", ...request }); log.append(operationId, retained);
    log.append(operationId, { type: "failed", stage: "verifying", reason: "synthetic failure" });
    const before = log.events();
    execFileSync("git", ["--git-dir", f.remote, "update-ref", "-d", `refs/heads/${bookmark}`]);
    execFileSync("git", ["--git-dir", f.remote, "gc", "--prune=now"]);
    await rm(f.repo, { recursive: true, force: true });
    server = await serveRunner(createRunnerHandler({ log, token: "fixture-token", runnerName: "recovery", readLog: async () => "",
      onSubmitted: () => { throw new Error("Retrieval must not resubmit"); }, kill: () => ({ status: "idle" }), subscribe: log.subscribe,
      readSource: (operation, signal) => submissionSourceResponse({ home, operationId: operation.id, repo: operation.repo, retained, executor: testExecutor(), signal }),
    }), { host: "127.0.0.1", port: 0 });
    const destination = join(f.root, "recovered.bundle");
    const env = { ...process.env, SLIPJAY_RUNNER: server.url, SLIPJAY_RUNNER_TOKEN: "fixture-token" };
    const cli = fileURLToPath(new URL("../src/launcher/workspace.ts", import.meta.url));
    const result = await promisify(execFile)("bun", [cli, "runner", "source", operationId, destination], { env, timeout: 30000 });
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.source, source); assert.equal(evidence.operationId, operationId); assert.ok(evidence.bytes > contents.length);
    assert.equal(result.stderr, "");
    assert.equal((await fetch(`${server.url}/v1/operations/${operationId}/source`)).status, 401);
    await assert.rejects(downloadSubmissionSource(server.url, operationId, destination, env), /EEXIST/);
    assert.deepEqual(log.events(), before);
    await server.close(); server = undefined;
    // Completion/disconnect cleanup closes the export stream before removal settles.
    const deadline = Date.now() + 5000;
    while ((await readdir(join(home, "submissions"))).some((name) => name.endsWith(".bundle.tmp"))) {
      if (Date.now() > deadline) assert.fail("Derived source export was not removed");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // No access to runner objects or author state remains for the consumer.
    await rm(home, { recursive: true, force: true });
    const consumer = join(f.root, "cold-worker");
    jj(f.root, ["git", "clone", f.remote, consumer]);
    const working = jj(consumer, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    assert.equal(jj(consumer, ["log", "-r", `present(${source})`, "--no-graph", "-T", "commit_id"]), "");
    await importSourceBundle(destination, consumer, operationId, source);
    assert.equal(jj(consumer, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]), working);
    const recovered = execFileSync("git", ["--git-dir", jj(consumer, ["git", "root"]), "show", `${source}:source.bin`], { maxBuffer: 2 * 1024 * 1024 });
    assert.deepEqual(recovered, contents);
    await assert.rejects(importSourceBundle(destination, consumer, "wrong-operation", source), /import/);
    assert.deepEqual((await readdir(f.root)).filter((name) => name.endsWith(".tmp")), []);
    assert.ok((await readFile(destination)).length > contents.length);
  } finally { await server?.close(); log.close(); await f.dispose(); }
}, 120000);


test("source download rejects altered metadata, corrupt bytes and oversized exports without retaining a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-download-"));
  const source = "a".repeat(40), operationId = "op_download";
  let mode = "corrupt";
  const server = await serveRunner(async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/health")) return Response.json({ runner: "fixture" });
    if (path.endsWith("/outcome")) return Response.json({ outcome: { operationId, sourceCommitId: source, sourceRetention: { commitId: source } } });
    const headers = { "content-length": mode === "oversized" ? String(128 * 1024 * 1024 + 1) : "3",
      "x-slipjay-operation": operationId, "x-slipjay-source": mode === "source" ? "b".repeat(40) : source,
      "x-slipjay-sha256": createHash("sha256").update("good").digest("hex") };
    return new Response("bad", { headers });
  }, { host: "127.0.0.1", port: 0 });
  try {
    for (mode of ["corrupt", "source", "oversized"]) {
      await assert.rejects(downloadSubmissionSource(server.url, operationId, join(root, mode), { ...process.env, SLIPJAY_RUNNER_TOKEN: "token" }), /metadata|integrity/);
      assert.deepEqual(await readdir(root), []);
    }
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
