import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./runner-queue-fixture.ts";

/** A production deploy with migrations, after landing a first migration: non-additive unless `additive`. */
export async function productionMigrations({ additive = false } = {}) {
  const f = await fixture(true, true, { minIntervalMs: 0, production: "migrations" });
  const promote = async (commit: string) => {
    const promotion = f.submitRelease(commit);
    await f.land(promotion);
    await f.queue.idle();
    const outcome = f.result(promotion);
    assert.ok(outcome?.type === "released" && outcome.deploy, JSON.stringify(outcome));
    return f.log.operation(outcome.deploy)!;
  };
  // Health checks run side by side, so each unbroken run of them is compared in sorted order.
  const order = async () => {
    const steps = await f.lines("order.log");
    await rm(join(f.root, "order.log"), { force: true });
    return steps.reduce<string[][]>((runs, step) => {
      const last = runs.at(-1);
      if (step.startsWith("health ") && last?.[0]?.startsWith("health ")) last.push(step);
      else runs.push([step]);
      return runs;
    }, []).flatMap((run) => run.sort());
  };
  try {
    // Unless `additive`, the migration is non-additive, so only a deploy that changed nothing in the schema (a refused first verify, or one that never reached the migrations) is rolled back automatically.
    await f.land(f.submit(await f.candidate(additive ? "schema/add" : "schema/drop")));
    await f.queue.idle();
    const first = f.main();
    const before = f.releaseRef();
    return { f, promote, order, first, before };
  } catch (error) { await f.dispose(); throw error; }
}
