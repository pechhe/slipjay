import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { provisionSpare, readySpares } from "../../src/lib/workspace/workspace-pool.ts";
import { startSpareRefill } from "../../src/lib/workspace/workspace-spares.ts";
import { workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { withWorkspaceTransaction } from "../../src/lib/infra/workspace-transaction.ts";
import { bunProject, spareName, refill } from "./fixtures/workspace-spare-dependencies-fixture.ts";

test("a claim that cannot take the pool in time installs a fresh workspace instead of waiting", async () => {
  const f = await bunProject();
  try {
    await provisionSpare(f.repo);
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let holding = () => {};
    const acquired = new Promise<void>((resolve) => { holding = resolve; });
    const provisioning = withWorkspaceTransaction(`pool:${f.repo}`, async () => { holding(); await held; });
    await acquired;
    try {
      const created = await createWorkspace("task", f.repo);
      assert.equal(created.pooled, false);
      assert.equal(await f.count(), 2, "the fresh workspace installed");
      assert.equal((await readySpares(f.repo)).length, 1, "the spare was left alone");
    } finally {
      release();
      await provisioning;
    }
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a spare refill runs detached and niced without blocking its caller", async () => {
  const f = await bunProject();
  process.env.FIXTURE_INSTALL_DELAY_MS = "8000";
  try {
    const startedAt = Date.now();
    const result = await startSpareRefill(f.repo);
    assert.ok(Date.now() - startedAt < 8_000, "returns before the provisioning install could finish");
    assert.equal(result.started, true);
    assert.equal(await readySpares(f.repo).then((spares) => spares.length), 0, "the spare is still being prepared");
    const [pgid, nice] = execFileSync("ps", ["-o", "pgid=,nice=", "-p", String(result.pid)], { encoding: "utf8" }).trim().split(/\s+/);
    assert.equal(Number(pgid), result.pid, "the child leads its own process group");
    assert.equal(Number(nice), 10);

    const deadline = Date.now() + 90_000;
    while ((await readySpares(f.repo)).length === 0) {
      assert.ok(Date.now() < deadline, "the refill prepared a spare");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const until = Date.now() + 10_000;
    let log = "";
    while (!/"provisioned":true/.test(log)) {
      assert.ok(Date.now() < until, `the refill logged its outcome: ${log}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      log = await readFile(result.logPath!, "utf8").catch(() => "");
    }
    assert.equal(await f.count(), 1);
    const metadata = await workspaceMetadata(await spareName(f.repo));
    const prepared = metadata?.preparedDependencies as { installInputs?: string } | undefined;
    assert.match(String(prepared?.installInputs), /^sha256:/);
  } finally {
    delete process.env.FIXTURE_INSTALL_DELAY_MS;
    await f.dispose();
  }
}, 120_000);
