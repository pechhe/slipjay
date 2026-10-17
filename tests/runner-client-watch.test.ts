import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vite-plus/test";
import type { WatchEnvelope } from "../src/lib/runner-watch.ts";

const mocks = vi.hoisted(() => ({ credential: vi.fn(), delay: vi.fn() }));
vi.mock("../src/lib/bounded-process.ts", () => ({ runBoundedProcess: mocks.credential }));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));

// A fresh module per test: the runner token read from Bitwarden is kept for the module's life.
let watchThroughRunner: typeof import("../src/lib/runner-client.ts").watchThroughRunner;
beforeEach(async () => {
  vi.resetModules();
  ({ watchThroughRunner } = await import("../src/lib/runner-client.ts"));
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

test("missing token stays in watch loop, waits thirty seconds and cancellation stops retries", async () => {
  const controller = new AbortController();
  const values: WatchEnvelope[] = [];
  mocks.credential.mockResolvedValue({ exitCode: 1, stdout: "private diagnostic" });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  mocks.delay.mockImplementation(async (ms, _value, options) => {
    assert.equal(ms, 30_000);
    assert.equal(options.signal, controller.signal);
    controller.abort();
    throw new Error("aborted");
  });
  await watchThroughRunner("http://runner", value => values.push(value), controller.signal, {});
  assert.equal(mocks.credential.mock.calls.length, 1);
  assert.equal(fetch.mock.calls.length, 0);
  assert.deepEqual(values, ["connecting", "disconnected"].map(state => ({ version: 1, type: "connection", state, cursor: 0 })));
});

test("credential recovery caches successful token across transport retries", async () => {
  const controller = new AbortController();
  const values: WatchEnvelope[] = [];
  const waits: number[] = [];
  mocks.credential.mockResolvedValueOnce({ exitCode: 1, stdout: "" })
    .mockResolvedValue({ exitCode: 0, stdout: JSON.stringify([{ key: "SLIPJAY_RUNNER_TOKEN", value: "test-only" }]) });
  let health = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => {
    assert.equal((options.headers as Record<string, string>).authorization, "Bearer test-only");
    if (url.endsWith("/health")) {
      if (++health === 1) throw new Error("private transport detail");
      return Response.json({ runner: "fixture" });
    }
    if (url.endsWith("/queue")) return Response.json({ version: 1, seq: 9 });
    assert.ok(url.endsWith("/metrics/events?since=9"));
    return new Response(new ReadableStream<Uint8Array>({ start(c) { c.close(); } }));
  }));
  mocks.delay.mockImplementation(async (ms) => { waits.push(ms); });
  await watchThroughRunner("http://runner", value => {
    values.push(value);
    if (value.type === "connection" && value.state === "connected") controller.abort();
  }, controller.signal, {});
  assert.deepEqual(waits, [30_000, 2000]);
  assert.equal(mocks.credential.mock.calls.length, 2, "successful credential reused after failed health check");
  assert.deepEqual(values.filter(value => value.type === "connection").map(value => value.state),
    ["connecting", "disconnected", "connecting", "disconnected", "connecting", "connected"]);
});

test("cancellation during credential lookup never opens a transport", async () => {
  const controller = new AbortController();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  mocks.credential.mockImplementation(async () => {
    controller.abort();
    return { exitCode: 0, stdout: JSON.stringify([{ key: "SLIPJAY_RUNNER_TOKEN", value: "test-only" }]) };
  });
  await watchThroughRunner("http://runner", () => {}, controller.signal, {});
  assert.equal(fetch.mock.calls.length, 0);
  assert.equal(mocks.delay.mock.calls.length, 0);
});
