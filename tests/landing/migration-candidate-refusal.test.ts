import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { jj, project, recordCheckout } from "../support/workspace-project.ts";
import { landOnTestRunner, withTestRunner } from "../support/test-runner.ts";
import { advance, append, write } from "./fixtures/migration-candidate-fixture.ts";

test("the runner refuses undeclared migration artifacts and rolls back failed generation with evidence", async () => {
  const f = await project({ verify: recordCheckout, ignore: "node_modules\n", policy: { migrationFinalization: {
    mode: "late_bound_serialized", triggerPaths: ["schema"], artifactPaths: ["migrations"],
    generate: { executable: "bun", args: ["generate.mjs"] }, verify: { executable: "bun", args: ["verify.mjs"] },
  } } });
  try {
    await write(f.repo, "schema/source", "old");
    await write(f.repo, "verify.mjs", `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(join(f.root, "migration-verified"))}, "yes");`);
    advance(f.repo, "Configure migration");
    const remoteMain = () => execFileSync("git", ["--git-dir", f.remote, "rev-parse", "main"], { encoding: "utf8" }).trim();
    let step = 0;
    await withTestRunner(f, async (runner) => {
      for (const [name, source] of [
        ["undeclared artifact", append + 'writeFileSync("unexpected", "bad");'],
        ["failed generation rollback", append + 'console.error("generation evidence");process.exit(9);'],
      ] as const) {
        step++;
        jj(f.repo, ["git", "fetch"]);
        jj(f.repo, ["new", "main@origin"]);
        await write(f.repo, "generate.mjs", source);
        advance(f.repo, `Configure ${name}`);
        const workspace = (await createWorkspace(`migration-refusal-${step}`, f.repo)).workspacePath;
        await write(workspace, "schema/source", `v${step}`);
        jj(workspace, ["describe", "-m", `Change schema ${step}`]);
        jj(workspace, ["new"]);
        const base = remoteMain();
        const result = await landOnTestRunner(runner, workspace);
        const output = result.lines.join("\n");
        assert.equal(result.ok, false, `${name}: ${output}`);
        assert.equal(remoteMain(), base, name);
        if (name === "failed generation rollback") assert.match(output, /generation evidence/);
      }
    });
  } finally { await f.dispose(); }
}, 180_000);
