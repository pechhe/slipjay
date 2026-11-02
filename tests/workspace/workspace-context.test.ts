import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { project } from "../support/workspace-project.ts";
import { workspaceContext } from "../../src/lib/infra/workspace-jj.ts";

/** The listing `workspaceContext` makes, named so a failure of another jj call cannot pass. */
const LISTING_FAILURE = /^jj --color=never --ignore-working-copy workspace failed/m;

/** Run `work` with exactly `path`, which is how the tests take jj away. */
async function withPath<T>(path: string, work: () => Promise<T>): Promise<T> {
  const before = process.env.PATH;
  process.env.PATH = path;
  try {
    return await work();
  } finally {
    process.env.PATH = before;
  }
}

test("workspaceContext returns null outside a repository", async () => {
  const outside = await mkdtemp(join(tmpdir(), "slipjay-no-repo-"));
  assert.equal(await workspaceContext(outside), null);
});

test("workspaceContext rethrows a jj failure inside a repository", async () => {
  const f = await project();
  try {
    const bin = await mkdtemp(join(tmpdir(), "slipjay-broken-jj-"));
    await writeFile(join(bin, "jj"), "#!/bin/sh\nexit 1\n");
    await chmod(join(bin, "jj"), 0o755);
    await withPath(`${bin}:${process.env.PATH ?? ""}`, () => assert.rejects(workspaceContext(f.repo), (error: Error) => {
      assert.match(error.message, LISTING_FAILURE);
      return true;
    }));
  } finally {
    await f.dispose();
  }
});

test("workspaceContext rethrows when jj cannot start at all", async () => {
  const f = await project();
  try {
    // A PATH holding nothing: jj cannot be spawned, the other way its listing fails.
    const empty = await mkdtemp(join(tmpdir(), "slipjay-no-path-"));
    await withPath(empty, () => assert.rejects(workspaceContext(f.repo), (error: Error) => {
      assert.match(error.message, LISTING_FAILURE);
      assert.match(error.message, /jj could not start/);
      return true;
    }));
  } finally {
    await f.dispose();
  }
});
