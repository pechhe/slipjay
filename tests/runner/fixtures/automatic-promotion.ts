import type { fixture } from "./runner-queue-fixture.ts";
import type { OperationEvent } from "../../../src/lib/runner/runner-types.ts";

export const REPO = "fixture/repo";
export const settle = async (f: Awaited<ReturnType<typeof fixture>>) => { f.queue.wake(); await f.queue.idle(); await f.queue.idle(); };

/** A promotion schedule that falls due every `everyMinutes`, all day. */
export const schedule = (everyMinutes: number) => ({ everyMinutes, from: "00:00", until: "23:59", timeZone: "Europe/London" });
/** The operation's recorded events of one type, as the batch and background checks write them. */
export const batchEvents = <T extends OperationEvent["type"]>(f: Awaited<ReturnType<typeof fixture>>, id: string, type: T) =>
  f.log.events({ operationId: id }).map((row) => row.event).filter((event): event is Extract<OperationEvent, { type: T }> => event.type === type);
