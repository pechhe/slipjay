/**
 * Where a `slipjay start` spends its time: milliseconds per step, in its JSON result and its
 * `pool_claim` metric, so a slow claim can be attributed. Each step is exclusive of the others:
 * `fetch` the integration fetch, `claim` taking a spare (the pool lock and rename), `jjNew` moving
 * it to its base, `fingerprint` computing install inputs (on a claim and around an install),
 * `install` making dependencies ready (absent when a claimed spare's are reused), `describe` the
 * working-copy description. A step a start did not take is absent.
 */
export const START_STEPS = ["fetch", "claim", "jjNew", "fingerprint", "install", "describe"] as const;
export type StartStep = typeof START_STEPS[number];
export type StartSteps = Partial<Record<StartStep, number>>;

/**
 * Run `work`, adding its duration to `step` in `steps` when steps are being recorded. Steps timed
 * inside it (a fingerprint inside an install) count as themselves, never twice.
 */
export async function timed<T>(steps: StartSteps | undefined, step: StartStep, work: () => Promise<T>): Promise<T> {
  if (!steps) return await work();
  const started = performance.now();
  const before = recorded(steps);
  try {
    return await work();
  } finally {
    const nested = recorded(steps) - before;
    steps[step] = (steps[step] ?? 0) + Math.max(0, Math.round(performance.now() - started) - nested);
  }
}

const recorded = (steps: StartSteps): number => Object.values(steps).reduce((sum, ms) => sum + (ms ?? 0), 0);
