import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import * as commands from "../../src/lib/infra/workspace-command.ts";
import { assertRenameSafety, LandingRenameConflict } from "../../src/lib/landing/rename-safety.ts";
import { jj, project } from "../support/workspace-project.ts";

const commit = (cwd: string) => jj(cwd, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
const run = async (cwd: string, args: string[]) => jj(cwd, args);

for (const edited of [false, true]) test(`criss-cross ancestry ${edited ? "reports only edits beyond all bases" : "allows a rename and excludes edits already in a base"}`, async () => {
  const f = await project();
  try {
    const original = Array.from({ length: 20 }, (_, n) => `export const n${n} = ${n};\n`).join("");
    jj(f.repo, ["new", "main", "-m", "Seed paths"]);
    await writeFile(join(f.repo, "old.ts"), original);
    await writeFile(join(f.repo, "other-old.ts"), original + "// second\n");
    const seed = commit(f.repo);
    jj(f.repo, ["new", seed, "-m", "Already shared old-path edit"]);
    await writeFile(join(f.repo, "old.ts"), original + "// inherited\n");
    const left = commit(f.repo);
    jj(f.repo, ["new", seed, "-m", "Other branch"]);
    await writeFile(join(f.repo, "unrelated.ts"), "right\n");
    const right = commit(f.repo);
    jj(f.repo, ["new", left, right, "-m", "Candidate merge"]);
    jj(f.repo, ["new", "-m", "Rename two files"]);
    await rename(join(f.repo, "old.ts"), join(f.repo, "new.ts"));
    await rename(join(f.repo, "other-old.ts"), join(f.repo, "other-new.ts"));
    const source = commit(f.repo);
    jj(f.repo, ["new", right, left, "-m", "Integration merge"]);
    if (edited) {
      jj(f.repo, ["new", "-m", "YS-407: concurrent old-path edits"]);
      await writeFile(join(f.repo, "old.ts"), original + "// concurrent\n");
      await writeFile(join(f.repo, "other-old.ts"), original + "// another concurrent edit\n");
    }
    const tip = commit(f.repo);
    const bases = jj(f.repo, ["log", "-r", `heads(::${source} & ::${tip})`, "--no-graph", "-T", 'commit_id ++ "\\n"']).split("\n");
    assert.deepEqual(new Set(bases), new Set([left, right]));
    const calls = vi.spyOn(commands, "runWorkspaceCommand");
    try {
      if (edited) await assert.rejects(assertRenameSafety(f.repo, source, tip, run), (error: Error) => {
        assert.ok(error instanceof LandingRenameConflict);
        assert.deepEqual(new Set(error.paths), new Set(["old.ts", "other-old.ts"]));
        assert.match(error.message, /YS-407: concurrent old-path edits/);
        assert.ok(error.message.includes(tip));
        assert.ok(!error.message.includes(left), "base history must not be blamed");
        return true;
      });
      else await assertRenameSafety(f.repo, source, tip, run);
      assert.equal(calls.mock.calls.filter(([command, args]) => command === "git" && args[2] === "log").length, 1, "all renamed paths share one history walk");
    } finally { calls.mockRestore(); }
  } finally { await f.dispose(); }
});
