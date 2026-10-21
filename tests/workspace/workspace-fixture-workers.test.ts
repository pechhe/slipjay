import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vite-plus/test";
import { project } from "../support/workspace-project.ts";
import { drainFixtureWorkers } from "../support/fixture-workers.ts";
import { withTestRunner } from "../support/test-runner.ts";
import { spawnDetached } from "../../src/lib/workspace/workspace-background.ts";
import { slipjayHome, transactionHome } from "../../src/lib/workspace/workspace-paths.ts";
import { withWorkspaceTransaction, workspaceTransactionLocks } from "../../src/lib/infra/workspace-transaction.ts";

test("fixture disposal joins workers whose cwd and command omit the repo, including nested workers", async () => {
  const f = await project({ policy: { spares: 0 } });
  const ready = join(slipjayHome(), "ready");
  const completed = join(slipjayHome(), "completed");
  const nested = join(slipjayHome(), "nested");
  const transaction = pathToFileURL(join(process.cwd(), "src/lib/infra/workspace-transaction.ts")).href;
  const background = pathToFileURL(join(process.cwd(), "src/lib/workspace/workspace-background.ts")).href;
  await mkdir(slipjayHome(), { recursive: true });
  // The script is outside the repo path pgrep used to match. Both workers run
  // under SlipJay's home, just like detached trash deletion.
  const script = join(slipjayHome(), "worker.mjs");
  await writeFile(script, `
    import { writeFile } from 'node:fs/promises';
    import { withWorkspaceTransaction } from ${JSON.stringify(transaction)};
    import { spawnDetached } from ${JSON.stringify(background)};
    await withWorkspaceTransaction('fixture-leak', async () => {
      await writeFile(${JSON.stringify(ready)}, 'ready');
      await new Promise(resolve => setTimeout(resolve, 200));
      await spawnDetached([process.execPath, '-e', ${JSON.stringify(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(nested)}, 'nested'), 200)`)}], ${JSON.stringify(slipjayHome())});
      await writeFile(${JSON.stringify(completed)}, 'completed');
    });
  `);
  try {
    const worker = await spawnDetached([process.execPath, script], slipjayHome());
    assert.equal(worker.started, true);
    await vi.waitFor(() => assert.equal(existsSync(ready), true), { timeout: 10_000 });
    await f.dispose();
    assert.equal(await readFile(completed, "utf8"), "completed");
    assert.equal(await readFile(nested, "utf8"), "nested");
    assert.deepEqual(await workspaceTransactionLocks(), []);
    assert.deepEqual(await readdir(process.env.SLIPJAY_BACKGROUND_WORKERS!), []);
  } finally { await drainFixtureWorkers(); }
});

test("opt-in transaction diagnostics identify the owner and a waiter after ten seconds", async () => {
  const previous = process.env.SLIPJAY_TRANSACTION_DIAGNOSTICS;
  process.env.SLIPJAY_TRANSACTION_DIAGNOSTICS = "1";
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  let reported!: (message: string) => void;
  let deadline: ReturnType<typeof setTimeout>;
  const diagnostic = new Promise<string>((resolve, reject) => {
    reported = resolve;
    deadline = setTimeout(() => reject(new Error("Transaction wait diagnostic was not emitted")), 15_000);
  });
  const logging = vi.spyOn(console, "error").mockImplementation((message) => { if (String(message).includes("waiting 10s")) reported(String(message)); });
  const owner = withWorkspaceTransaction("diagnostic-owner", async () => { entered(); await held; });
  let waiter: Promise<unknown> | undefined;
  try {
    await acquired;
    const locks = await workspaceTransactionLocks();
    assert.equal(locks[0]!.owner!.pid, process.pid);
    assert.equal(locks[0]!.owner!.key, "diagnostic-owner");
    assert.ok(locks[0]!.owner!.command);
    waiter = withWorkspaceTransaction("diagnostic-owner", async () => "acquired", { waitMs: 20_000 });
    const message = await diagnostic;
    assert.match(message, /waiting 10s.*diagnostic-owner/);
    assert.ok(message.includes(`"pid":${process.pid}`));
    assert.ok(message.includes("command"));
  } finally {
    clearTimeout(deadline!);
    release();
    await owner;
    await waiter;
    logging.mockRestore();
    if (previous === undefined) delete process.env.SLIPJAY_TRANSACTION_DIAGNOSTICS;
    else process.env.SLIPJAY_TRANSACTION_DIAGNOSTICS = previous;
  }
  assert.deepEqual(await workspaceTransactionLocks(), []);
  assert.deepEqual(await readdir(transactionHome()), []);
});

test("runner fixture joins detached API users before closing its service", async () => {
  const f = await project({ policy: { spares: 0 } });
  const result = join(f.root, "worker-response");
  const script = join(f.root, "late-api-user.mjs");
  try {
    await withTestRunner(f, async ({ location, env }) => {
      await writeFile(script, `
        import { writeFile } from 'node:fs/promises';
        await new Promise(resolve => setTimeout(resolve, 200));
        try {
          const response = await fetch(${JSON.stringify(location + "/v1/health")}, { headers: { authorization: ${JSON.stringify(`Bearer ${env.SLIPJAY_RUNNER_TOKEN}`)} } });
          await response.arrayBuffer();
          await writeFile(${JSON.stringify(result)}, String(response.status));
        } catch (error) { await writeFile(${JSON.stringify(result)}, String(error)); }
      `);
      assert.equal((await spawnDetached([process.execPath, script], f.repo)).started, true);
      // The callback returns before the worker uses the API.
    });
    assert.equal(await readFile(result, "utf8"), "200");
    assert.deepEqual(await readdir(process.env.SLIPJAY_BACKGROUND_WORKERS!), [], "runner fixture joined its worker before returning");
  } finally { await f.dispose(); }
});
