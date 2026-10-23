import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";
import { localExecutor } from "../../src/lib/runner/local-executor.ts";
import type { LocalExecutorOptions } from "../../src/lib/runner/local-executor.ts";
import type { Executor } from "../../src/lib/runner/runner-types.ts";

/**
 * A disposable budget slice for tests, so they never set the limits of a live runner's
 * `slipjay.slice` on the same host. Tests run inside a runner command nest beneath it instead.
 */
export const TEST_SLICE = "slipjaytest.slice";

/** The runner's local executor, under TEST_SLICE. */
export const testExecutor = (options: Omit<LocalExecutorOptions, "slice"> = {}) => localExecutor({ ...options, slice: TEST_SLICE });

/**
 * An executor that runs each command directly in its own process group, standing in for an
 * enforced combined budget so concurrent paths still run. For tests whose subject is not
 * containment: a systemd scope per command costs several systemctl calls, and the tests of
 * scopes and slices use `testExecutor` on a host that has them.
 */
export const directExecutor = (host: string): Executor => ({ host, combinedLimits: true, run: runBoundedProcess });
