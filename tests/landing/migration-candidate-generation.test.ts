import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { jj, project, recordCheckout } from "../support/workspace-project.ts";
import { landOnTestRunner, withTestRunner } from "../support/test-runner.ts";
import { advance, append, write } from "./fixtures/migration-candidate-fixture.ts";

test("the runner retains no-op and append migration behaviour", async () => {
  const f = await project({ verify: recordCheckout, ignore: "node_modules\n", policy: { migrationFinalization: {
    mode: "late_bound_serialized", triggerPaths: ["schema"], artifactPaths: ["migrations"],
    generate: { executable: "bun", args: ["generate.mjs"] }, verify: { executable: "bun", args: ["verify.mjs"] },
  } } });
  try {
    await write(f.repo, "schema/source", "old");
    await write(f.repo, "verify.mjs", `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(join(f.root, "migration-verified"))}, "yes");`);
    advance(f.repo, "Configure migration");
    let step = 0;
    await withTestRunner(f, async (runner) => {
      for (const [name, source] of [["no-op", ""], ["append", append]] as const) {
        step++;
        jj(f.repo, ["git", "fetch"]);
        jj(f.repo, ["new", "main@origin"]);
        await write(f.repo, "generate.mjs", source);
        advance(f.repo, `Configure ${name}`);
        const workspace = (await createWorkspace(`migration-${step}`, f.repo)).workspacePath;
        await write(workspace, "schema/source", `v${step}`);
        jj(workspace, ["describe", "-m", `Change schema ${step}`]);
        jj(workspace, ["new"]);
        const result = await landOnTestRunner(runner, workspace);
        assert.equal(result.ok, true, `${name}: ${result.lines.join("\n")}`);
      }
    });
  } finally { await f.dispose(); }
}, 180_000);
