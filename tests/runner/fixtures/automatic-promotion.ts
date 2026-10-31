import type { fixture } from "./runner-queue-fixture.ts";

export const REPO = "fixture/repo";
export const settle = async (f: Awaited<ReturnType<typeof fixture>>) => { f.queue.wake(); await f.queue.idle(); await f.queue.idle(); };
