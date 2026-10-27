/** How often the runner bounds retained evidence and follows the ledger with its trim and checkpoint. */
const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Retained evidence is bounded on a schedule: one pass at a time, now and every `intervalMs`. A pass that fails is
 * journalled with the error it stopped on, and the next interval runs the pass again: a loop that ended at the first
 * failure would let evidence grow for as long as the runner stayed up.
 */
export function createRetention(options: { pass(): Promise<void>; intervalMs?: number; log?(line: string): void }) {
  const log = options.log ?? ((line: string) => console.error(line));
  let passing: Promise<unknown> = Promise.resolve();
  const retain = () => {
    passing = passing.then(() => options.pass()).catch((error: unknown) => {
      log(`[retention] pass failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return passing;
  };
  const timer = setInterval(retain, options.intervalMs ?? RETENTION_INTERVAL_MS);
  timer.unref();
  return { retain, idle: () => passing, close: () => clearInterval(timer) };
}
