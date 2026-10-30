import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";
import { startRunner } from "../../src/lib/runner/runner-service.ts";
import { createPipelineRelay, localPipelineReader, PIPELINE_RELAY_INTERVAL_MS } from "../../src/lib/build/build-pipeline-relay.ts";
import type { PipelinePage } from "../../src/lib/build/build-pipeline-relay.ts";

type ReleaseState = Pick<import("../../src/lib/runner/runner-types.ts").QueueSnapshot, "observedAt" | "repositories">;
type Sent = { since: number; events: { seq: number }[]; nextSeq: number; hasMore: boolean } & Partial<ReleaseState>;
const releaseState = (observedAt = "2026-10-30T13:00:00.000Z"): ReleaseState => ({ observedAt, repositories: [{
  repo: "fixture/repo", screeningLanes: 3, today: { landed: 2, failedScreens: 1 },
  release: { integrationBranch: "develop", candidate: { commitId: "candidate", landedAt: observedAt }, stagingSkipped: true, staging: null,
    production: { live: null, latestAttempt: null }, images: null, audit: null,
    waitingOn: { kind: "audit", detail: "The latest audit failed and no cause is recorded." } },
}] });
const events = (count: number, size = 0) => Array.from({ length: count }, (_, index) => ({ seq: index + 1, pad: "x".repeat(size) }));

/** The runner's export over `all`, as `GET /v1/metrics/events` pages it. */
const exportOf = (all: { seq: number }[]) => async (since: number, limit: number): Promise<PipelinePage> => {
  const rest = all.filter((event) => event.seq > since);
  const page = rest.slice(0, limit);
  return { events: page, nextSeq: page.at(-1)?.seq ?? since, hasMore: rest.length > limit };
};

/** A controlled HQ: the cursor authority, answering as the real route does, with every body it received. */
function fakeHq(start = 0, override?: (body: Sent, call: number) => Response | undefined) {
  const state = { cursor: start, bodies: [] as Sent[], headers: [] as Headers[] };
  const fetch = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Sent;
    state.bodies.push(body); state.headers.push(new Headers(init.headers));
    const forced = override?.(body, state.bodies.length);
    if (forced) return forced;
    if (body.since !== state.cursor) return Response.json({ cursor: state.cursor }, { status: 409 });
    state.cursor = Math.max(state.cursor, body.nextSeq);
    return Response.json({ status: "caught_up", cursor: state.cursor });
  };
  return { state, fetch };
}
const waitFor = async (condition: () => boolean) => { while (!condition()) await new Promise((resolve) => setTimeout(resolve, 1)); };
const relay = (hq: { fetch: (url: string, init: RequestInit) => Promise<Response> }, readPage: ReturnType<typeof exportOf>, extra: Partial<Parameters<typeof createPipelineRelay>[0]> = {}) => {
  const logged: string[] = [];
  const instance = createPipelineRelay({ origin: "https://hq.example", token: "build-token", readPage: (since, limit) => readPage(since, limit), fetch: hq.fetch, log: (m) => logged.push(m), ...extra });
  const once = async () => { instance.start(); await instance.idle(); instance.close(); };
  return { logged, once, instance };
};

test("a pass learns HQ's cursor, rewinds to it on 409 and sends the rest in bounded pages", async () => {
  const hq = fakeHq(250);
  const { once, logged } = relay(hq, exportOf(events(1200)));
  await once();
  assert.equal(hq.state.cursor, 1200);
  assert.deepEqual(hq.state.bodies.map((body) => [body.since, body.events.length]), [[0, 0], [250, 950]]);
  assert.deepEqual(logged, []);
  for (const headers of hq.state.headers) assert.equal(headers.get("authorization"), "Bearer build-token");
});

test("replaying a stored page is idempotent: HQ's cursor stands and the relay stores nothing twice", async () => {
  const hq = fakeHq(0);
  const all = events(10);
  const first = relay(hq, exportOf(all)); await first.once();
  const second = relay(hq, exportOf(all)); await second.once();
  assert.equal(hq.state.cursor, 10);
  const stored = hq.state.bodies.filter((body) => body.events.length > 0);
  assert.equal(stored.length, 1);
});

test("a cursor that moves during a pass is followed, not fought", async () => {
  const hq = fakeHq(0, (_body, call) => { if (call !== 2) return undefined; hq.state.cursor = 3; return Response.json({ cursor: 3 }, { status: 409 }); });
  const { once } = relay(hq, exportOf(events(8)));
  await once();
  assert.equal(hq.state.cursor, 8);
});

