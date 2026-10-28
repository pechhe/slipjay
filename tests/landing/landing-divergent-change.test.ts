import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { landingPreview } from "../../src/lib/landing/landing-steps.ts";
import { jj, project } from "../support/workspace-project.ts";

const commit = (cwd: string, revision: string) => jj(cwd, ["log", "-r", revision, "--no-graph", "-T", "commit_id"]);

test("a landing whose change is divergent is refused before anything is described or queued, naming each copy and what keeps it", async () => {
  const f = await project();
  try {
    await writeFile(join(f.repo, "candidate"), "candidate\n");
    jj(f.repo, ["describe", "-m", "Candidate"]);
    // Another workspace builds on the candidate, as a follow-up Spec's lead does.
    const helper = join(f.root, "helper");
    jj(f.repo, ["workspace", "add", "--name", "helper", "-r", "@", helper]);
    // The candidate is rewritten here while an operation elsewhere rewrites the old version too: two visible copies.
    const original = commit(f.repo, "@");
    const before = jj(f.repo, ["op", "log", "--limit", "1", "--no-graph", "-T", "id"]);
    jj(f.repo, ["describe", "-m", "Candidate, squashed"]);
    jj(f.repo, ["--at-operation", before, "--ignore-working-copy", "describe", "-r", original, "-m", "Candidate, elsewhere"]);
    const change = jj(f.repo, ["log", "-r", "@", "--no-graph", "-T", "change_id"]);
    const copies = jj(f.repo, ["log", "-r", `change_id(${change})`, "--no-graph", "-T", 'commit_id ++ "\\n"']).split("\n").filter(Boolean);
    assert.equal(copies.length, 2, "the candidate's change is divergent");
    const candidate = commit(f.repo, "@");
    const description = () => jj(f.repo, ["log", "-r", candidate, "--no-graph", "-T", "description.first_line()"]);
    const described = description();

    await assert.rejects(landingPreview(f.repo, { allowDefaultWorkspace: true }), (error: Error) => {
      assert.match(error.message, /is divergent: 2 visible commits share it/);
      for (const copy of copies) assert.ok(error.message.includes(copy), `names copy ${copy}`);
      assert.match(error.message, new RegExp(`${candidate} \\(this workspace's candidate\\): kept visible by workspace default, workspace helper\\n`));
      const other = copies.find((copy) => copy !== candidate)!;
      assert.ok(error.message.includes(`jj abandon ${other}`), "names the command that retires the other copy");
      assert.ok(error.message.includes(`jj metaedit --update-change-id -r ${other}`));
      return true;
    });
    // Refused up front: the candidate is untouched.
    assert.equal(commit(f.repo, "@"), candidate);
    assert.equal(description(), described);

    // Once the other copy is retired, the same candidate previews normally.
    jj(f.repo, ["abandon", copies.find((copy) => copy !== candidate)!]);
    const preview = await landingPreview(f.repo, { allowDefaultWorkspace: true });
    assert.equal(preview.target.commitId, candidate);
  } finally { await f.dispose(); }
}, 120_000);
