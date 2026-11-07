import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { fetchIntegrationIfMoved } from "../../src/lib/landing/landing-steps.ts";
import { jj, project } from "../support/workspace-project.ts";

test("the integration branch is fetched only when the remote's tip differs from the tracked one (SJ-200)", async () => {
  const f = await project();
  try {
    const publisher = join(f.root, "publisher");
    jj(f.root, ["git", "clone", f.remote, publisher]);
    const tracked = () => jj(publisher, ["log", "-r", "main@origin", "--no-graph", "-T", "commit_id"]);
    const before = tracked();
    assert.equal(await fetchIntegrationIfMoved(publisher, "origin", "main"), false, "a tip it already tracks needs no fetch");
    // Someone else publishes; the next read sees it at once.
    await writeFile(join(f.repo, "elsewhere"), "elsewhere\n");
    jj(f.repo, ["describe", "-m", "Published elsewhere"]);
    jj(f.repo, ["bookmark", "set", "main", "-r", "@"]);
    jj(f.repo, ["git", "push", "--remote", "origin", "--bookmark", "main"]);
    const published = jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]);
    assert.notEqual(published, before);
    assert.equal(await fetchIntegrationIfMoved(publisher, "origin", "main"), true);
    assert.equal(tracked(), published);
    assert.equal(await fetchIntegrationIfMoved(publisher, "origin", "main"), false);
  } finally { await f.dispose(); }
}, 120_000);
