import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { watchRunner, type WatchEnvelope } from "../src/lib/runner-watch.ts";
import type { QueueSnapshot, StoredEvent } from "../src/lib/runner-contract.ts";

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
  assert.equal(envelopes[0]?.type, "snapshot");
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
