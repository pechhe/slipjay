import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createRunnerHandler } from "../../src/lib/runner/runner-api.ts";
import { RUNNER_API } from "../../src/lib/runner/runner-contract.ts";
import { serveRunner } from "../../src/lib/runner/runner-http.ts";
import { openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { installRevisionOf } from "../../src/lib/runner/runner-revision.ts";

const commit = "389fc114e3a0e2b6a0e5acf2a1c4e5b2d1b7f0a3";

/** A file `src/lib/runner/runner-revision.ts` three directories below `root`, as an install keeps it. */
async function moduleIn(root: string): Promise<string> {
  const file = join(root, "src/lib/runner/runner-revision.ts");
  await mkdir(join(root, "src/lib/runner"), { recursive: true });
  await writeFile(file, "// a module of the install\n");
  return file;
}

test("the running code's own directory names the install it came from", async () => {
  const home = await mkdtemp(join(tmpdir(), "slipjay-revision-"));
  try {
    const install = await moduleIn(join(home, "installs", commit));
    assert.equal(installRevisionOf(install), commit, "an install directory is named by its commit");
    // The slot moves before the runner restarts, so a symlinked path answers for the install it points at.
    await symlink(join(home, "installs", commit), join(home, "runner-install"));
    assert.equal(installRevisionOf(join(home, "runner-install", "src/lib/runner/runner-revision.ts")), commit);
    // A development checkout, a test and a tree built anywhere else are no install at all.
    assert.equal(installRevisionOf(await moduleIn(join(home, "checkout"))), null);
    assert.equal(installRevisionOf(await moduleIn(join(home, "installs", "not-a-commit"))), null);
    assert.equal(installRevisionOf(join(home, "absent/src/lib/runner/runner-revision.ts")), null);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the runner's health answer carries the build it runs, and says nothing when it runs a checkout", async () => {
  const log = openOperationLog(":memory:", {});
  const handler = (revision?: string | null) => createRunnerHandler({ log, token: "test-secret", runnerName: "test-runner",
    readLog: async () => null, onSubmitted: () => {}, kill: () => ({ status: "idle" }),
    subscribe: () => () => {}, ...revision === undefined ? {} : { revision } });
  const health = async (revision?: string | null) => {
    const server = await serveRunner(handler(revision), { host: "127.0.0.1", port: 0 });
    try {
      const response = await fetch(`${server.url}${RUNNER_API}/health`, { headers: { authorization: "Bearer test-secret" }, signal: AbortSignal.timeout(10_000) });
      return await response.json() as Record<string, unknown>;
    } finally { await server.close(); }
  };
  try {
    assert.equal((await health(commit)).revision, commit);
    assert.equal("revision" in await health(null), false, "an install the runner is not in reports no revision");
    // Absent the input, the answer describes the tree this code was loaded from: a checkout, here.
    assert.equal("revision" in await health(undefined), false);
  } finally { log.close(); }
});
