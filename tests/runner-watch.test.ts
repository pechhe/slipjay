import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { watchCursor, watchRunner, WATCH_REPLAY_LIMIT, type WatchEnvelope } from "../src/lib/runner-watch.ts";
import { createRunnerHandler } from "../src/lib/runner-api.ts";
import { openOperationLog } from "../src/lib/runner-log.ts";
import type { QueueSnapshot, StoredEvent } from "../src/lib/runner-contract.ts";

test("watch cursor accepts only non-negative safe integers", () => {
  assert.equal(watchCursor(undefined), undefined);
  assert.equal(watchCursor("0"), 0);
  assert.equal(watchCursor("42"), 42);
  for (const raw of ["", "-1", "1.5", "1e2", "Infinity", " 2", "9007199254740992"])
    assert.throws(() => watchCursor(raw), /SLIPJAY_WATCH_CURSOR/);
});

test("real watch contract: first install, restart catch-up, dedup and replaced-log resync", async () => {
  let log = openOperationLog(":memory:");
  const originalCursor = process.env.SLIPJAY_WATCH_CURSOR;
  const sessions: WatchEnvelope[][] = [];
  const requests: number[][] = [];
  function submit(id: string) {
    log.append(id, { type: "submitted", kind: "release", repo: "fixture/repo", commitId: "candidate", migrationsReady: false, submittedBy: "owner" });
    log.append(id, { type: "stage", stage: "verifying" });
  }
  async function session(cursor: number | undefined, afterConnected?: () => void) {
    if (cursor === undefined) delete process.env.SLIPJAY_WATCH_CURSOR;
    else process.env.SLIPJAY_WATCH_CURSOR = String(cursor);
    const controller = new AbortController();
    const values: WatchEnvelope[] = [], cursors: number[] = [];
    const handler = createRunnerHandler({ log, token: "fixture", runnerName: "fixture-runner", readLog: async () => null, onSubmitted() {}, kill: () => ({ status: "idle" }), subscribe: () => () => {} });
    const request = (path: string, signal: AbortSignal, headers: Record<string, string> = {}) => handler(new Request(`http://runner/v1/${path}`, { signal, headers: { authorization: "Bearer fixture", ...headers } }));
    await watchRunner({ signal: controller.signal,
      emit(value) {
        values.push(value);
        if (value.type === "connection" && value.state === "connected") {
          afterConnected?.();
          if (value.cursor === log.latestSeq()) controller.abort();
        }
        if (value.type === "snapshot" && values.some((item) => item.type === "event" && item.event.seq === log.latestSeq())) controller.abort();
      },
      async connect() {
        return { close() {},
          async snapshot(signal) { return (await request("queue", signal)).json() as Promise<QueueSnapshot>; },
          async stream(cursor, signal) { cursors.push(cursor); return request(`metrics/events?since=${cursor}`, signal, { accept: "text/event-stream" }); },
        };
      },
    });
    sessions.push(values); requests.push(cursors);
    return values;
  }
  try {
    submit("release");
    const initialCursor = log.latestSeq();
    await session(undefined); // Existing verification does not notify on first install.
    log.append("release", { type: "failed", stage: "verifying", reason: "fixture gate failed" });
    const appliedCursor = log.latestSeq();
    const caughtUp = await session(initialCursor);
    assert.deepEqual(caughtUp.filter((item) => item.type === "event").map((item) => item.event.seq), log.events({ afterSeq: initialCursor }).map((item) => item.seq));
    assert.equal(caughtUp.filter((item) => item.type === "snapshot").length, 2);
    await session(appliedCursor); // Acknowledged events do not replay after another app restart.
    log.close(); log = openOperationLog(":memory:");
    await session(appliedCursor, () => { submit("replacement"); log.append("replacement", { type: "failed", stage: "verifying", reason: "new log failure" }); });
    assert.deepEqual(requests, [[initialCursor], [initialCursor], [appliedCursor], [appliedCursor, 0]]);
    assert.deepEqual(sessions[3]!.filter((item) => item.type === "event").map((item) => item.event.seq), log.events().map((item) => item.seq));
  } finally {
    log.close();
    if (originalCursor === undefined) delete process.env.SLIPJAY_WATCH_CURSOR;
    else process.env.SLIPJAY_WATCH_CURSOR = originalCursor;
  }
});

