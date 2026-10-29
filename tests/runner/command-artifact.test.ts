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
import { candidateBookmark, COMMAND_ARTIFACT_LIMIT_BYTES, COMMAND_ARTIFACT_PAGE_BYTES } from "../../src/lib/runner/runner-contract.ts";
import { OUTPUT_OMISSION } from "../../src/lib/infra/bounded-process.ts";
import { FAILED_STREAM_BYTES, FAILED_TAIL_BYTES } from "../../src/lib/infra/verification-failure.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "../../src/lib/infra/bounded-process.ts";
import type { CommandArtifact } from "../../src/lib/runner/runner-types.ts";

const request: BoundedProcessRequest = { executable: "bun", args: ["test"], cwd: "/fixture", timeoutMs: 1000, maxOutputBytes: 64_000, env: { API_SECRET: "fixture-secret-value" } };
const result = (fields: Partial<BoundedProcessResult> = {}): BoundedProcessResult => ({ stdout: "small output", stderr: "", stdoutTruncated: false, stderrTruncated: false,
  finishedAt: new Date().toISOString(), exitCode: 0, signal: null, timedOut: false, cancelled: false, outputSha256: "not-used", ...fields });
function retained(reference: CommandArtifact): asserts reference is Extract<CommandArtifact, { status: "retained" }> { assert.equal(reference.status, "retained"); }

