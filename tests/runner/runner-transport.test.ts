import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { connectRunner, request, RunnerRequestRefused } from "../../src/lib/runner/runner-transport.ts";

const env = { SLIPJAY_RUNNER_TOKEN: "disposable-token" };

async function service() {
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${env.SLIPJAY_RUNNER_TOKEN}`) { res.writeHead(401).end(); return; }
    const route = req.url ?? "";
    if (route === "/stall") return;
    res.setHeader("content-type", "application/json");
    const status = Number(route.slice(1));
    if (status) { res.writeHead(status).end(JSON.stringify({ error: "fixture refusal", operation: { id: "retained" } })); return; }
    res.end(JSON.stringify({ runner: "disposable" }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert(address && typeof address !== "string");
  return { port: address.port, url: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}

test("authenticated HTTP, refusals, cancellation and connection errors need no workspace", async () => {
  const server = await service();
  try {
    let flushed = false;
    const connection = await connectRunner(server.url, env, { connected: async (opened, token) => {
      assert.equal(opened.name, "disposable");
      assert.equal(token, env.SLIPJAY_RUNNER_TOKEN);
      await request(opened.baseUrl, token, "/data");
      flushed = true;
    } });
    assert.equal(flushed, true);
    assert.equal(connection.name, "disposable");
    assert.equal((await request(connection.baseUrl, env.SLIPJAY_RUNNER_TOKEN, "/409")).status, 409);
    for (const status of [400, 401, 422, 503]) {
      await assert.rejects(request(connection.baseUrl, status === 401 ? "wrong-token" : env.SLIPJAY_RUNNER_TOKEN, `/${status}`), (error: unknown) => {
        assert(error instanceof RunnerRequestRefused);
        assert.equal(error.status, status);
        assert.equal(error.operation?.id, status === 503 ? "retained" : undefined);
        assert.match(error.message, status === 401 ? /credential/ : /fixture refusal/);
        return true;
      });
    }
    await assert.rejects(request(connection.baseUrl, env.SLIPJAY_RUNNER_TOKEN, "/500"), /Runner request failed: HTTP 500/);
    const controller = new AbortController();
    const pending = request(connection.baseUrl, env.SLIPJAY_RUNNER_TOKEN, "/stall", { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    connection.close();
    connection.close();
    await assert.rejects(connectRunner(server.url, { SLIPJAY_RUNNER_TOKEN: "wrong-token" }), /credential/);
    await assert.rejects(connectRunner("file:///runner", env), /Runner location must use/);
  } finally { await server.close(); }
  await assert.rejects(connectRunner(server.url, env), /fetch failed/);
});

async function forwarding() {
  const root = await mkdtemp(join(tmpdir(), "slipjay-transport-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const stopped = join(root, "stopped");
  const ssh = join(bin, "ssh");
  await writeFile(ssh, `#!${process.execPath}
const net = require('node:net');
const fs = require('node:fs');
if (process.env.TRANSPORT_FAIL === '1') { process.stderr.write('fixture forward failed'); process.exit(1); }
const ports = process.argv[process.argv.indexOf('-L') + 1].split(':');
const sockets = new Set();
const server = net.createServer(socket => {
  const upstream = net.createConnection({ host: '127.0.0.1', port: Number(ports[2]) });
  sockets.add(socket); sockets.add(upstream);
  socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
  socket.pipe(upstream); upstream.pipe(socket);
});
server.listen(Number(ports[0]), '127.0.0.1');
process.on('SIGTERM', () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => { fs.writeFileSync(${JSON.stringify(stopped)}, 'closed'); });
});
`);
  await chmod(ssh, 0o700);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  return { stopped, dispose: async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); } };
}

test("SSH forwards close after healthy connections and health refusals; failed setup reports the original error", async () => {
  const server = await service();
  const fake = await forwarding();
  const location = `ssh://fixture@127.0.0.1:${server.port}`;
  try {
    const connection = await connectRunner(location, env);
    assert.equal(connection.name, "disposable");
    connection.close();
    await vi.waitFor(async () => assert.equal(await readFile(fake.stopped, "utf8"), "closed"));
    await rm(fake.stopped);
    await assert.rejects(connectRunner(location, { SLIPJAY_RUNNER_TOKEN: "wrong-token" }), /credential/);
    await vi.waitFor(async () => assert.equal(await readFile(fake.stopped, "utf8"), "closed"));
    vi.stubEnv("TRANSPORT_FAIL", "1");
    let reported: unknown;
    await assert.rejects(connectRunner(location, env, { forwardFailure: async (error) => { reported = error; } }), (error: unknown) => {
      assert.equal(error, reported);
      assert.match(String(error), /SSH runner connection failed: fixture forward failed/);
      return true;
    });
  } finally { await server.close(); await fake.dispose(); }
});
