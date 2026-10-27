import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test, vi } from "vite-plus/test";
import { LandingNotSubmitted, landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { candidateBookmark } from "../../src/lib/runner/runner-contract.ts";
import { serveRunner } from "../../src/lib/runner/runner-http.ts";
import { jj } from "../support/workspace-project.ts";
import { fixture, waitFor } from "./fixtures/runner-client-fixture.ts";
import * as workspaceJj from "../../src/lib/infra/workspace-jj.ts";
import { workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";

test("following a server-side submission race records reattachment", async () => {
  const f = await fixture(false, true);
  try {
    const running = landThroughRunner(f.cwd, f.options);
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const op = f.log.openOperations()[0]!;
    const fact = f.log.events({ operationId: op.id }).find((row) => row.event.type === "client" && row.event.fact.kind === "land_follow")?.event;
    assert.equal(fact?.type === "client" && fact.fact.kind === "land_follow" && fact.fact.reattached, true);
    f.append(op.id, { type: "cancelled", reason: "fixture done" });
    await running;
  } finally { await f.dispose(); }
}, 60_000);

test("interrupting and reattaching submits once and publishes the exact candidate bookmark", async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    const first = landThroughRunner(f.cwd, { ...f.options, signal: abort.signal });
    const stopped = assert.rejects(first);
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const operation = f.log.openOperations()[0]!;
    abort.abort();
    await stopped;
    assert.equal(execFileSync("git", ["--git-dir", f.remote, "rev-parse", `refs/heads/${candidateBookmark(f.change)}`], { encoding: "utf8" }).trim(), f.commit);
    // Kept locally, with no ref of the remote's, until the operation has a result.
    const kept = jj(f.cwd, ["bookmark", "list", "--all-remotes", candidateBookmark(f.change), "-T", 'name ++ "@" ++ remote ++ "\\n"']);
    assert.match(kept, new RegExp(`^${candidateBookmark(f.change)}@$`, "m"));
    assert.doesNotMatch(kept, /@origin/);
    f.lines.length = 0;
    const second = landThroughRunner(f.cwd, f.options);
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    f.append(operation.id, { type: "cancelled", reason: "fixture done" });
    const result = await second;
    assert.equal(result.operation.id, operation.id);
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1);
    assert.equal(result.ok, false);
    assert.equal(jj(f.cwd, ["bookmark", "list", "--all-remotes", candidateBookmark(f.change)]), "", "retired with the result");
  } finally { await f.dispose(); }
});

test("a wrong token is refused clearly before publishing or submitting", async () => {
  const f = await fixture();
  try {
    await assert.rejects(landThroughRunner(f.cwd, { ...f.options, env: { ...process.env, SLIPJAY_RUNNER_TOKEN: "wrong" } }), /runner refused the credential/);
    assert.equal(f.log.events().length, 0);
    assert.throws(() => execFileSync("git", ["--git-dir", f.remote, "rev-parse", `refs/heads/${candidateBookmark(f.change)}`], { stdio: "pipe" }));
  } finally { await f.dispose(); }
});


test("an explicit submission refusal is not described as an unknown transport outcome", async () => {
  for (const status of [400, 401, 409, 503] as const) {
    const f = await fixture(false, false, status);
    try {
      await assert.rejects(landThroughRunner(f.cwd, f.options), (error: unknown) => {
        assert.ok(error instanceof LandingNotSubmitted);
        assert.doesNotMatch(error.message, /unknown/);
        assert.match(error.message, /refus/);
        return true;
      });
      assert.equal(f.log.events().filter((row) => row.event.type === "submitted").length, 0);
      const context = (await workspaceJj.workspaceContext(f.cwd))!;
      assert.deepEqual((await workspaceMetadata(context.current.name))!.pendingLandingRequests, {});
    } finally { await f.dispose(); }
  }
});

