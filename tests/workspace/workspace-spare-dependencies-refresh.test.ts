import { jj } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { readySpares, refreshSpares } from "../../src/lib/workspace/workspace-pool.ts";
import { installInputFingerprint } from "../../src/lib/workspace/install-inputs.ts";
import { write, advance, bunProject, refill } from "./fixtures/workspace-spare-dependencies-fixture.ts";

test("a refill refreshes one spare in place, only when the integration head's install inputs changed, and a claim takes it", async () => {
  const f = await bunProject({ spares: 3 });
  try {
    await refill(f.repo);
    assert.equal((await readySpares(f.repo)).length, 3);
    await write(f.repo, { "README.md": "changed\n" });
    advance(f.repo, "Change non-install files");
    const heads = async () => Promise.all((await readySpares(f.repo)).map((spare) => jj(spare.root, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]).trim()));
    const parked = await heads();
    assert.deepEqual(await refreshSpares(f.repo), [], "unchanged install inputs leave every spare where it is");
    assert.deepEqual(await heads(), parked, "no spare was moved to the new head");

    await write(f.repo, { "packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0", engines: { node: ">=18" } }) });
    advance(f.repo, "Change an install input");
    const before = await f.count();
    const refreshed = await refreshSpares(f.repo);
    assert.deepEqual(refreshed.map((spare) => spare.dependencies), ["installed"], "one spare, installed over its own node_modules");
    assert.equal(await f.count(), before + 1);
    const [fresh] = await readySpares(f.repo).then((spares) => spares.filter((spare) => spare.name === refreshed[0]!.name));
    assert.equal((fresh!.metadata?.preparedDependencies as { installInputs?: string }).installInputs, await installInputFingerprint(fresh!.root));
    assert.match(await readFile(join(fresh!.root, "packages/x/package.json"), "utf8"), /"engines"/, "it is on the integration head");
    assert.deepEqual(await refreshSpares(f.repo), [], "the next claim is covered, so the others wait");

    const claimed = await createWorkspace("task", f.repo);
    assert.equal(claimed.workspacePath, fresh!.root, "the claim takes the refreshed spare");
    assert.deepEqual(Object.keys(claimed.steps).sort(), ["claim", "describe", "fetch", "fingerprint", "jjNew"], "a claim that reuses dependencies records where its time went, and no install");
    assert.ok(Object.values(claimed.steps).every((ms) => Number.isInteger(ms) && ms >= 0), JSON.stringify(claimed.steps));
    assert.equal((claimed.readiness as { reused?: boolean }).reused, true, "and reuses its dependencies");
    assert.equal(await f.count(), before + 1, "no install ran on claim");
    assert.deepEqual((await refreshSpares(f.repo)).map((spare) => spare.dependencies), ["installed"], "the next refill reaches one more");

    // The last spare is still on the old inputs: its claim installs over its node_modules, never cloning a replacement,
    // and its timing keeps the fingerprints that install takes apart from the install itself.
    assert.equal((await createWorkspace("next", f.repo)).readiness && (await readySpares(f.repo)).length, 1);
    const stale = await createWorkspace("stale", f.repo);
    assert.equal(stale.pooled, true);
    assert.notEqual((stale.readiness as { reused?: boolean }).reused, true);
    assert.equal((stale.readiness as { seeded?: boolean }).seeded, undefined, "the stale spare's own node_modules were installed over");
    assert.ok((stale.steps.install ?? 0) > 0 && (stale.steps.fingerprint ?? 0) > 0, JSON.stringify(stale.steps));
  } finally {
    await f.dispose();
  }
}, 300_000);


test("after install inputs revert, the next claim takes the spare that still has them", async () => {
  const f = await bunProject({ spares: 2 });
  try {
    await refill(f.repo);
    const original = await readFile(join(f.repo, "packages/x/package.json"), "utf8");
    await write(f.repo, { "packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0", engines: { node: ">=18" } }) });
    advance(f.repo, "Change an install input");
    const [changed] = await refreshSpares(f.repo);
    await write(f.repo, { "packages/x/package.json": original });
    advance(f.repo, "Revert it");
    assert.deepEqual(await refreshSpares(f.repo), [], "the other spare still has the head's install inputs");
    const changedRoot = (await readySpares(f.repo)).find((spare) => spare.name === changed!.name)!.root;
    const before = await f.count();
    const claimed = await createWorkspace("task", f.repo);
    assert.notEqual(claimed.workspacePath, changedRoot, "not the newer spare refreshed for the reverted inputs");
    assert.equal((claimed.readiness as { reused?: boolean }).reused, true, "the claim took the matching spare");
    assert.equal(await f.count(), before, "no install ran");
  } finally {
    await f.dispose();
  }
}, 300_000);