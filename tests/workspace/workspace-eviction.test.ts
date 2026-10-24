import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { dependencyTrees, evictionDecision, EVICTION_IDLE_MS } from "../../src/lib/workspace/workspace-eviction.ts";
import type { ProcessWorkingDirectory } from "../../src/lib/workspace/workspace-holders.ts";

const HOUR = 60 * 60_000;
const now = Date.parse("2026-10-23T12:00:00Z");
const base = {
  integration: false,
  exists: true,
  holders: [] as ProcessWorkingDirectory[],
  dependencyPaths: ["node_modules"],
  lastActivityAt: now - 30 * HOUR,
  now,
};

test("an idle, unheld checkout sheds its dependency trees", () => {
  const decision = evictionDecision(base);
  assert.equal(decision.evict, true);
  assert.match(decision.reason, /idle 30h/);
});

test("a checkout used within the idle window keeps them, and says how long ago", () => {
  const decision = evictionDecision({ ...base, lastActivityAt: now - 2 * HOUR });
  assert.equal(decision.evict, false);
  assert.match(decision.reason, /2h ago/);
});

test("the integration checkout is never evicted", () => {
  assert.equal(evictionDecision({ ...base, integration: true }).evict, false);
});

test("a live process keeps the checkout, naming who holds it", () => {
  const decision = evictionDecision({ ...base, holders: [{ pid: 42, command: "bun test", cwd: "/tmp/x" }] });
  assert.equal(decision.evict, false);
  assert.match(decision.reason, /pid 42 \(bun test\)/);
});

test("unreadable process boundaries keep the material rather than guess", () => {
  assert.equal(evictionDecision({ ...base, holders: null }).evict, false);
});

test("a checkout with nothing installed is left alone", () => {
  const decision = evictionDecision({ ...base, dependencyPaths: [] });
  assert.equal(decision.evict, false);
  assert.equal(decision.reason, "no dependency trees installed");
});

test("an unknown activity time starts the clock instead of reading as idle for ever", () => {
  const decision = evictionDecision({ ...base, lastActivityAt: null });
  assert.equal(decision.evict, false);
  assert.match(decision.reason, /clock starts now/);
});

test("the default idle window is a day", () => {
  assert.equal(EVICTION_IDLE_MS, 24 * HOUR);
  assert.equal(evictionDecision({ ...base, lastActivityAt: now - 25 * HOUR }).evict, true);
  assert.equal(evictionDecision({ ...base, lastActivityAt: now - 23 * HOUR }).evict, false);
});

test("dependency trees are the node_modules beside each tracked manifest and at the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "slipjay-evict-"));
  try {
    await mkdir(join(root, "apps", "web"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "apps", "web", "package.json"), "{}");
    await mkdir(join(root, "node_modules", "x"), { recursive: true });
    await mkdir(join(root, "apps", "web", "node_modules", "y"), { recursive: true });
    await mkdir(join(root, "packages", "unused", "node_modules"), { recursive: true });
    const trees = await dependencyTrees(root, ["package.json", join("apps", "web", "package.json")]);
    assert.deepEqual(trees, [join("apps", "web", "node_modules"), "node_modules"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
