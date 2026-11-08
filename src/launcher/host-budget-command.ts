import { awaitHostBudget, hostShell, type HostBudgetClass } from "../lib/runner/host-budget.ts";

export async function runHostBudget(args: string[]): Promise<number> {
  const usage = "Usage: slipjay host-budget wait --job <name> [--gate] [--max-wait-seconds <n>]";
  const [action, ...rest] = args;
  let job: string | undefined;
  let jobClass: HostBudgetClass = "background";
  let limitMs: number | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--job") job = rest[++index];
    else if (rest[index] === "--gate") jobClass = "gate";
    else if (rest[index] === "--max-wait-seconds") {
      limitMs = Number(rest[++index]) * 1000;
      if (!Number.isFinite(limitMs) || limitMs < 0) { console.error(usage); return 2; }
    } else { console.error(usage); return 2; }
  }
  if (action !== "wait" || !job) { console.error(usage); return 2; }
  await awaitHostBudget({ shell: hostShell(), job, host: "this host", jobClass, onWait: (line) => console.error(line), ...limitMs === undefined ? {} : { limitMs } });
  return 0;
}