test("a body over the byte cap is read again with a lower limit until it fits", async () => {
  const hq = fakeHq(0);
  const { once, logged } = relay(hq, exportOf(events(40, 1000)), { maxBodyBytes: 12_000 });
  await once();
  assert.equal(hq.state.cursor, 40);
  assert.ok(hq.state.bodies.every((body) => JSON.stringify(body).length <= 12_000));
  assert.ok(hq.state.bodies.filter((body) => body.events.length).length > 1);
  assert.deepEqual(logged, []);
});

test("an event larger than the cap is logged and sent nowhere", async () => {
  const hq = fakeHq(0);
  const { once, logged } = relay(hq, exportOf(events(1, 5000)), { maxBodyBytes: 2000 });
  await once();
  assert.equal(hq.state.cursor, 0);
  assert.match(logged.join("\n"), /larger than 2000 bytes/);
});

test("HQ's refusals and outages are logged and swallowed", async () => {
  for (const status of [422, 503, 401]) {
    const hq = fakeHq(0, () => Response.json({}, { status }));
    const { once, logged } = relay(hq, exportOf(events(3)));
    await once();
    assert.deepEqual(logged, [`HQ answered HTTP ${status}`]);
  }
});

test("an HQ that never answers is aborted at the timeout", async () => {
  const fetch = (_url: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
  const { once, logged } = relay({ fetch }, exportOf(events(3)), { timeoutMs: 20 });
  await once();
  assert.deepEqual(logged, ["HQ did not answer in time"]);
});

test("a local read that never answers is aborted at the timeout and logged", async () => {
  const hq = fakeHq(0);
  const hung = (_since: number, _limit: number, signal?: AbortSignal) => new Promise<PipelinePage>((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason)));
  const instance = createPipelineRelay({ origin: "https://hq.example", token: "t", readPage: hung, fetch: hq.fetch, timeoutMs: 20, log: (m) => logged.push(m) });
  const logged: string[] = [];
  instance.start(); await instance.idle(); instance.close();
  assert.equal(logged.length, 1);
});

test("the relay never throws into its caller and does not overlap passes", async () => {
  let reads = 0;
  const release: (() => void)[] = [];
  const slow = (since: number, limit: number) => new Promise<PipelinePage>((resolve) => { reads++; release.push(() => resolve({ events: [], nextSeq: since, hasMore: false })); void limit; });
  const hq = fakeHq(0);
  const { instance } = relay(hq, slow, { intervalMs: 5 });
  instance.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(reads, 1);
  instance.close();
});

test("new ledger events are pushed shortly after they land, in one pass per burst, without waiting for the timer", async () => {
  const hq = fakeHq(0);
  const all = events(2);
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const { instance, logged } = relay(hq, exportOf(all), { subscribe, wakeDelayMs: 10 });
  instance.start(); await instance.idle();
  assert.equal(hq.state.cursor, 2);
  const passes = () => hq.state.bodies.filter((body) => body.since === 0 && body.events.length === 0).length;
  all.push({ seq: 3, pad: "" }, { seq: 4, pad: "" });
  for (const listener of listeners) { listener(); listener(); }
  await waitFor(() => hq.state.cursor === 4);
  await instance.idle();
  assert.equal(passes(), 2);
  instance.close();
  assert.equal(listeners.size, 0);
  assert.deepEqual(logged, []);
});

test("an event during a pass is followed by another pass once it ends", async () => {
  const hq = fakeHq(0);
  const all = events(1);
  let notify = () => {};
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const read = exportOf(all);
  // The first pass reads the export before the second event lands, and is still running when it does.
  let reads = 0;
  const { instance } = relay(hq, async (since, limit) => { const page = await read(since, limit); reads++; await gate; return page; },
    { subscribe: (listener) => { notify = listener; return () => {}; }, wakeDelayMs: 0 });
  instance.start();
  await waitFor(() => reads === 1);
  all.push({ seq: 2, pad: "" });
  notify();
  // The wake's zero-delay timer fires before this one.
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  await waitFor(() => hq.state.cursor === 2);
  await instance.idle();
  instance.close();
});

test("it refuses to run without HQ's origin and token", () => {
  const read = exportOf([]);
  assert.throws(() => createPipelineRelay({ origin: "", token: "t", readPage: read }), /origin and YARDSMITH_SLIPJAY_BUILD_TOKEN/);
  assert.throws(() => createPipelineRelay({ origin: "https://hq.example", token: " ", readPage: read }), /origin and YARDSMITH_SLIPJAY_BUILD_TOKEN/);
});