test("catch-up bounds the event window and refreshes once after the replay batch", async () => {
  const originalCursor = process.env.SLIPJAY_WATCH_CURSOR;
  process.env.SLIPJAY_WATCH_CURSOR = "0";
  const controller = new AbortController();
  const envelopes: WatchEnvelope[] = [];
  let snapshots = 0;
  try {
    await watchRunner({ signal: controller.signal, emit(value) { envelopes.push(value); },
      async connect() {
        return { close() {},
          async snapshot() { if (++snapshots === 2) controller.abort(); return { version: 1, seq: 1000 } as QueueSnapshot; },
          async stream(cursor) {
            assert.equal(cursor, 1000 - WATCH_REPLAY_LIMIT);
            return new Response(new ReadableStream<Uint8Array>({ start(c) {
              for (let seq = cursor + 1; seq <= 1000; seq++)
                c.enqueue(new TextEncoder().encode(`event: stored\ndata: ${JSON.stringify({ seq })}\n\n`));
              c.close();
            } }));
          },
        };
      },
    });
    assert.equal(envelopes.filter((item) => item.type === "event").length, WATCH_REPLAY_LIMIT);
    assert.equal(snapshots, 2, "one initial snapshot and one refresh for the entire replay");
  } finally {
    if (originalCursor === undefined) delete process.env.SLIPJAY_WATCH_CURSOR;
    else process.env.SLIPJAY_WATCH_CURSOR = originalCursor;
  }
});

test("watch refreshes a replaced connection without skipping replay and emits JSON heartbeats", async () => {
  const controller = new AbortController();
  const envelopes: WatchEnvelope[] = [];
  const cursors: number[] = [];
  let opened = 0,
    closed = 0,
    cancelled = 0;
  await watchRunner({
    signal: controller.signal,
    retry: async () => {},
    emit(value) {
      envelopes.push(JSON.parse(JSON.stringify(value)));
      if (value.type === "event" && value.event.seq === 7) controller.abort();
    },
    async connect() {
      const round = opened++;
      return {
        close() {
          closed++;
        },
        async snapshot() {
          return { version: 1, seq: round ? 9 : 5 } as QueueSnapshot;
        },
        async stream(cursor) {
          cursors.push(cursor);
          const events = round ? [6, 7] : [6];
          const text =
            events
              .map((seq) => `event: stored\ndata: ${JSON.stringify({ seq } as StoredEvent)}\n\n`)
              .join("") + 'event: heartbeat\ndata: {"at":"now","seq":9}\n\n';
          return new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(new TextEncoder().encode(text));
                if (!round) c.close();
              },
              cancel() {
                cancelled++;
              },
            }),
          );
        },
      };
    },
  });
  assert.deepEqual(envelopes[0], { version: 1, type: "connection", state: "connecting", cursor: 0 });
  assert.deepEqual(cursors, [5, 6]);
  assert.deepEqual(
    envelopes.filter((e) => e.type === "event").map((e) => e.event.seq),
    [6, 7],
  );
  assert.ok(envelopes.some((e) => e.type === "heartbeat"));
  assert.equal(opened, 2);
  assert.equal(closed, 2);
  assert.equal(cancelled, 1);
});

test("failed first attempts report public connection states at cursor zero", async () => {
  const controller = new AbortController();
  const envelopes: WatchEnvelope[] = [];
  let attempts = 0;
  await watchRunner({ signal: controller.signal,
    emit(value) { envelopes.push(value); },
    async connect() { attempts++; throw new Error("private credential and transport detail"); },
    async retry() { if (attempts === 2) controller.abort(); },
  });
  assert.deepEqual(envelopes, ["connecting", "disconnected", "connecting", "disconnected"].map(state =>
    ({ version: 1, type: "connection", state, cursor: 0 })));
});

test("watch cancellation releases a reader blocked on a quiet live stream", async () => {
  const controller = new AbortController();
  let cancelled = 0, closed = 0;
  await watchRunner({ signal: controller.signal, emit() {},
    async connect() {
      return { close() { closed++; },
        async snapshot() { return { version: 1, seq: 0 } as QueueSnapshot; },
        async stream() {
          return new Response(new ReadableStream<Uint8Array>({
            pull() { controller.abort(); }, cancel() { cancelled++; },
          }));
        },
      };
    },
  });
  assert.equal(cancelled, 1); assert.equal(closed, 1);
});

test("watch reconnects a silent stream at the injected heartbeat deadline retaining cursor", async () => {
  const controller = new AbortController();
  const cursors: number[] = [];
  let opened = 0, closed = 0;
  await watchRunner({ signal: controller.signal, emit() {}, retry: async () => {},
    armTimeout(expire, ms) { assert.equal(ms, 60_000); expire(); return () => {}; },
    async connect() {
      opened++;
      return { close() { closed++; },
        async snapshot() { return { version: 1, seq: opened === 1 ? 4 : 9 } as QueueSnapshot; },
        async stream(cursor) { cursors.push(cursor); if (opened === 2) controller.abort();
          return new Response(new ReadableStream<Uint8Array>({})); },
      };
    },
  });
  assert.deepEqual(cursors, [4, 4]); assert.equal(closed, 2);
});
