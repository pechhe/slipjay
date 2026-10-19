import { jj, project } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { primary, land } from "./fixtures/landing-primary-checkout-fixture.ts";

test("uncommitted primary edits that would conflict with the landing stay exactly where they are", async () => {
  const f = await project();
  try {
    await writeFile(join(f.repo, "clash.txt"), "local\n");
    const before = primary(f);
    const { result } = await land(f, "clash.txt");
    assert.equal(result.primaryCheckout?.action, "left");
    assert.equal(result.primaryCheckout?.reason, "edits-conflict");
    assert.match(result.primaryCheckout?.warning ?? "", /conflict/);
    assert.equal(result.cleanupPending, false);
    assert.deepEqual(primary(f), before);
    assert.equal(await readFile(join(f.repo, "clash.txt"), "utf8"), "local\n");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a conflicted primary checkout is reported as a warning and left for its owner", async () => {
  const f = await project();
  try {
    await writeFile(join(f.repo, "README.md"), "a\n");
    jj(f.repo, ["commit", "-m", "a"]);
    const a = jj(f.repo, ["log", "-r", "@-", "--no-graph", "-T", "change_id"]);
    jj(f.repo, ["new", "main"]);
    await writeFile(join(f.repo, "README.md"), "b\n");
    jj(f.repo, ["rebase", "-r", "@", "--onto", a]);
    const before = primary(f);
    assert.equal(before.conflict, true);

    const { result } = await land(f, "conflict.txt");
    assert.equal(result.primaryCheckout?.action, "left");
    assert.match(result.primaryCheckout?.warning ?? "", /conflicts/);
    assert.equal(result.cleanupPending, false);
    assert.deepEqual(primary(f), before);
  } finally {
    await f.dispose();
  }
}, 120_000);
