type Timing = { startedAt: number; finishedAt: number; stages: ReadonlyArray<readonly [string, number]> };

/** One terse line of elapsed seconds per landing stage, for the CLI's stderr. */
const seconds = (ms: number): string => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

/** `stages` are `[name, epochMs]` marks as the runner reported them; each stage ends where the next starts. */
function stageDurations({ finishedAt, stages }: Timing): [string, number][] {
  return stages.map(([stage, at], index) => [stage, Math.max(0, (index + 1 < stages.length ? stages[index + 1]![1] : finishedAt) - at)]);
}

export function landingTimingLine(timing: Timing): string {
  const parts = stageDurations(timing).map(([stage, ms]) => `${stage} ${seconds(ms)}`);
  return `[land] ${[...parts, `total ${seconds(timing.finishedAt - timing.startedAt)}`].join(" · ")}`;
}
