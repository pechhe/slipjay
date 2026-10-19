import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { setPolicy, showPolicy } from "../../src/lib/policy/policy-command.ts";
import { readRunLog } from "../../src/lib/runner/runner-client.ts";
import { jj, project } from "../support/workspace-project.ts";
import { withTestRunner } from "../support/test-runner.ts";
import { slowGate } from "./fixtures/policy-command-fixture.ts";

test("policy set lands settings without the landing check, and a second clone reads them after fetch", async () => {
  const f = await project({ verify: slowGate, policy: { parallelExecution: true } });
  try {
    await withTestRunner(f, async ({ location, env }) => {
      const before = await showPolicy(f.repo);
      assert.deepEqual(before.settings.spares, 1);
      assert.equal(before.settings.process, "standard");
      assert.deepEqual(before.retired, ["parallelExecution"]);
      const started = Date.now();
      const result = await setPolicy(f.repo, { base: before.revision, patch: { spares: 3, process: "light" }, location, env });
      assert.equal(result.phase, "landed", JSON.stringify(result));
      if (result.phase !== "landed") return;
      assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
      const log = await readRunLog(location, result.operationId, env);
      assert.match(log, /verification_skipped/);
      assert.doesNotMatch(log, /setTimeout/);

      const clone = join(f.root, "second-clone");
      jj(f.root, ["git", "clone", `file://${f.remote}`, clone]);
      jj(clone, ["git", "fetch"]);
      const after = await showPolicy(clone);
      assert.equal(after.revision, result.revision);
      assert.equal(after.settings.spares, 3);
      assert.equal(after.settings.process, "light");
      assert.deepEqual(after.retired, []);

      // Removing the check is a settings change too; a save from the earlier read is refused as stale.
      const removed = await setPolicy(f.repo, { base: after.revision, patch: { requiredLandingVerification: [] }, location, env });
      assert.equal(removed.phase, "landed", JSON.stringify(removed));
      const stale = await setPolicy(f.repo, { base: before.revision, patch: { spares: 2 }, location, env });
      assert.equal(stale.phase, "refused");
      assert.match(stale.phase === "refused" ? stale.reason : "", /Stale base/);
    });
  } finally { await f.dispose(); }
}, 180_000);

test("policy set refuses fields outside the settings and checks it cannot run, distinguishing refusal from failure", async () => {
  const f = await project({ verify: slowGate });
  try {
    await withTestRunner(f, async ({ location, env }) => {
      const { revision } = await showPolicy(f.repo);
      const outside = await setPolicy(f.repo, { base: revision, patch: { releaseBranch: "release" }, location, env });
      assert.deepEqual(outside.phase, "refused");
      assert.match(outside.phase === "refused" ? outside.reason : "", /refused releaseBranch/);
      const invalid = await setPolicy(f.repo, { base: revision, patch: { process: "minimal" }, location, env });
      assert.equal(invalid.phase, "refused");
      const missing = await setPolicy(f.repo, { base: revision, patch: { requiredLandingVerification: [{ executable: "slipjay-no-such-tool", args: [] }] }, location, env });
      assert.equal(missing.phase, "rejected", JSON.stringify(missing));
      assert.match(missing.phase === "rejected" ? missing.reason : "", /does not resolve on the runner host/);
      assert.equal((await showPolicy(f.repo)).revision, revision);
    });
  } finally { await f.dispose(); }
}, 180_000);
