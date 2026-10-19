import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "vite-plus/test";
import { landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { candidateBookmark } from "../../src/lib/runner/runner-contract.ts";
import { serveRunner } from "../../src/lib/runner/runner-http.ts";
import { jj } from "../support/workspace-project.ts";
import { fixture, waitFor } from "./fixtures/runner-client-fixture.ts";

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
    assert.equal(jj(f.cwd, ["bookmark", "list", candidateBookmark(f.change)]), "");
    f.lines.length = 0;
    const second = landThroughRunner(f.cwd, f.options);
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    f.append(operation.id, { type: "cancelled", reason: "fixture done" });
    const result = await second;
    assert.equal(result.operation.id, operation.id);
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1);
    assert.equal(result.ok, false);
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
  for (const status of [400, 401] as const) {
    const f = await fixture(false, false, status);
    try {
      await assert.rejects(landThroughRunner(f.cwd, f.options), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /unknown/);
        assert.match(error.message, /refus/);
        return true;
      });
      assert.equal(f.log.events().filter((row) => row.event.type === "submitted").length, 0);
    } finally { await f.dispose(); }
  }
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
