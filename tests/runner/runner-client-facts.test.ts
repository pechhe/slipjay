import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { connectRunner } from "../../src/lib/runner/runner-client.ts";
import { createRunnerHandler } from "../../src/lib/runner/runner-api.ts";
import { serveRunner } from "../../src/lib/runner/runner-http.ts";
import { openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { metadataPath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "../../src/lib/infra/workspace-transaction.ts";
import { configureLocalGithubTransport, project } from "../support/workspace-project.ts";

type Pending = { id: string; operationId?: string; runnerBinding: string; fact: { kind: string; reason: string; observedAt: string } };

async function fixture() {
  const f = await project();
  const transport = await configureLocalGithubTransport(f);
  const workspace = await createWorkspace("transport fact fixture", f.repo);
  const name = workspace.context.current.name;
  const cwd = workspace.workspacePath;
  const log = openOperationLog(":memory:");
  const handler = createRunnerHandler({ log, token: "fake-token", runnerName: "fixture", readLog: async () => "", onSubmitted: () => {},
    kill: () => ({ status: "idle" }), subscribe: () => () => {} });
  let loseAcknowledgement = false;
  let beforeAcknowledgement: (() => Promise<void>) | undefined;
  const eventIds: string[] = [];
  const server = await serveRunner(async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith("/events")) {
      const body = await request.clone().json() as { id: string };
      eventIds.push(body.id);
      const response = await handler(request);
      await beforeAcknowledgement?.();
      if (loseAcknowledgement) { loseAcknowledgement = false; return new Response("lost response body"); }
      return response;
    }
    return handler(request);
  }, { host: "127.0.0.1", port: 0 });
  const bin = join(f.root, "bin");
  await mkdir(bin);
  const sshPath = join(bin, "ssh");
  // A local TCP forward exercises the actual spawn/SSH error path without invoking SSH.
  await writeFile(sshPath, `#!/usr/bin/env node
const net = require('node:net');
if (process.env.FIXTURE_SSH_FAIL === '1') {
  process.stderr.write('forward refused fake-token https://example.test/private ' + 'x'.repeat(400));
  process.exit(1);
}
const forwarding = process.argv[process.argv.indexOf('-L') + 1].split(':');
const sockets = new Set();
const server = net.createServer(socket => {
  const upstream = net.createConnection({ host: '127.0.0.1', port: Number(forwarding[2]) });
  sockets.add(socket); sockets.add(upstream);
  socket.on('error', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
  socket.pipe(upstream); upstream.pipe(socket);
});
server.listen(Number(forwarding[0]), '127.0.0.1');
process.on('SIGTERM', () => { for (const socket of sockets) socket.destroy(); server.close(); });
`);
  await chmod(sshPath, 0o700);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  const env = { ...process.env, SLIPJAY_RUNNER_TOKEN: "fake-token" };
  const location = `ssh://fixture@127.0.0.1:${server.port}`;
  const pending = async () => ((await workspaceMetadata(name))?.pendingRunnerFacts ?? []) as Pending[];
  const connect = async (runner = location) => {
    const connection = await connectRunner(runner, env, cwd);
    connection.close();
  };
  const fail = async () => {
    vi.stubEnv("FIXTURE_SSH_FAIL", "1");
    await assert.rejects(connect(), /SSH runner connection failed/);
    vi.stubEnv("FIXTURE_SSH_FAIL", "0");
  };
  return { ...f, cwd, name, log, server, env, location, connect, fail, pending, eventIds,
    loseAcknowledgement: () => { loseAcknowledgement = true; },
    beforeAcknowledgement: (callback: () => Promise<void>) => { beforeAcknowledgement = callback; },
    dispose: async () => {
      vi.unstubAllEnvs();
      try { await server.close(); log.close(); }
      finally { try { transport.restore(); } finally { await f.dispose(); } }
    } };
}

test("a failed forward survives in existing workspace metadata and delivers once to the same runner", async () => {
  const f = await fixture();
  try {
    const before = await workspaceMetadata(f.name);
    await f.fail();
    const [pending] = await f.pending();
    assert.ok(pending);
    assert.equal(pending.fact.kind, "ssh_forward_failure");
    assert.equal(new Date(pending.fact.observedAt).toISOString(), pending.fact.observedAt);
    assert.ok(pending.fact.reason.length <= 300);
    assert.ok(!pending.fact.reason.includes("fake-token"));
    assert.ok(!pending.fact.reason.includes("https://"));
    assert.deepEqual({ ...await workspaceMetadata(f.name), pendingRunnerFacts: undefined }, { ...before, pendingRunnerFacts: undefined });
    // A different address for the same local fixture must not consume the SSH runner's fact.
    await f.connect(f.server.url);
    assert.equal((await f.pending()).length, 1);
    assert.equal(f.log.events().length, 0);
    await f.connect();
    assert.deepEqual(await f.pending(), []);
    await f.connect();
    const facts = f.log.events().filter((event) => event.event.type === "client");
    assert.equal(facts.length, 1);
    assert.deepEqual(f.eventIds, [pending.id]);
    assert.deepEqual(facts[0]!.event, { type: "client", id: pending.id, fact: pending.fact });
    assert.equal(f.log.events().filter((event) => event.event.type === "client_operation").length, 1);
  } finally { await f.dispose(); }
}, 60_000);

test("a lost acknowledgement retains the operation and event IDs and replay deduplicates", async () => {
  const f = await fixture();
  try {
    await f.fail();
    const [original] = await f.pending();
    f.loseAcknowledgement();
    await f.connect();
    const [retained] = await f.pending();
    assert.equal(retained!.id, original!.id);
    assert.ok(retained!.operationId);
    assert.equal(f.log.events().filter((event) => event.event.type === "client").length, 1);
    await f.connect();
    assert.deepEqual(await f.pending(), []);
    assert.deepEqual(f.eventIds, [original!.id, original!.id]);
    assert.equal(f.log.events().filter((event) => event.event.type === "client").length, 1);
    assert.equal(f.log.events().filter((event) => event.event.type === "client_operation").length, 1);
  } finally { await f.dispose(); }
}, 60_000);

test("acknowledgement removes only its entry and preserves metadata and concurrently appended failures", async () => {
  const f = await fixture();
  try {
    await f.fail();
    const [original] = await f.pending();
    const next = { ...original!, id: "concurrent-failure", runnerBinding: "another-runner" };
    f.beforeAcknowledgement(async () => {
      await withWorkspaceTransaction(f.repo, async () => {
        const metadata = await workspaceMetadata(f.name);
        await writeWorkspaceJson(metadataPath(f.name), { ...metadata, task: "concurrent task update", pendingRunnerFacts: [...await f.pending(), next] });
      });
    });
    await f.connect();
    assert.deepEqual(await f.pending(), [next]);
    assert.equal((await workspaceMetadata(f.name))?.task, "concurrent task update");
    assert.equal(f.log.events().filter((event) => event.event.type === "client").length, 1);
  } finally { await f.dispose(); }
}, 60_000);
