import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vite-plus/test";
import { readCommandArtifact, retainCommandArtifact } from "../../src/lib/runner/command-artifact.ts";
import { createRunnerHandler } from "../../src/lib/runner/runner-api.ts";
import { serveRunner } from "../../src/lib/runner/runner-http.ts";
import { openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { readRunArtifact } from "../../src/lib/runner/runner-client.ts";
import { candidateBookmark } from "../../src/lib/runner/runner-contract.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "../../src/lib/infra/bounded-process.ts";
import type { CommandArtifact } from "../../src/lib/runner/runner-contract.ts";

const request: BoundedProcessRequest = { executable: "bun", args: ["test"], cwd: "/fixture", timeoutMs: 1000, maxOutputBytes: 64_000, env: { API_SECRET: "fixture-secret-value" } };
const result = (fields: Partial<BoundedProcessResult> = {}): BoundedProcessResult => ({ stdout: "small output", stderr: "", stdoutTruncated: false, stderrTruncated: false,
  finishedAt: new Date().toISOString(), exitCode: 0, signal: null, timedOut: false, cancelled: false, outputSha256: "not-used", ...fields });
function retained(reference: CommandArtifact): asserts reference is Extract<CommandArtifact, { status: "retained" }> { assert.equal(reference.status, "retained"); }

test("artifacts redact complete output, preserve selected middle diagnostics, and never retain truncated raw edges", async () => {
  const home = await mkdtemp(join(tmpdir(), "slipjay-artifacts-"));
  try {
    const reference = await retainCommandArtifact({ home, operationId: "op", runId: "run", request,
      result: result({ stdout: "half-a-secret", stdoutTruncated: true, stderr: "fixture-secret-value https://user:pass@example.com", error: "spawn failed: fixture-secret-value",
        diagnosticOutput: { stdout: "Error: src/middle.ts:19:3\nfixture-secret-value", stderr: "", incomplete: true } }) });
    retained(reference);
    assert.equal(reference.complete, false);
    const chunk = await readCommandArtifact(home, "op", "run", reference, 0, 16384);
    const bytes = Buffer.from(chunk.dataBase64, "base64").toString("utf8");
    assert.doesNotMatch(bytes, /half-a-secret|fixture-secret-value|user:pass/);
    assert.match(bytes, /src\/middle.ts:19:3/);
    const artifact = JSON.parse(bytes);
    assert.equal(artifact.stdout.reason, "truncated-capture-withheld");
    assert.equal(artifact.stderr.complete, true);
    assert.equal(artifact.diagnosticCapture, "incomplete");
    assert.equal(chunk.nextOffset, null);
    assert.deepEqual(await retainCommandArtifact({ home, operationId: "op", runId: "private", request, result: result(), privateOutput: true }), { status: "unavailable", reason: "private-output" });
    const unavailableHome = join(home, "file"); await writeFile(unavailableHome, "not a directory");
    assert.deepEqual(await retainCommandArtifact({ home: unavailableHome, operationId: "op", runId: "run", request, result: result() }), { status: "unavailable", reason: "capture-failed" });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("small outputs are complete; capacity is explicit; stable command identities cannot overwrite prior evidence", async () => {
  const home = await mkdtemp(join(tmpdir(), "slipjay-artifacts-"));
  try {
    const first = await retainCommandArtifact({ home, operationId: "op", runId: "run", request, result: result() });
    retained(first); assert.equal(first.complete, true);
    assert.deepEqual(await retainCommandArtifact({ home, operationId: "op", runId: "run", request, result: result({ stdout: "changed" }) }), { status: "unavailable", reason: "capture-failed" });
    const restored = await readCommandArtifact(home, "op", "run", first, 0, 16384);
    assert.match(Buffer.from(restored.dataBase64, "base64").toString("utf8"), /small output/);
    const large = await retainCommandArtifact({ home, operationId: "op", runId: "large", request, result: result({ stdout: "é".repeat(10_000) }) });
    retained(large); assert.equal(large.complete, false);
    const data = JSON.parse(Buffer.from((await readCommandArtifact(home, "op", "large", large, 0, 16384)).dataBase64, "base64").toString("utf8"));
    assert.equal(data.stdout.reason, "artifact-capacity");
    assert.doesNotMatch(data.stdout.text, /�/);
    await assert.rejects(readCommandArtifact(home, "op", "run", first, -1, 16), /range/);
    await assert.rejects(readCommandArtifact(home, "op", "run", first, 0, 16385), /range/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("authenticated chunk retrieval and actual CLI verify durable artifact bytes, reject tampering and do not submit", async () => {
  const home = await mkdtemp(join(tmpdir(), "slipjay-artifacts-api-"));
  const logPath = join(home, "log.sqlite");
  let log = openOperationLog(logPath);
  const reference = await retainCommandArtifact({ home, operationId: "op", runId: "run", request,
    result: result({ stdout: "x".repeat(8192), stderr: "y".repeat(8192), diagnosticOutput: { stdout: "z".repeat(8192), stderr: "q".repeat(8192), incomplete: false } }) });
  retained(reference); assert.ok(reference.bytes > 16384);
  log.append("op", { type: "submitted", repo: "owner/repo", changeId: "k".repeat(32), commitId: "a".repeat(40), bookmark: candidateBookmark("k".repeat(32)), submittedBy: "author" });
  log.append("op", { type: "run_started", runId: "run", command: "bun test", host: "fixture" });
  log.append("op", { type: "run_finished", runId: "run", exitCode: 1, signal: null, timedOut: false, durationMs: 1, artifact: reference });
  log.append("op", { type: "failed", stage: "verifying", reason: "fixture" });
  log.close(); log = openOperationLog(logPath);
  let submissions = 0;
  const server = await serveRunner(createRunnerHandler({ log, token: "fixture-token", runnerName: "fixture", readLog: async () => "retained",
    readArtifact: (op, run, ref, offset, limit) => readCommandArtifact(home, op, run, ref, offset, limit),
    onSubmitted: () => { submissions++; }, kill: () => ({ status: "idle" }), subscribe: log.subscribe }), { host: "127.0.0.1", port: 0 });
  try {
    const env = { ...process.env, SLIPJAY_RUNNER: server.url, SLIPJAY_RUNNER_TOKEN: "fixture-token" };
    const artifact = await readRunArtifact(server.url, "op", "run", env);
    const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
    const { stdout, stderr } = await promisify(execFile)("bun", [cli, "runner", "artifact", "op", "run"], { env, timeout: 20_000 });
    assert.deepEqual(JSON.parse(stdout), artifact); assert.equal(stderr, ""); assert.equal(submissions, 0);
    const url = `${server.url}/v1/operations/op/artifacts/run`, headers = { authorization: "Bearer fixture-token" };
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(`${url}?offset=-1`, { headers })).status, 400);
    assert.equal((await fetch(`${url}?limit=16385`, { headers })).status, 400);
    assert.equal((await fetch(`${server.url}/v1/operations/op/artifacts/missing`, { headers })).status, 410);
    const [directory] = await readdir(join(home, "command-artifacts"));
    const [file] = await readdir(join(home, "command-artifacts", directory!));
    const path = join(home, "command-artifacts", directory!, file!);
    assert.ok((await readFile(path)).length > 0);
    await writeFile(path, "tampered");
    assert.equal((await fetch(url, { headers })).status, 410);
    await assert.rejects(readRunArtifact(server.url, "op", "run", env), /410/);
  } finally { await server.close(); log.close(); await rm(home, { recursive: true, force: true }); }
});
