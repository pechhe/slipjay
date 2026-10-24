import { fileURLToPath } from "node:url";
import { startRunner } from "../../src/lib/runner/runner-service.ts";
import { directExecutor } from "./executor.ts";

// Imported by the parent so related-test selection follows the child's real source graph.
export const testRunnerEntryPath = fileURLToPath(import.meta.url);

if (import.meta.main) {
  let runner: Awaited<ReturnType<typeof startRunner>> | undefined;
  let closing: Promise<void> | undefined;
  let failed = false;
  const close = () => closing ??= (async () => { await runner?.close(); })();
  const fatal = (error: unknown) => {
    failed = true;
    console.error(error);
    process.send?.({ type: "fatal", error: error instanceof Error ? error.stack : String(error) });
    void close().finally(() => process.exit(1));
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  // The IPC channel is also the parent lifeline; a dead test must not leave a runner.
  process.on("disconnect", () => { void close().then(() => process.exit(failed ? 1 : 0), fatal); });
  process.on("message", (message: unknown) => {
    if ((message as { type?: string })?.type === "close") {
      void close().then(() => process.send?.({ type: "closed" }), fatal);
    }
  });
  try {
    runner = await startRunner({ home: process.argv[2]!, port: 0, executor: directExecutor("test-runner"), env: { ...process.env } });
    if (!process.connected) { await close(); process.exit(0); }
    process.send?.({ type: "ready", url: runner.url });
  } catch (error) { fatal(error); }
}
