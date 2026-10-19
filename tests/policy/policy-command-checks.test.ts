import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { setPolicy, showPolicy } from "../../src/lib/policy/policy-command.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { landThroughRunner, readRunLog } from "../../src/lib/runner/runner-client.ts";
import { jj, project } from "../support/workspace-project.ts";
import { withTestRunner } from "../support/test-runner.ts";
import { slowGate } from "./fixtures/policy-command-fixture.ts";

test("policy set lands an added check without running any check, and the next landing runs it", async () => {
  const f = await project({ verify: slowGate });
  try {
    await withTestRunner(f, async ({ location, env }) => {
      const { revision } = await showPolicy(f.repo);
      const added = { executable: "node", args: ["-e", "console.log('added check ran')"] };
      const started = Date.now();
      const result = await setPolicy(f.repo, { base: revision, patch: { requiredLandingVerification: [added] }, location, env });
      assert.equal(result.phase, "landed", JSON.stringify(result));
      if (result.phase !== "landed") return;
      assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
      assert.doesNotMatch(await readRunLog(location, result.operationId, env), /added check ran|setTimeout/);
      // An ordinary landing after it is gated by the new check.
      const next = (await createWorkspace("ordinary change", f.repo)).workspacePath;
      await writeFile(join(next, "ordinary.txt"), "ordinary\n");
      jj(next, ["describe", "-m", "Add an ordinary file"]);
      const landed = await landThroughRunner(next, { location, env });
      assert.equal(landed.operation.result?.type, "landed", JSON.stringify(landed.operation.result));
      assert.match(await readRunLog(location, landed.operation.id, env), /added check ran|console\.log/);
    });
  } finally { await f.dispose(); }
}, 180_000);
