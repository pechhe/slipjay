import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { listWorkspaces } from "../../src/lib/workspace/workspace-state.ts";
import { patchTask, setPolicy, showPolicy } from "../../src/lib/policy/policy-command.ts";
import { serveRunner } from "../../src/lib/runner/runner-http.ts";
import { fixture, waitFor } from "./fixtures/runner-client-fixture.ts";

test("policy set rerun after a failure after integration reports it again and submits nothing new", async () => {
  const f = await fixture();
  try {
    const { revision } = await showPolicy(f.repo);
    const options = { base: revision, patch: { spares: 2 }, location: f.options.location, env: f.options.env, onLine: (line: string) => { f.lines.push(line); } };
    const running = setPolicy(f.repo, options);
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const operation = f.log.openOperations()[0]!;
    f.append(operation.id, { type: "integrated", base: "fixture-base", commitId: "f".repeat(40) });
    f.append(operation.id, { type: "failed", stage: "publishing", reason: "remote unavailable" });
    assert.equal((await running).phase, "failed-after-integration");
    const rerun = await setPolicy(f.repo, options);
    assert.equal(rerun.phase, "failed-after-integration", JSON.stringify(rerun));
    assert.equal(rerun.phase === "failed-after-integration" ? rerun.operationId : "", operation.id);
    // Publication is unresolved on that runner, so a rerun after changing location still asks it, not the new one.
    let reached = 0;
    const other = await serveRunner(async () => { reached += 1; return Response.json({ error: "not this runner" }, { status: 500 }); }, { host: "127.0.0.1", port: 0 });
    try {
      const moved = await setPolicy(f.repo, { ...options, location: other.url });
      assert.equal(moved.phase, "failed-after-integration", JSON.stringify(moved));
      assert.equal(reached, 0);
    } finally { await other.close(); }
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1);
  } finally { await f.dispose(); }
});

test("policy set the runner refuses is reported refused and leaves no attempt behind", async () => {
  const f = await fixture(false, false, 400);
  try {
    const { revision, digest } = await showPolicy(f.repo);
    const attempt = async (patch: Record<string, unknown>) => (await listWorkspaces(f.repo)).some((entry) => entry.metadata?.task === patchTask(digest!, patch));
    const refused = await setPolicy(f.repo, { base: revision, patch: { spares: 2 }, location: f.options.location, env: f.options.env });
    assert.equal(refused.phase, "refused", JSON.stringify(refused));
    assert.equal(await attempt({ spares: 2 }), false);
    // A runner that cannot be reached submits nothing either.
    const unreachable = await setPolicy(f.repo, { base: revision, patch: { spares: 3 }, location: "http://127.0.0.1:9", env: f.options.env });
    assert.equal(unreachable.phase, "refused", JSON.stringify(unreachable));
    assert.equal(await attempt({ spares: 3 }), false);
  } finally { await f.dispose(); }
});

test("policy set after a lost submission response reconciles the same request instead of submitting twice", async () => {
  const f = await fixture(false, false, true);
  try {
    const { revision } = await showPolicy(f.repo);
    const options = { base: revision, patch: { spares: 2 }, location: f.options.location, env: f.options.env };
    const lost = await setPolicy(f.repo, options);
    assert.equal(lost.phase, "uncertain", JSON.stringify(lost));
    const rerun = await setPolicy(f.repo, options);
    assert.equal(rerun.phase, "rejected", JSON.stringify(rerun));
    assert.equal(new Set(f.requestIds).size, 1);
    assert.equal(f.log.events().filter((stored) => stored.event.type === "submitted").length, 1);
  } finally { await f.dispose(); }
});

test("policy set reports a failure after integration apart from a refusal before it", async () => {
  const f = await fixture();
  try {
    const { revision } = await showPolicy(f.repo);
    const running = setPolicy(f.repo, { base: revision, patch: { spares: 2 }, location: f.options.location, env: f.options.env, onLine: (line) => { f.lines.push(line); } });
    await waitFor(() => f.lines.some((line) => line.includes("queued")));
    const operation = f.log.openOperations()[0]!;
    f.append(operation.id, { type: "integrated", base: "fixture-base", commitId: "f".repeat(40) });
    f.append(operation.id, { type: "failed", stage: "publishing", reason: "remote unavailable" });
    const result = await running;
    assert.equal(result.phase, "failed-after-integration", JSON.stringify(result));
  } finally { await f.dispose(); }
});
