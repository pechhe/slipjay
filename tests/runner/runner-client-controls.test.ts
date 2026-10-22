import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { controlRunner, readPromotionState } from "../../src/lib/runner/runner-client.ts";
import { candidateBookmark } from "../../src/lib/runner/runner-contract.ts";
import type { Operation } from "../../src/lib/runner/runner-contract.ts";
import { serveRunner } from "../../src/lib/runner/runner-http.ts";
import { project } from "../support/workspace-project.ts";
import { fixture } from "./fixtures/runner-client-fixture.ts";

test("a promotion plan reads no pre-verifications from a runner older than them, and any other failure still fails it", async () => {
  const f = await fixture();
  try {
    const older = (status: number) => serveRunner(async (request) => new URL(request.url).pathname.endsWith("/verifications")
      ? Response.json({ error: "not found" }, { status }) : Response.json({ operations: [] }), { host: "127.0.0.1", port: 0 });
    const missing = await older(404);
    try {
      assert.deepEqual(await readPromotionState(f.cwd, { location: missing.url, env: f.options.env }), { stagingGreen: null, stagingGreenCommits: [], approved: [], verifications: [] });
    } finally { await missing.close(); }
    const broken = await older(500);
    try {
      await assert.rejects(readPromotionState(f.cwd, { location: broken.url, env: f.options.env }), /HTTP 500/);
    } finally { await broken.close(); }
  } finally { await f.dispose(); }
}, 60_000);

test("owner controls say what they did", async () => {
  const f = await fixture();
  try {
    const control = (action: "kill" | "pause" | "resume") => controlRunner(f.server.url, action, f.options.env);
    assert.deepEqual(await control("kill"), { ok: true, line: "[runner test-runner] nothing running" });
    assert.deepEqual(await control("pause"), { ok: true, line: "[runner test-runner] paused: queued changes wait until resumed" });
    assert.deepEqual(await control("resume"), { ok: true, line: "[runner test-runner] resumed" });
    const operation: Operation = { kind: "landing", id: "op", repo: "fixture/project", changeId: f.change, commitId: f.commit, bookmark: candidateBookmark(f.change),
      submittedBy: "test", status: "running", stage: "verifying", submittedAt: "", runs: [], lastSeq: 1 };
    const subject = `landing ${f.change.slice(0, 12)}`;
    f.setKill({ status: "killed", operation });
    assert.deepEqual(await control("kill"), { ok: true, line: `[runner test-runner] killed ${subject}` });
    f.setKill({ status: "killed", operation: { ...operation, stage: "installing" as const } });
    assert.deepEqual(await control("kill"), { ok: true, line: `[runner test-runner] killing ${subject}: it stops when installing finishes, before verification` });
    f.setKill({ status: "refused", operation: { ...operation, stage: "publishing" as const } });
    assert.deepEqual(await control("kill"), { ok: false, line: `[runner test-runner] not killed: ${subject} publishing is past verification and cannot be killed; it finishes on its own` });
    const id = "op_00mv8o85yu_f70a90f79d88f6b6664c3c82";
    f.setKill({ status: "killed", operation: { ...operation, id } });
    assert.deepEqual(await controlRunner(f.server.url, "kill", f.options.env, id), { ok: true, line: `[runner test-runner] killed ${subject}` });
    assert.equal(f.killRequests.at(-1), id, "a named kill reaches the runner with its operation");
    f.setKill({ status: "not_running", operation: { ...operation, id, status: "landed" } });
    assert.deepEqual(await controlRunner(f.server.url, "kill", f.options.env, id), { ok: false, line: `[runner test-runner] not killed: ${subject} is not running (landed); nothing was killed` });
    f.setKill({ status: "not_running", operation: null });
    assert.deepEqual(await controlRunner(f.server.url, "kill", f.options.env, id), { ok: false, line: `[runner test-runner] not killed: ${id} is not a known operation; nothing was killed` });
    const other: Operation = { kind: "release", id: "op_00mv8o85yu_aaaaaaaaaaaaaaaaaaaaaaaa", repo: "fixture/other", commitId: "c".repeat(40), migrationsReady: false, submittedBy: "test", status: "running", stage: "verifying", submittedAt: "", runs: [], lastSeq: 2 };
    f.setKill({ status: "ambiguous", operations: [{ ...operation, id }, other] });
    assert.deepEqual(await control("kill"), { ok: false, line: `[runner test-runner] not killed: 2 operations are running; name one:\n  slipjay runner kill ${id}  (${subject}, verifying)\n  slipjay runner kill ${other.id}  (release cccccccccccc, verifying)` });
    assert.equal(f.killRequests.at(-1), undefined, "an unnamed kill names no operation");
    await assert.rejects(controlRunner(f.server.url, "kill", f.options.env, "not-an-id"), /HTTP 400: Invalid control request/);
  } finally { await f.dispose(); }
}, 60_000);

test("cancel uses the authenticated transport and attributes the hostname, preserving refusal", async () => {
  const { cancelThroughRunner } = await import("../../src/lib/runner/runner-client.ts");
  const { hostname } = await import("node:os");
  const bodies: unknown[] = [];
  const server = await serveRunner(
    async (request) => {
      assert.equal(request.headers.get("authorization"), "Bearer fixture-token");
      if (new URL(request.url).pathname === "/v1/health")
        return Response.json({ runner: "fixture" });
      bodies.push(await request.json());
      return Response.json({ error: "operation is not queued" }, { status: 409 });
    },
    { host: "127.0.0.1", port: 0 },
  );
  try {
    const result = await cancelThroughRunner(server.url, "running", {
      SLIPJAY_RUNNER_TOKEN: "fixture-token",
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.result, { error: "operation is not queued" });
    assert.deepEqual(bodies, [{ by: hostname() }]);
  } finally {
    await server.close();
  }
});