test("artifacts redact complete output, preserve selected middle diagnostics, and never retain a cut line of a truncated capture", async () => {
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
    // A failed command (here a spawn error) keeps its truncated capture, less the line its cut touched.
    assert.equal(artifact.stdout.reason, "artifact-capacity");
    assert.equal(artifact.stdout.text, "");
    assert.equal(artifact.stderr.complete, true);
    assert.equal(artifact.diagnosticCapture, "incomplete");
    assert.equal(chunk.nextOffset, null);
    const passing = await retainCommandArtifact({ home, operationId: "op", runId: "passing", request, result: result({ stdout: "half-a-secret", stdoutTruncated: true }) });
    retained(passing);
    const passed = JSON.parse(Buffer.from((await readCommandArtifact(home, "op", "passing", passing, 0, 16384)).dataBase64, "base64").toString("utf8"));
    assert.equal(passed.stdout.reason, "truncated-capture-withheld", "a passing command keeps today's bounds");
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
    await assert.rejects(readCommandArtifact(home, "op", "run", first, 0, COMMAND_ARTIFACT_PAGE_BYTES + 1), /range/);
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
    assert.equal((await fetch(`${url}?limit=${COMMAND_ARTIFACT_PAGE_BYTES + 1}`, { headers })).status, 400);
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

const read = async (home: string, runId: string, reference: CommandArtifact) => {
  retained(reference);
  const parts: Buffer[] = [];
  for (let offset: number | null = 0; offset !== null;) {
    const chunk = await readCommandArtifact(home, "op", runId, reference, offset, COMMAND_ARTIFACT_PAGE_BYTES);
    parts.push(Buffer.from(chunk.dataBase64, "base64")); offset = chunk.nextOffset;
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
};

test("a failed command keeps its whole output up to 4 MiB a stream, and beyond that its head and its closing summary", async () => {
  const home = await mkdtemp(join(tmpdir(), "slipjay-artifacts-failed-"));
  try {
    const failed = { exitCode: 1 };
    const whole = `${"progress line\n".repeat(20_000)}Landing failure summary:\nFAIL a.test.ts > adds\n`;
    const complete = await read(home, "whole", await retainCommandArtifact({ home, operationId: "op", runId: "whole", request, result: result({ ...failed, stdout: whole }) }));
    assert.equal(complete.stdout.complete, true);
    assert.equal(complete.stdout.text, whole);

    const huge = `first line\n${"x".repeat(99)}\n`.repeat(50_000) + "Landing failure summary:\nFAIL a.test.ts > adds\n  first error: expected 2, got 3\n";
    assert.ok(Buffer.byteLength(huge) > FAILED_STREAM_BYTES);
    const reference = await retainCommandArtifact({ home, operationId: "op", runId: "huge", request, result: result({ ...failed, stdout: huge }) });
    retained(reference);
    assert.equal(reference.complete, false);
    assert.ok(reference.bytes <= COMMAND_ARTIFACT_LIMIT_BYTES);
    const kept = await read(home, "huge", reference);
    assert.equal(kept.stdout.reason, "artifact-capacity");
    assert.ok(Buffer.byteLength(kept.stdout.text) <= FAILED_STREAM_BYTES);
    assert.ok(kept.stdout.text.startsWith("first line\n"));
    assert.ok(kept.stdout.text.endsWith("FAIL a.test.ts > adds\n  first error: expected 2, got 3\n"));
    assert.ok(kept.stdout.text.split(OUTPUT_OMISSION)[1]!.length >= FAILED_TAIL_BYTES - 200, "the last 256 KiB survive");

    // Escaping can triple a stream's JSON; the streams halve until the file fits, keeping their tails.
    const escaped = "\u0001".repeat(FAILED_STREAM_BYTES) + "\nFailure cause: core typecheck: error TS2322\n";
    const shrunk = await retainCommandArtifact({ home, operationId: "op", runId: "escaped", request, result: result({ ...failed, stdout: escaped, stderr: escaped }) });
    retained(shrunk);
    assert.ok(shrunk.bytes <= COMMAND_ARTIFACT_LIMIT_BYTES);
    assert.match((await read(home, "escaped", shrunk)).stderr.text, /Failure cause: core typecheck: error TS2322\n$/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a failed command's truncated capture drops every line the cut touched, so no split credential survives", async () => {
  const home = await mkdtemp(join(tmpdir(), "slipjay-artifacts-edges-"));
  try {
    const stdout = ["head kept", "API_TOKEN="].join("\n") + OUTPUT_OMISSION + ["leaked-half-of-token", "-----END RSA PRIVATE KEY-----", "tail kept", "-----BEGIN RSA PRIVATE KEY-----", "MIIEow"].join("\n")
      + OUTPUT_OMISSION + ["mid-cut", "summary kept"].join("\n");
    const kept = await read(home, "edges", await retainCommandArtifact({ home, operationId: "op", runId: "edges", request, result: result({ exitCode: 1, stdout, stdoutTruncated: true }) }));
    assert.equal(kept.stdout.reason, "artifact-capacity");
    assert.match(kept.stdout.text, /head kept/);
    assert.match(kept.stdout.text, /tail kept/);
    assert.match(kept.stdout.text, /summary kept/);
    assert.doesNotMatch(kept.stdout.text, /API_TOKEN|leaked-half|PRIVATE KEY|MIIEow|mid-cut/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the client pages a failed command's multi-megabyte artifact back whole, from a current runner and an older one", async () => {
  const home = await mkdtemp(join(tmpdir(), "slipjay-artifacts-pages-"));
  const log = openOperationLog(join(home, "log.sqlite"));
  const stdout = `${"y".repeat(199)}\n`.repeat(15_000) + "FAIL a.test.ts > adds\n";
  const reference = await retainCommandArtifact({ home, operationId: "op", runId: "run", request, result: result({ exitCode: 1, stdout }) });
  retained(reference); assert.ok(reference.bytes > 2 * COMMAND_ARTIFACT_PAGE_BYTES);
  log.append("op", { type: "submitted", repo: "owner/repo", changeId: "k".repeat(32), commitId: "a".repeat(40), bookmark: candidateBookmark("k".repeat(32)), submittedBy: "author" });
  log.append("op", { type: "run_started", runId: "run", command: "bun test", host: "fixture" });
  log.append("op", { type: "run_finished", runId: "run", exitCode: 1, signal: null, timedOut: false, durationMs: 1, artifact: reference });
  const handler = createRunnerHandler({ log, token: "fixture-token", runnerName: "fixture", readLog: async () => "retained",
    readArtifact: (op, run, ref, offset, limit) => readCommandArtifact(home, op, run, ref, offset, limit),
    onSubmitted: () => {}, kill: () => ({ status: "idle" }), subscribe: log.subscribe });
  const server = await serveRunner(handler, { host: "127.0.0.1", port: 0 });
  // A runner from before 3.46.26 refuses pages over 16 KiB.
  let legacyPages = 0;
  const legacy = await serveRunner(async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.includes("/artifacts/")) return handler(request);
    if (Number(url.searchParams.get("limit")) > 16384) return Response.json({ error: "Invalid artifact range" }, { status: 400 });
    legacyPages++;
    return handler(request);
  }, { host: "127.0.0.1", port: 0 });
  try {
    for (const url of [server.url, legacy.url]) {
      const artifact = await readRunArtifact(url, "op", "run", { ...process.env, SLIPJAY_RUNNER: url, SLIPJAY_RUNNER_TOKEN: "fixture-token" }) as { stdout: { text: string; complete: boolean } };
      assert.equal(artifact.stdout.complete, true);
      assert.equal(artifact.stdout.text, stdout);
    }
    assert.equal(legacyPages, Math.ceil(reference.bytes / 16384), "the older runner is read in its own 16 KiB pages");
  } finally { await server.close(); await legacy.close(); log.close(); await rm(home, { recursive: true, force: true }); }
});
