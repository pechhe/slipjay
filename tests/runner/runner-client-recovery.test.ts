import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { LandingNotSubmitted, landThroughRunner, operationRunnerLocation } from "../../src/lib/runner/runner-client.ts";
import { workspaceContext } from "../../src/lib/infra/workspace-jj.ts";
import { workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { frozenAdoptions } from "../../src/lib/workspace/workspace-coverage.ts";
import * as workspaceJj from "../../src/lib/infra/workspace-jj.ts";
import { serveRunner } from "../../src/lib/runner/runner-http.ts";
import type { BuildAdmission } from "../../src/lib/build/build-admission.ts";
import { fixture, waitFor } from "./fixtures/runner-client-fixture.ts";

test("a fresh landing invocation reconciles a lost terminal response with the persisted identity", async () => {
  const f = await fixture(false, false, true);
  try {
    await assert.rejects(landThroughRunner(f.cwd, f.options), /outcome is unknown/);
    // Read the operation from the durable submission events; the fixture transport uses its configured repo.
    const submittedEvents = f.log.events().filter((row) => row.event.type === "submitted");
    assert.equal(submittedEvents.length, 1);
    const id = submittedEvents[0]!.operationId;
    // A failure before the retry's POST cannot disprove the earlier acceptance.
    const context = (await workspaceContext(f.cwd))!;
    const original = workspaceJj.jj;
    const pushing = vi.spyOn(workspaceJj, "jj").mockImplementation(async (cwd, args, options) => {
      if (args[0] === "git" && args[1] === "push") throw new Error("retry push failed");
      return original(cwd, args, options);
    });
    try {
      await assert.rejects(landThroughRunner(f.cwd, f.options), (error) => error instanceof Error && !(error instanceof LandingNotSubmitted) && /retry push failed/.test(error.message));
      const kept = (await workspaceMetadata(context.current.name))!;
      assert.equal(Object.keys(kept.pendingLandingRequests as object).length, 1);
      assert.equal(Object.keys(kept.landingRunners as object).length, 1, "the earlier submission's runner pin survives a failure before the retry's POST");
    } finally { pushing.mockRestore(); }
    const recovered = await landThroughRunner(f.cwd, f.options);
    assert.equal(recovered.operation.id, id);
    assert.equal(recovered.operation.status, "failed");
    assert.equal(recovered.ok, false);
    assert.equal(f.requestIds.length, 2);
    assert.equal(f.requestIds[0], f.requestIds[1]);
    assert.match(f.requestIds[0]!, /^[a-f0-9-]{36}$/);
    assert.equal(f.log.events().filter((row) => row.event.type === "submitted").length, 1);
    // A later explicit invocation, after the failed response was acknowledged, is a new attempt.
    const retry = landThroughRunner(f.cwd, f.options);
    await waitFor(() => f.log.openOperations().length === 1);
    const next = f.log.openOperations()[0]!;
    assert.notEqual(next.id, id);
    assert.notEqual(f.requestIds.at(-1), f.requestIds[0]);
    f.append(next.id, { type: "cancelled", reason: "fixture done" });
    await retry;
  } finally { await f.dispose(); }
});


test("a Build admission that did not complete is reported as retryable, and landing again retries it on the same operation", async () => {
  const answers: BuildAdmission[] = [{ outcome: "unavailable", reason: "Build did not answer in time" }];
  const f = await fixture(false, false, false, (request) => Promise.resolve(answers.shift() ?? { outcome: "admitted", sequence: request.sequence, sessionId: request.sessionId, recordedAt: null }));
  try {
    const handoff = { version: 1 as const, source: f.commit, intent: "Bound work", scope: [], spec: null, helpers: [], checks: [], reviews: [], toolchain: [], gaps: [],
      build: { specId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", ticketIds: [], bodyRevision: null, bindGeneration: 1, sessionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" } };
    await assert.rejects(landThroughRunner(f.cwd, { ...f.options, handoff }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof LandingNotSubmitted, false, "a retained operation awaiting admission is accepted source");
      assert.match(error.message, /did not answer in time.*slipjay land again/);
      assert.doesNotMatch(error.message, /unknown/);
      return true;
    });
    const pending = f.log.operation(f.log.events().find((row) => row.event.type === "submitted")!.operationId);
    assert.ok(pending?.kind === "landing" && pending.admission === "pending");
    const context = (await workspaceContext(f.cwd))!;
    const metadata = (await workspaceMetadata(context.current.name))!;
    assert.equal(Object.keys(metadata.pendingLandingRequests as object).length, 1);
    assert.equal(Object.values(frozenAdoptions(metadata.landingAdoptions))[0]!.operationId, pending.id);
    // Not followed as if queued: the client resubmits, which retries the admission of that same operation.
    const retry = landThroughRunner(f.cwd, { ...f.options, handoff });
    await waitFor(() => f.log.operation(pending.id)?.kind === "landing" && (f.log.operation(pending.id) as { admission?: string }).admission === "admitted");
    assert.equal(f.log.events().filter((row) => row.event.type === "submitted").length, 1);
    assert.equal(f.requestIds[0], f.requestIds[1]);
    f.append(pending.id, { type: "cancelled", reason: "fixture done" });
    await retry;
  } finally { await f.dispose(); }
}, 60_000);

test("a landing submitted before the runner location changed is still followed on the runner that accepted it", async () => {
  const f = await fixture();
  let reached = 0;
  const other = await serveRunner(async () => { reached += 1; return Response.json({ error: "not this runner" }, { status: 500 }); }, { host: "127.0.0.1", port: 0 });
  try {
    const abort = new AbortController();
    const first = landThroughRunner(f.cwd, { ...f.options, signal: abort.signal });
    const stopped = assert.rejects(first);
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const operation = f.log.openOperations()[0]!;
    abort.abort();
    await stopped;
    f.lines.length = 0;
    const second = landThroughRunner(f.cwd, { ...f.options, location: other.url });
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    assert.ok(f.lines.some((line) => line.includes(`on ${f.server.url}, where it was submitted`)));
    f.append(operation.id, { type: "cancelled", reason: "fixture done" });
    const result = await second;
    assert.equal(result.operation.id, operation.id);
    assert.equal(reached, 0);
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1);
    // Its log, outcome and evidence are read from that runner too.
    assert.equal(await operationRunnerLocation(operation.id, { SLIPJAY_RUNNER: other.url }), f.server.url);
    assert.equal(await operationRunnerLocation("op_unknown", { SLIPJAY_RUNNER: other.url }), other.url);
  } finally { await other.close(); await f.dispose(); }
});
