import type { QueueSnapshot, StoredEvent } from "./runner-contract.ts";

export type WatchEnvelope =
  | { version: 1; type: "snapshot"; snapshot: QueueSnapshot }
  | { version: 1; type: "event"; event: StoredEvent }
  | { version: 1; type: "heartbeat"; at: string; seq: number }
  | {
      version: 1;
      type: "connection";
      state: "connecting" | "connected" | "disconnected";
      cursor: number;
    };
export type WatchConnection = {
  snapshot(signal: AbortSignal): Promise<QueueSnapshot>;
  stream(cursor: number, signal: AbortSignal): Promise<Response>;
  close(): void;
};

/** Reconnect snapshots describe current state; only emitted events advance a replay cursor. */
export async function watchRunner(input: {
  connect(): Promise<WatchConnection>;
  emit(envelope: WatchEnvelope): void;
  signal: AbortSignal;
  retry?(signal: AbortSignal): Promise<void>;
  armTimeout?(expire: () => void, ms: number): () => void;
}): Promise<void> {
  let cursor: number | undefined;
  while (!input.signal.aborted) {
    let connection: WatchConnection | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (cursor !== undefined)
        input.emit({ version: 1, type: "connection", state: "connecting", cursor });
      connection = await input.connect();
      if (input.signal.aborted) break;
      const snapshot = await connection.snapshot(input.signal);
      input.emit({ version: 1, type: "snapshot", snapshot });
      cursor ??= snapshot.seq;
      input.emit({ version: 1, type: "connection", state: "connected", cursor });
      const response = await connection.stream(cursor, input.signal);
      if (!response.ok || !response.body) throw new Error("Runner event stream unavailable");
      const streamReader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      reader = streamReader;
      const abortReader = () => {
        void reader?.cancel().catch(() => {});
      };
      input.signal.addEventListener("abort", abortReader, { once: true });
      const decoder = new TextDecoder();
      let pending = "";
      try {
        while (!input.signal.aborted) {
          let clearTimeout: (() => void) | undefined;
          const timeout = new Promise<never>((_, reject) => {
            const arm = input.armTimeout ?? ((expire: () => void, ms: number) => {
              const timer = setTimeout(expire, ms); return () => globalThis.clearTimeout(timer);
            });
            clearTimeout = arm(() => reject(new Error("Runner heartbeat timed out")), 60_000);
          });
          const part = await Promise.race([streamReader.read(), timeout]).finally(() => clearTimeout?.());
          if (part.done) break;
          pending += decoder.decode(part.value, { stream: true }).replace(/\r\n/g, "\n");
          if (pending.length > 4 * 1024 * 1024) throw new Error("Runner event frame exceeds limit");
          let end: number;
          while ((end = pending.indexOf("\n\n")) !== -1) {
            const frame = pending.slice(0, end);
            pending = pending.slice(end + 2);
            const kind = frame
              .split("\n")
              .find((line) => line.startsWith("event:"))
              ?.slice(6)
              .trim();
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            if (kind === "stored") {
              const event = JSON.parse(data) as StoredEvent;
              if (!Number.isSafeInteger(event.seq) || event.seq < 0)
                throw new Error("Invalid runner event sequence");
              if (event.seq <= cursor) continue;
              input.emit({ version: 1, type: "event", event });
              cursor = event.seq;
              if (!input.signal.aborted)
                input.emit({
                  version: 1,
                  type: "snapshot",
                  snapshot: await connection.snapshot(input.signal),
                });
            } else if (kind === "heartbeat") {
              const heartbeat = JSON.parse(data) as { at: string; seq: number };
              input.emit({ version: 1, type: "heartbeat", at: heartbeat.at, seq: heartbeat.seq });
              if (!input.signal.aborted)
                input.emit({
                  version: 1,
                  type: "snapshot",
                  snapshot: await connection.snapshot(input.signal),
                });
            }
          }
        }
      } finally {
        input.signal.removeEventListener("abort", abortReader);
      }
    } catch {
      // Credentials and transport errors can contain private details; emit only protocol state.
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      connection?.close();
    }
    if (input.signal.aborted) break;
    if (cursor !== undefined)
      input.emit({ version: 1, type: "connection", state: "disconnected", cursor });
    try {
      await input.retry?.(input.signal);
    } catch {
      if (input.signal.aborted) break;
    }
  }
}
