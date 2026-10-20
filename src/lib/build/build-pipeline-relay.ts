/** How often the relay pushes with nothing new; HQ treats pipeline data older than three hours as stale. */
export const PIPELINE_RELAY_INTERVAL_MS = 30 * 60 * 1000;
/** How long after a new ledger event the relay pushes, so a burst of events goes in one pass. */
export const PIPELINE_RELAY_WAKE_DELAY_MS = 5_000;
/** One batch's body stays well under HQ's 4 MiB cap; a larger page is read again with a lower `limit`. */
export const PIPELINE_RELAY_MAX_BODY_BYTES = 3 * 1024 * 1024;
/** Each local read and each POST is aborted after this long. */
export const PIPELINE_RELAY_TIMEOUT_MS = 30_000;
const MAX_PAGE_LIMIT = 1000;
/** Pages one pass sends at most, so a pass always ends; the next timer carries on from HQ's cursor. */
const MAX_PAGES_PER_PASS = 200;
const MAX_REWINDS_PER_PASS = 5;

/** One page of the runner's `GET /v1/metrics/events` export. */
export type PipelinePage = { events: unknown[]; nextSeq: number; hasMore: boolean };
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** HQ's answer to a page: its cursor after storing it, a cursor that differs from `since`, or no usable answer. */
type HqAnswer = { kind: "stored"; cursor: number } | { kind: "rewind"; cursor: number } | { kind: "failed"; reason: string };

const cursorOf = (value: unknown): number | null => {
  const cursor = (value as { cursor?: unknown } | null)?.cursor;
  return typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : null;
};

/**
 * Pushes the runner's metrics export to HQ's `POST {origin}/api/build/runner/pipeline` on its own timer, since HQ cannot
 * reach the runner. HQ is the cursor authority: the relay holds no cursor, learns it from HQ at the start of each pass
 * and follows HQ's 409 rewinds. Nothing here touches the ledger's writers, the landing queue or the receipt drain, every
 * wait is bounded, and every failure is logged and dropped; the next timer starts over from HQ's cursor.
 */
