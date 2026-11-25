import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
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

test("a transient ls-remote failure is retried before the tip is compared", async () => {
  const f = await project();
  try {
    const publisher = join(f.root, "publisher");
    jj(f.root, ["git", "clone", f.remote, publisher]);
    // A Git that fails its first ls-remote the way a dropped SSH connection does, then behaves.
    const wrapper = join(f.root, "flaky-git");
    const calls = join(f.root, "ls-remote-calls");
    await writeFile(wrapper, `#!/bin/sh\ncase "$*" in *ls-remote*) echo x >> "${calls}"; if [ "$(wc -l < "${calls}")" -le 1 ]; then echo "kex_exchange_identification: Connection closed by remote host" >&2; echo "fatal: Could not read from remote repository." >&2; exit 128; fi;; esac\nexec git "$@"\n`);
    await chmod(wrapper, 0o755);
    assert.equal(await fetchIntegrationIfMoved(publisher, "origin", "main", wrapper), false, "the retried read saw the tracked tip, so no fetch");
    assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 2, "one failure, one retry");
  } finally { await f.dispose(); }
}, 120_000);
