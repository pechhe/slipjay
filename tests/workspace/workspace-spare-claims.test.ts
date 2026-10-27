import { jj } from "../support/workspace-project.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { readySpares } from "../../src/lib/workspace/workspace-pool.ts";
import { spareRecords } from "../../src/lib/workspace/workspace-spares.ts";
import { bunProject, refill, withMachineSpares } from "./fixtures/workspace-spare-dependencies-fixture.ts";

const head = (root: string) => jj(root, ["log", "-r", "@", "--no-graph", "-T", "change_id"]).trim();

test("the refill never adopts, counts or retires a workspace a thread has claimed", async () => {
  const f = await bunProject({ spares: 1 });
  try {
    await refill(f.repo);
    const claimed = await createWorkspace("task", f.repo);
    assert.equal(claimed.pooled, true, "the claim takes the provisioned spare");
    await writeFile(join(claimed.current.root, "work.txt"), "in progress\n");
    const change = head(claimed.current.root);

    const outcomes = await refill(f.repo);
    assert.equal(outcomes.filter((outcome) => "retired" in outcome).length, 0, "nothing retires");
    const [spare] = await readySpares(f.repo);
    assert.ok(spare, "the refill makes a new spare");
    assert.notEqual(spare.root, claimed.current.root, "the new spare is not the claimed checkout");
    assert.ok(existsSync(join(claimed.current.root, "work.txt")), "the claimed checkout keeps its work");
    assert.equal(head(claimed.current.root), change, "the claimed checkout was not reset");
    assert.ok(!(await spareRecords(f.repo)).some((record) => record.workspacePath === claimed.current.root), "the claim is not one of the pool's spares");
  } finally {
    await f.dispose();
  }
}, 240_000);

test("a spare-marked checkout a live process works in is neither claimed, counted nor retired, and the refill names it", async () => {
  const f = await bunProject({ spares: 1 });
  try {
    await refill(f.repo);
    const [held] = await readySpares(f.repo);
    assert.ok(held);
    await writeFile(join(held.root, "work.txt"), "in progress\n");
    const holder = spawn("sleep", ["300"], { cwd: held.root, stdio: "ignore" });
    try {
      await waitFor(async () => !(await readySpares(f.repo)).some((spare) => spare.root === held.root));
      const change = head(held.root);
      const outcomes = await refill(f.repo);
      assert.ok(outcomes.some((outcome) => "held" in outcome && outcome.held === held.name && String((outcome as { holders?: unknown }).holders).includes(`pid ${holder.pid}`)),
        "the refill names the held checkout and its holder");
      assert.ok(outcomes.some((outcome) => "provisioned" in outcome && outcome.provisioned), "the held checkout does not count toward the allowance");
      const claimed = await createWorkspace("task", f.repo);
      assert.equal(claimed.pooled, true);
      assert.notEqual(claimed.current.root, held.root, "a claim does not take the held checkout");
      await withMachineSpares({ [f.repo]: 0 }, async () => {
        const retired = (await refill(f.repo)).filter((outcome) => "retired" in outcome).map((outcome) => outcome.retired);
        assert.ok(!retired.includes(held.name), "lowering the allowance does not retire the held checkout");
      });
      assert.ok(existsSync(join(held.root, "work.txt")), "the held checkout keeps its work");
      assert.equal(head(held.root), change, "the held checkout was not reset");
    } finally {
      holder.kill();
    }
    await waitFor(async () => (await readySpares(f.repo)).some((spare) => spare.root === held.root));
    assert.ok((await spareRecords(f.repo)).some((record) => record.workspacePath === held.root), "once its holder exits the checkout is a spare again");
  } finally {
    await f.dispose();
  }
}, 240_000);

async function waitFor(condition: () => Promise<boolean>) {
  for (const started = Date.now(); !await condition();) {
    if (Date.now() - started > 10_000) throw new Error("condition not met within 10 s");
    await new Promise((settle) => setTimeout(settle, 50));
  }
}
