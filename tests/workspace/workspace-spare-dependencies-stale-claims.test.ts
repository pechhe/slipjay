import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import * as transactions from "../../src/lib/infra/workspace-transaction.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { withWorkspaceTransaction } from "../../src/lib/infra/workspace-transaction.ts";
import { write, advance, bunProject, refill } from "./fixtures/workspace-spare-dependencies-fixture.ts";

vi.mock("../../src/lib/infra/workspace-transaction.ts", { spy: true });

test("concurrent claims of stale spares install in place, one at a time", async () => {
  const f = await bunProject({ spares: 2 });
  const spans = join(f.root, "spans.jsonl");
  try {
    await refill(f.repo);
    await write(f.repo, { "packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0", engines: { node: ">=18" } }) });
    advance(f.repo, "Change an install input");
    await rm(join(f.repo, "node_modules"), { recursive: true, force: true });
    process.env.FIXTURE_INSTALL_SPANS = spans;
    process.env.FIXTURE_INSTALL_DELAY_MS = "2000";
    const claims = await Promise.all([createWorkspace("first", f.repo), createWorkspace("second", f.repo)]);
    assert.deepEqual(claims.map((claim) => claim.pooled), [true, true]);
    assert.deepEqual(claims.map((claim) => Boolean((claim.readiness as { seeded?: boolean }).seeded)), [false, false],
      "each claim installed over its spare's own node_modules");
    const installs = (await readFile(spans, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as [number, number]).sort((x, y) => x[0] - y[0]);
    assert.equal(installs.length, 2);
    assert.ok(installs[1]![0] >= installs[0]![1], `the installs did not overlap: ${JSON.stringify(installs)}`);
  } finally {
    delete process.env.FIXTURE_INSTALL_SPANS;
    delete process.env.FIXTURE_INSTALL_DELAY_MS;
    await f.dispose();
  }
}, 300_000);
