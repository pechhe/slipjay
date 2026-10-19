import { localExecutor } from "../../src/lib/runner/runner-queue.ts";
import type { LocalExecutorOptions } from "../../src/lib/runner/runner-queue.ts";

/**
 * A disposable budget slice for tests, so they never set the limits of a live runner's
 * `slipjay.slice` on the same host. Tests run inside a runner command nest beneath it instead.
 */
export const TEST_SLICE = "slipjaytest.slice";

/** The runner's local executor, under TEST_SLICE. */
export const testExecutor = (options: Omit<LocalExecutorOptions, "slice"> = {}) => localExecutor({ ...options, slice: TEST_SLICE });