test("a running older candidate racing the POST does not leave a pending request for the refused source", async () => {
  const f = await fixture();
  const fetch = globalThis.fetch;
  const racing = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input) === `${f.server.url}/v1/operations` && init?.method === "POST") {
      f.append("op_older", { type: "submitted", repo: "fixture/project", changeId: f.change, commitId: "0".repeat(40), bookmark: candidateBookmark(f.change), submittedBy: "earlier" });
      f.append("op_older", { type: "stage", stage: "verifying" });
    }
    return fetch(input, init);
  });
  try {
    const running = landThroughRunner(f.cwd, f.options);
    void running.catch(() => {});
    await waitFor(() => f.lines.some((line) => line.includes("verifying")));
    const context = (await workspaceJj.workspaceContext(f.cwd))!;
    assert.deepEqual((await workspaceMetadata(context.current.name))!.pendingLandingRequests, {});
    f.append("op_older", { type: "failed", stage: "verifying", reason: "fixture failure" });
    assert.equal((await running).operation.id, "op_older");
  } finally { racing.mockRestore(); await f.dispose(); }
});

test("a failed candidate push releases its frozen pending request before a different source can land", async () => {
  const f = await fixture();
  const original = workspaceJj.jj;
  const pushing = vi.spyOn(workspaceJj, "jj").mockImplementation(async (cwd, args, options) => {
    if (args[0] === "git" && args[1] === "push") throw new Error("fixture push failed");
    return original(cwd, args, options);
  });
  try {
    await assert.rejects(landThroughRunner(f.cwd, f.options), (error) => error instanceof LandingNotSubmitted && /fixture push failed/.test(error.message));
    const context = (await workspaceJj.workspaceContext(f.cwd))!;
    const metadata = (await workspaceMetadata(context.current.name))!;
    assert.deepEqual(metadata.pendingLandingRequests, {});
    assert.equal(Object.keys(metadata.landingAdoptions as object).length, 1, "freeze happened before the push failed");
    assert.equal(f.log.openOperations().length, 0);
  } finally { pushing.mockRestore(); await f.dispose(); }
});

test("a landing the runner finds would conflict is reported as not submitted, with the runner's explanation", async () => {
  const f = await fixture(false, false, 422);
  try {
    await assert.rejects(landThroughRunner(f.cwd, f.options), (error) => error instanceof LandingNotSubmitted && /fixture refusal/.test(error.message));
    assert.equal(f.log.openOperations().length, 0);
  } finally { await f.dispose(); }
});

test("a submission the runner refused is not pinned, so a retry goes to the current runner location", async () => {
  const f = await fixture(false, false, 401);
  let reached = 0;
  const other = await serveRunner(async () => { reached += 1; return Response.json({ error: "fixture runner" }, { status: 400 }); }, { host: "127.0.0.1", port: 0 });
  try {
    await assert.rejects(landThroughRunner(f.cwd, f.options), /refused the credential/);
    f.lines.length = 0;
    await assert.rejects(landThroughRunner(f.cwd, { ...f.options, location: other.url }), /HTTP 400/);
    assert.ok(reached > 0);
    assert.ok(!f.lines.some((line) => line.includes("where it was submitted")));
  } finally { await other.close(); await f.dispose(); }
});


test("land refuses an unfinalisable committed reset before publishing or submitting its candidate", async () => {
  const f = await fixture();
  try {
    const { readFile, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const file = join(f.cwd, "slipjay.json");
    const policy = JSON.parse(await readFile(file, "utf8"));
    const command = { executable: "true", args: [] };
    policy.reset = { version: 1, target: "development-db", timeoutMs: 1000, intervalMs: 1, command, targetProbe: command };
    await writeFile(file, JSON.stringify(policy));
    await assert.rejects(landThroughRunner(f.cwd, f.options), (error: unknown) => {
      assert.ok(error instanceof LandingNotSubmitted);
      assert.match(error.message, /Invalid reset identity, deadline or interval/);
      return true;
    });
    assert.equal(f.log.events().filter((row) => row.event.type === "submitted").length, 0);
    assert.throws(() => execFileSync("git", ["--git-dir", f.remote, "rev-parse", `refs/heads/${candidateBookmark(f.change)}`], { stdio: "pipe" }));
  } finally { await f.dispose(); }
});