test("the local reader pages the runner's export with its token", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const read = localPipelineReader({ baseUrl: "http://127.0.0.1:1", token: "runner", fetch: async (url, init) => {
    seen.push({ url, auth: new Headers(init.headers).get("authorization") });
    return Response.json({ events: [{ seq: 5 }], nextSeq: 5, hasMore: false });
  } });
  assert.deepEqual(await read(4, 10, AbortSignal.timeout(1000)), { events: [{ seq: 5 }], nextSeq: 5, hasMore: false });
  assert.deepEqual(seen, [{ url: "http://127.0.0.1:1/v1/metrics/events?since=4&limit=10", auth: "Bearer runner" }]);
  const bad = localPipelineReader({ baseUrl: "http://x", token: "t", fetch: async () => new Response("no", { status: 409 }) });
  await assert.rejects(bad(9, 1, AbortSignal.timeout(1000)), /HTTP 409/);
});

test("a runner whose HQ is unreachable still serves and shuts down promptly", async () => {
  const home = await mkdtemp(join(tmpdir(), "slipjay-relay-"));
  try {
    await writeFile(join(home, "config.json"), JSON.stringify({ name: "relay-runner", repos: {}, build: { origin: "http://127.0.0.1:1" },
      jj: { "user.name": "Runner Identity", "user.email": "runner@example.com" } }));
    const runner = await startRunner({ home, env: { SLIPJAY_RUNNER_TOKEN: "token", YARDSMITH_SLIPJAY_BUILD_TOKEN: "build" }, port: 0 });
    const health = await fetch(`${runner.url}/v1/health`, { headers: { authorization: "Bearer token" } });
    assert.equal(health.status, 200);
    await runner.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});


test("every bounded page carries the watch release state verbatim, including the last page", async () => {
  const hq = fakeHq(5);
  const state = releaseState();
  let observations = 0;
  const { once, logged } = relay(hq, exportOf(events(40, 1000)), {
    readReleaseState: () => { observations++; return state; }, maxBodyBytes: 12_000,
  });
  await once();
  assert.equal(observations, 1);
  assert.equal(hq.state.cursor, 40);
  assert.ok(hq.state.bodies.filter((body) => body.events.length).length > 1);
  for (const body of hq.state.bodies) {
    assert.equal(body.observedAt, state.observedAt);
    assert.deepEqual(body.repositories, state.repositories);
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 12_000);
  }
  assert.equal(hq.state.bodies.at(-1)!.hasMore, false);
  assert.deepEqual(logged, []);
});

test("the idle thirty-minute keepalive refreshes repository observations without new events", async () => {
  vi.useFakeTimers();
  const hq = fakeHq();
  let observations = 0;
  const { instance, logged } = relay(hq, exportOf([]), {
    readReleaseState: () => releaseState(new Date(Date.UTC(2026, 9, 30, 13, observations++ * 30)).toISOString()),
  });
  try {
    instance.start(); await instance.idle();
    assert.equal(observations, 1);
    await vi.advanceTimersByTimeAsync(PIPELINE_RELAY_INTERVAL_MS);
    await instance.idle();
    assert.equal(observations, 2);
    const keepalive = hq.state.bodies.at(-1)!;
    assert.equal(keepalive.observedAt, "2026-10-30T13:30:00.000Z");
    assert.deepEqual(keepalive.repositories, releaseState("2026-10-30T13:30:00.000Z").repositories);
    assert.deepEqual(keepalive.events, []);
    assert.equal(keepalive.nextSeq, 0);
    assert.deepEqual(logged, []);
  } finally { instance.close(); vi.useRealTimers(); }
});

test("a release event wakes a fresh observation even when the metrics export has no new rows", async () => {
  const hq = fakeHq();
  let notify = () => {};
  let state = releaseState();
  const { instance } = relay(hq, exportOf([]), { readReleaseState: () => state,
    subscribe: (listener) => { notify = listener; return () => {}; }, wakeDelayMs: 0 });
  try {
    instance.start(); await instance.idle();
    state = releaseState("2026-10-30T13:01:00.000Z");
    state.repositories[0]!.release!.waitingOn = { kind: "deploy", detail: null };
    notify();
    await waitFor(() => hq.state.bodies.some((body) => body.observedAt === state.observedAt));
    await instance.idle();
    assert.deepEqual(hq.state.bodies.at(-1)!.repositories, state.repositories);
  } finally { instance.close(); }
});

test("an oversized release summary is logged without bypassing the body cap", async () => {
  const hq = fakeHq();
  const state = releaseState();
  state.repositories[0]!.release!.waitingOn.detail = "x".repeat(5000);
  const { once, logged } = relay(hq, exportOf([]), { readReleaseState: () => state, maxBodyBytes: 2000 });
  await once();
  assert.equal(hq.state.bodies.length, 0);
  assert.match(logged.join("\n"), /repository summary is larger than 2000 bytes/);
});
