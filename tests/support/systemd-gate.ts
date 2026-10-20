import { TEST_REPORT_DIR_ENV } from "../../src/lib/runner/test-reports.ts";

/** What decides whether a systemd test runs: the platform, the user runtime directory and whether this is a landing on the runner. */
export type SystemdInputs = { platform: string; runtimeDir?: string; onRunner: boolean };

export type SystemdDecision = { action: "run" } | { action: "skip" } | { action: "fail"; message: string };

/**
 * The runner sets SLIPJAY_TEST_REPORT_DIR for every gate command it runs (see test-reports.ts),
 * and nothing else does, so its presence marks a landing check on the runner.
 */
export const onRunner = (env: NodeJS.ProcessEnv = process.env) => Boolean(env[TEST_REPORT_DIR_ENV]);

export const systemdInputs = (env: NodeJS.ProcessEnv = process.env, platform = process.platform): SystemdInputs =>
  ({ platform, runtimeDir: env.XDG_RUNTIME_DIR, onRunner: onRunner(env) });

/** With a user systemd the test runs; without one it skips, except on the runner, where a skip would hide a lost containment and it fails. */
export function decideSystemd({ platform, runtimeDir, onRunner }: SystemdInputs): SystemdDecision {
  if (platform === "linux" && runtimeDir) return { action: "run" };
  if (!onRunner) return { action: "skip" };
  return { action: "fail", message: "user systemd unavailable (XDG_RUNTIME_DIR unset) on the runner: systemd containment tests must run here" };
}

type Registrar = ((name: string, body: () => unknown, timeout?: number) => unknown) & { skip: (name: string, body: () => unknown, timeout?: number) => unknown };

/** `base` itself, `base.skip`, or a registrar of tests that fail with the decision's message. */
export function systemdTest<T extends Registrar>(base: T, inputs: SystemdInputs = systemdInputs()): Registrar {
  const decision = decideSystemd(inputs);
  if (decision.action === "run") return base;
  if (decision.action === "skip") return base.skip as Registrar;
  const fail = (name: string, _body: () => unknown, timeout?: number) => base(name, () => { throw new Error(decision.message); }, timeout);
  return Object.assign(fail, { skip: base.skip });
}
