import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { runnerBuildNotice } from "../../src/lib/runner/runner-client.ts";
import { serveRunner } from "../../src/lib/runner/runner-http.ts";

const client = "105ff5bd62f713308331701e2fc5e78f922497bc";
const runner = "389fc114e3a0e2b6a0e5acf2a1c4e5b2d1b7f0a3";

/** A runner answering health with `body`, counting what it was asked, as `runnerBuildNotice` reaches it. */
async function runnerSaying(body: Record<string, unknown>) {
  const paths: string[] = [];
  const server = await serveRunner(async (request) => {
    paths.push(new URL(request.url).pathname);
    assert.equal(request.headers.get("authorization"), "Bearer fixture-token");
    return Response.json(body);
  }, { host: "127.0.0.1", port: 0 });
  return { url: server.url, paths, close: () => server.close() };
}

const env = { ...process.env, SLIPJAY_RUNNER_TOKEN: "fixture-token" };

test("a runner on another build is named with both commits", async () => {
  const server = await runnerSaying({ ok: true, runner: "peach-live", revision: runner });
  try {
    assert.deepEqual(await runnerBuildNotice(server.url, client, env), { name: "peach-live", revision: runner });
    assert.deepEqual(server.paths, ["/v1/health"], "one health answer settles it");
  } finally { await server.close(); }
});

test("nothing is said when the runner runs the client's build, cannot name one, or cannot be reached", async () => {
  const same = await runnerSaying({ ok: true, runner: "peach-live", revision: client });
  try {
    assert.equal(await runnerBuildNotice(same.url, client, env), null);
  } finally { await same.close(); }
  const older = await runnerSaying({ ok: true, runner: "peach-live" });
  try {
    assert.equal(await runnerBuildNotice(older.url, client, env), null, "a runner older than the field says nothing");
  } finally { await older.close(); }
  assert.equal(await runnerBuildNotice("http://127.0.0.1:1", client, env), null, "an unreachable runner says nothing");
  assert.equal(await runnerBuildNotice(null, client, env), null, "a machine with no runner asks nothing");
  assert.equal(await runnerBuildNotice(same.url, null, env), null, "a client that cannot name its own build asks nothing");
});