export function createPipelineRelay(options: {
  origin: string; token: string;
  /** The local export, `GET /v1/metrics/events?since=&limit=`; throws when it cannot answer within the signal. */
  readPage(since: number, limit: number, signal: AbortSignal): Promise<PipelinePage>;
  /** The ledger's new events; each one schedules a pass shortly after it, so HQ follows the runner within seconds. */
  subscribe?(listener: () => void): () => void;
  intervalMs?: number; wakeDelayMs?: number; timeoutMs?: number; maxBodyBytes?: number; fetch?: Fetch; log?(message: string): void;
}) {
  const origin = options.origin.trim(), token = options.token.trim();
  if (!origin || !token) throw new Error("The pipeline relay needs HQ's origin and YARDSMITH_SLIPJAY_BUILD_TOKEN");
  const url = new URL("/api/build/runner/pipeline", origin).toString();
  const call = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? PIPELINE_RELAY_TIMEOUT_MS;
  const maxBytes = options.maxBodyBytes ?? PIPELINE_RELAY_MAX_BODY_BYTES;
  const log = options.log ?? ((message: string) => console.error(`pipeline relay: ${message}`));
  let timer: ReturnType<typeof setInterval> | undefined, wake: ReturnType<typeof setTimeout> | undefined, unsubscribe: (() => void) | undefined;
  let running: Promise<void> | undefined, again = false, closed = false;
  const stopped = new AbortController();
  const bounded = () => AbortSignal.any([stopped.signal, AbortSignal.timeout(timeoutMs)]);

  async function post(page: { since: number; events: unknown[]; nextSeq: number; hasMore: boolean }, body = JSON.stringify(page)): Promise<HqAnswer> {
    let response: Response;
    try {
      response = await call(url, { method: "POST", redirect: "error", signal: bounded(), body,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` } });
    } catch (error) { return { kind: "failed", reason: (error as Error).name === "TimeoutError" ? "HQ did not answer in time" : "HQ could not be reached" }; }
    const reply = await response.json().catch(() => null);
    const cursor = cursorOf(reply);
    if (response.status === 200 && cursor !== null) return { kind: "stored", cursor };
    if (response.status === 409 && cursor !== null) return { kind: "rewind", cursor };
    return { kind: "failed", reason: `HQ answered HTTP ${response.status}` };
  }

  /** The page after `since`, read again with a lower `limit` until its body fits HQ's cap. */
  async function boundedPage(since: number) {
    for (let limit = MAX_PAGE_LIMIT; ; limit = Math.floor(limit / 2)) {
      const page = await options.readPage(since, limit, bounded());
      const body = JSON.stringify({ since, events: page.events, nextSeq: page.nextSeq, hasMore: page.hasMore });
      if (Buffer.byteLength(body) <= maxBytes) return { page, body };
      if (limit === 1) throw new Error(`the event after ${since} is larger than ${maxBytes} bytes`);
    }
  }

  /** One pass: ask HQ where it is with an empty page, then send pages from there until the export is caught up. */
  async function pass(): Promise<void> {
    let since = 0, rewinds = 0, probing = true;
    for (let pages = 0; pages < MAX_PAGES_PER_PASS && !closed;) {
      const sending = probing ? { page: { events: [], nextSeq: since, hasMore: false }, body: undefined } : await boundedPage(since);
      const answer = await post({ since, ...sending.page }, sending.body);
      if (answer.kind === "failed") return log(answer.reason);
      if (answer.kind === "rewind") {
        if (++rewinds > MAX_REWINDS_PER_PASS) return log("HQ's cursor kept moving; trying again next time");
        since = answer.cursor; probing = false;
        continue;
      }
      since = answer.cursor;
      if (probing) { probing = false; continue; }
      pages++;
      if (!sending.page.hasMore) return;
    }
  }

  /** Runs a pass now; one asked for while a pass runs follows it, since that pass may have read the export too early. */
  function run(): void {
    if (closed) return;
    if (running) { again = true; return; }
    running = pass().catch((error) => log(`${(error as Error).message}`)).finally(() => {
      running = undefined;
      if (again) { again = false; run(); }
    });
  }
  function soon(): void {
    if (closed || wake) return;
    wake = setTimeout(() => { wake = undefined; run(); }, options.wakeDelayMs ?? PIPELINE_RELAY_WAKE_DELAY_MS);
    wake.unref?.();
  }
  return {
    /** Begins the timer and the ledger subscription, and runs a first pass now. */
    start() {
      if (closed || timer) return;
      timer = setInterval(run, options.intervalMs ?? PIPELINE_RELAY_INTERVAL_MS); timer.unref?.();
      unsubscribe = options.subscribe?.(soon);
      run();
    },
    /** Resolves when the pass in flight, if any, has ended. */
    async idle() { while (running) await running; },
    close() { closed = true; stopped.abort(); unsubscribe?.(); if (timer) clearInterval(timer); if (wake) clearTimeout(wake); },
  };
}

/** Reads the runner's own export over its loopback API, so the read is bounded like any other request. */
export function localPipelineReader(input: { baseUrl: string; token: string; fetch?: Fetch }) {
  const call = input.fetch ?? fetch;
  return async (since: number, limit: number, signal: AbortSignal): Promise<PipelinePage> => {
    const response = await call(`${input.baseUrl}/v1/metrics/events?since=${since}&limit=${limit}`, { signal, headers: { authorization: `Bearer ${input.token}` } });
    if (!response.ok) throw new Error(`the runner's export answered HTTP ${response.status}`);
    const page = await response.json() as Partial<PipelinePage>;
    if (!Array.isArray(page.events) || typeof page.nextSeq !== "number" || typeof page.hasMore !== "boolean") throw new Error("the runner's export returned an unreadable page");
    return { events: page.events, nextSeq: page.nextSeq, hasMore: page.hasMore };
  };
}
