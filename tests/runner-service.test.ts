import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { startRunner } from "../src/lib/runner-service.ts";

test("the runner refuses to start without the commit identity its config must name", async () => {
  const home = await mkdtemp(join(tmpdir(), "slipjay-runner-"));
  try {
    await writeFile(join(home, "config.json"), JSON.stringify({ repos: {}, jj: { "user.name": "Runner Identity" } }));
    await assert.rejects(startRunner({ home, env: { SLIPJAY_RUNNER_TOKEN: "token" }, port: 0 }), /sets no user\.email under "jj"/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
