import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";
import { localExecutor } from "../../src/lib/runner/local-executor.ts";
import type { LocalExecutorOptions } from "../../src/lib/runner/local-executor.ts";
import type { Executor } from "../../src/lib/runner/runner-types.ts";

/**
 * A disposable budget slice for tests, so they never set the limits of a live runner's
 * `slipjay.slice` on the same host. Tests run inside a runner command nest beneath it instead.
 */
export const TEST_SLICE = "slipjaytest.slice";

/**
 * The longest a test's command scope lives: five times the test timeout, so a test run killed mid-test (which never
 * reaches its own cleanup) leaves no command running for more than ten minutes.
 */
export const TEST_SCOPE_MAX_SECONDS = 600;

/** The runner's local executor, under TEST_SLICE, its scopes stopped by systemd after TEST_SCOPE_MAX_SECONDS. */
export const testExecutor = (options: Omit<LocalExecutorOptions, "slice" | "maxRuntimeSeconds"> = {}) =>
  localExecutor({ ...options, slice: TEST_SLICE, maxRuntimeSeconds: TEST_SCOPE_MAX_SECONDS });

/**
 * An executor that runs each command directly in its own process group, standing in for an
 * enforced combined budget so concurrent paths still run. For tests whose subject is not
 * containment: a systemd scope per command costs several systemctl calls, and the tests of
 * scopes and slices use `testExecutor` on a host that has them.
 */
export const directExecutor = (host: string): Executor => ({ host, combinedLimits: true, run: runBoundedProcess });
