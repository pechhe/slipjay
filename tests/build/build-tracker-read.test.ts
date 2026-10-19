import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { readBuildThroughRunner } from "../../src/lib/runner/runner-client.ts";
import type { BuildItem } from "../../src/lib/build/tracker.ts";
import { project } from "../support/workspace-project.ts";
import { withTestRunner } from "../support/test-runner.ts";
import { item, buildServer } from "./fixtures/build-tracker-fixture.ts";

test("a client reads Build only through the runner, and only Build's read actions", async () => {
  const f = await project();
  const buildToken = "build-secret";
  const fake = await buildServer(buildToken, [item({ number: 77, title: "From Build" })]);
  try {
    await withTestRunner(f, async ({ location, env }) => {
      assert.equal(((await readBuildThroughRunner("read", { number: 77 }, env)) as BuildItem).title, "From Build");
      await assert.rejects(readBuildThroughRunner("read", { number: 78 }, env), /Build refused read: build_item_unavailable/);
      const refuse = await fetch(`${location}/v1/build/read`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ action: "setStatus", input: {} }) });
      assert.equal(refuse.status, 400);
      assert.deepEqual(fake.requests.map((request) => request.action), ["read", "read"], "a write action never reaches Build");
    }, { build: { origin: fake.origin, token: buildToken } });
    // A runner without a Build connection refuses the read rather than answering for Build.
    await withTestRunner(f, async ({ env }) => {
      await assert.rejects(readBuildThroughRunner("read", { number: 77 }, env), /no Build connection/);
    });
  } finally {
    await fake.close();
    await f.dispose();
  }
}, 120_000);
