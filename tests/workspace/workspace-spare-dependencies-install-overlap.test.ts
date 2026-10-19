import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { provisionSpare } from "../../src/lib/workspace/workspace-pool.ts";
import { write, advance, bunProject, refill } from "./fixtures/workspace-spare-dependencies-fixture.ts";

test("refills of two repositories install one after the other, and a claim never waits for them", async () => {
  const a = await bunProject({ spares: 2 });
  const b = await bunProject({ spares: 1 });
  const spans = join(a.root, "spans.jsonl");
  const started = join(a.root, "started.log");
  const hold = join(a.root, "release-installs");
  let release: NodeJS.Timeout | undefined;
  let refills: Promise<unknown>[] = [];
  try {
    await provisionSpare(a.repo);
    process.env.FIXTURE_INSTALL_SPANS = spans;
    process.env.FIXTURE_INSTALL_STARTED = started;
    process.env.FIXTURE_INSTALL_HOLD = hold;
    refills = [refill(a.repo), refill(b.repo)];
    const both = Promise.all(refills);
    const finishedFirst = both.then(() => assert.fail("both refills finished before an install started"));
    finishedFirst.catch(() => undefined);
    // Claim while a refill's install is held open: a claim that waited for it could only return once it is released.
    // A refill that fails before its install starts fails the test here instead of leaving it polling.
    while (!(await readFile(started, "utf8").catch(() => ""))) await Promise.race([finishedFirst, new Promise((done) => setTimeout(done, 25))]);
    // Should the claim wait after all, release the install so the test fails below instead of hanging.
    release = setTimeout(() => void writeFile(hold, ""), 60_000);
    const created = await createWorkspace("task", a.repo);
    assert.equal(created.pooled, true, "the claim took the ready spare");
    assert.equal(await readFile(spans, "utf8").catch(() => ""), "", "the claim returned while the refill's install was still running");
    await writeFile(hold, "");
    await both;
    const installs = (await readFile(spans, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as [number, number]).sort((x, y) => x[0] - y[0]);
    assert.ok(installs.length >= 2, `both repositories installed: ${installs.length}`);
    for (let index = 1; index < installs.length; index += 1) {
      assert.ok(installs[index]![0] >= installs[index - 1]![1], `installs did not overlap: ${JSON.stringify(installs)}`);
    }
  } finally {
    clearTimeout(release);
    await writeFile(hold, "");
    await Promise.allSettled(refills);
    delete process.env.FIXTURE_INSTALL_SPANS;
    delete process.env.FIXTURE_INSTALL_STARTED;
    delete process.env.FIXTURE_INSTALL_HOLD;
    await a.dispose();
    await b.dispose();
  }
}, 300_000);

test("a claim that must install never waits for a refill's install", async () => {
  const f = await bunProject({ spares: 2 });
  const spans = join(f.root, "spans.jsonl");
  const started = join(f.root, "started.log");
  try {
    await refill(f.repo);
    await write(f.repo, { "packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0", engines: { node: ">=18" } }) });
    advance(f.repo, "Change an install input");
    await rm(join(f.repo, "node_modules"), { recursive: true, force: true });
    process.env.FIXTURE_INSTALL_SPANS = spans;
    process.env.FIXTURE_INSTALL_STARTED = started;
    process.env.FIXTURE_INSTALL_DELAY_MS = "4000";
    // The refill refreshes one stale spare at a time; claim the other once its install is under way.
    const refilling = refill(f.repo);
    while (!(await readFile(started, "utf8").catch(() => ""))) await new Promise((done) => setTimeout(done, 25));
    const created = await createWorkspace("task", f.repo);
    assert.equal(created.pooled, true, "the claim took the spare the refill had not reserved");
    await refilling;
    const installs = (await readFile(spans, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as [number, number]).sort((x, y) => x[0] - y[0]);
    assert.ok(installs.length >= 2, `the refill and the claim both installed: ${JSON.stringify(installs)}`);
    assert.ok(installs[1]![0] < installs[0]![1], `the claim's install ran beside the refill's: ${JSON.stringify(installs)}`);
  } finally {
    delete process.env.FIXTURE_INSTALL_SPANS;
    delete process.env.FIXTURE_INSTALL_STARTED;
    delete process.env.FIXTURE_INSTALL_DELAY_MS;
    await f.dispose();
  }
}, 300_000);
