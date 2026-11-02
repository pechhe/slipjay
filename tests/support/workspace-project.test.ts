import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { fixtureJjSetting } from "./jj-user-config.ts";
import { configureLocalGithubTransport, jj, project } from "./workspace-project.ts";

// A test that overruns its timeout keeps running while the next test in the file starts, and JJ's executable path is
// one setting for the whole file. These pin what a late restore may touch: only its own wrapper, and only while it
// still exists.

test("a restore a test reached after the next one started leaves that fixture's wrapper in place", async () => {
  const overrun = await project();
  const following = await project();
  try {
    const late = await configureLocalGithubTransport(overrun);
    const next = await configureLocalGithubTransport(following);
    late.restore();
    assert.equal(fixtureJjSetting("git.executable-path"), join(following.root, "fixture-git"), "the live fixture keeps its wrapper");
    assert.match(jj(following.repo, ["git", "remote", "list"]), /^origin https:\/\/github\.com\/fixture\/project\.git$/m);
    next.restore();
    assert.equal(fixtureJjSetting("git.executable-path"), "git", "the last restore returns JJ to its own git");
  } finally { await overrun.dispose(); await following.dispose(); }
}, 120_000);

test("a restore after its fixture is gone returns JJ to its own git instead of a deleted path", async () => {
  const f = await project();
  const transport = await configureLocalGithubTransport(f);
  try {
    await rm(f.root, { recursive: true, force: true });
    transport.restore();
    assert.equal(fixtureJjSetting("git.executable-path"), "git");
  } finally { await f.dispose(); }
}, 120_000);
