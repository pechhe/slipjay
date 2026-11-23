import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vite-plus/test";
import { serveRunner } from "../../src/lib/runner/runner-http.ts";

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));
const exec = promisify(execFile);

test("runner prioritize sends parsed options, supports JSON and refuses invalid flags without a request", async () => {
  const requests: { pathname: string; method: string; authorization: string | null; body: unknown }[] = [];
  const server = await serveRunner(async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/v1/health") return Response.json({ runner: "fixture" });
    requests.push({ pathname, method: request.method, authorization: request.headers.get("authorization"), body: await request.json() });
    return pathname.includes("/missing/")
      ? Response.json({ error: "Unknown operation" }, { status: 404 })
      : Response.json({ operation: { id: "urgent", kind: "landing", prioritized: { seq: 1, whilePaused: true } } });
  }, { host: "127.0.0.1", port: 0 });
  const run = (...args: string[]) => exec("bun", [cli, "runner", "prioritize", ...args], {
    cwd: homedir(), env: { ...process.env, SLIPJAY_RUNNER: server.url, SLIPJAY_RUNNER_TOKEN: "fixture-token" }, timeout: 15_000,
  });
  try {
    const { stdout } = await run("urgent", "--reason", "fix broken main", "--json", "--while-paused");
    assert.equal(JSON.parse(stdout).operation.id, "urgent");
    assert.deepEqual(requests, [{
      pathname: "/v1/operations/urgent/prioritize", method: "POST", authorization: "Bearer fixture-token",
      body: { whilePaused: true, reason: "fix broken main" },
    }]);
    for (const args of [[], ["--json"], ["urgent", "--unknown"], ["urgent", "--reason"], ["urgent", "extra"]]) {
      await assert.rejects(run(...args), { code: 1 });
    }
    assert.equal(requests.length, 1);
    await assert.rejects(run("missing", "--json"), { code: 1, stdout: '{\n  "error": "Unknown operation"\n}\n' });
    assert.match((await run("urgent")).stdout, /Prioritized landing urgent/);
  } finally { await server.close(); }
}, 30_000);
