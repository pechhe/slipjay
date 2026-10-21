import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { removeWorkspace } from "../../src/lib/workspace/workspace-lifecycle.ts";
import { provisionSpare } from "../../src/lib/workspace/workspace-pool.ts";
import { withWorkspaceTransaction } from "../../src/lib/infra/workspace-transaction.ts";
import { poolRefillLogPath } from "../../src/lib/workspace/workspace-paths.ts";
import { bunProject, refill, withMachineSpares } from "./fixtures/workspace-spare-dependencies-fixture.ts";

/** The JSON outcome of every `pool-refill.log` line that has one. */
const logged = async (): Promise<Array<Record<string, unknown>>> =>
  (await readFile(poolRefillLogPath(), "utf8").catch(() => "")).split("\n")
    .map((line) => line.match(/^\S+ (\{.*\})$/)?.[1]).filter((json): json is string => Boolean(json)).map((json) => JSON.parse(json));

test("a spare cloned from another checkout is logged as a clone with its timing and repository", async () => {
  const f = await bunProject();
  try {
    const outcome = await provisionSpare(f.repo);
    assert.equal(outcome.dependencySource, "clone", "the primary checkout's node_modules seeded it");
    assert.equal(typeof outcome.dependencyMs, "number");
    assert.equal(typeof outcome.cloneMs, "number");
    assert.equal(outcome.integrationRoot, f.repo);
    assert.ok(outcome.project);
  } finally {
    await f.dispose();
  }
}, 180_000);

test("a spare's dependency time excludes waiting for another repository's refill", async () => {
  const f = await bunProject();
  try {
    // Another repository's refill holds the machine-wide lock for `held` ms while this spare is provisioned.
    const held = 3000;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => { release = resolve; });
    let acquired!: () => void;
    const holder = withWorkspaceTransaction("refill", async () => { acquired(); await holding; });
    await new Promise<void>((resolve) => { acquired = resolve; });
    const started = performance.now();
    const provisioning = provisionSpare(f.repo);
    setTimeout(release, held);
    const outcome = await provisioning;
    await holder;
    const total = performance.now() - started;
    assert.equal(outcome.provisioned, true);
    assert.ok(outcome.dependencyMs! <= total - held, `dependencyMs ${outcome.dependencyMs} counted the ${held} ms wait (total ${Math.round(total)} ms)`);
  } finally {
    await f.dispose();
  }
}, 180_000);

test("a spare with nothing to clone is logged as an install", async () => {
  const f = await bunProject();
  try {
    await rm(join(f.repo, "node_modules"), { recursive: true, force: true });
    const [line] = await refill(f.repo) as Array<Record<string, unknown>>;
    assert.equal(line!.provisioned, true);
    assert.equal(line!.dependencySource, "install");
    assert.ok((line!.dependencyMs as number) > 0);
    assert.equal("cloneMs" in line!, false);
    assert.equal(line!.integrationRoot, f.repo);
    assert.equal(typeof line!.project, "string");
  } finally {
    await f.dispose();
  }
}, 180_000);

test("a retiring checkout's handover is logged, and its spare is provisioned as a handover", async () => {
  const f = await bunProject();
  try {
    await withMachineSpares({ [f.repo]: 1 }, async () => {
      const created = await createWorkspace("task", f.repo);
      await removeWorkspace(f.repo, created.current.name);

      await vi.waitFor(async () => assert.ok((await logged()).some((entry) => entry.provisioned === true)), { timeout: 120_000, interval: 200 });
      const lines = await logged();
      const handover = lines.find((entry) => entry.handover === true);
      assert.ok(handover, "the move is logged");
      assert.equal(handover.from, created.current.name);
      assert.equal(handover.integrationRoot, f.repo);
      assert.equal(typeof handover.project, "string");
      assert.ok((handover.trees as number) >= 1);
      assert.equal(typeof handover.moveMs, "number");
      const provisioned = lines.find((entry) => entry.provisioned === true);
      assert.equal(provisioned!.dependencySource, "handover");
      assert.equal(provisioned!.workspacePath, handover.workspacePath, "both lines name the same spare");
      assert.equal(typeof provisioned!.dependencyMs, "number");
      assert.equal(provisioned!.project, handover.project);
    });
  } finally {
    await f.dispose();
  }
}, 180_000);
