import type { ResetPolicy } from "../policy/post-integration-policy.ts";
import type { OperationLog } from "../runner/runner-types.ts";

const MAX_TIMER_MS = 2 ** 31 - 1;
const RETRY_MS = 3_600_000;

/**
 * When the runner resets a repository's declared target on its own: `intervalMs` after
 * the latest reset that ran its step (scheduled or on demand, whatever its verdict), or at
 * once when none ever has. A reset that failed in its step waits for the next interval
 * or for `slipjay reset`; one that failed before its step retries an hour later. One the
 * owner killed counts as run, so a kill is not undone by the schedule. A reset that is not due yet gets one timer; the runner
 * re-asks at startup, after every landing and after every reset, so nothing here
 * outlives a restart.
 */
export function createResetScheduler(input: {
  log: OperationLog;
  submit(repo: string): void;
  now?: () => number;
}): { consider(repo: string, policy: ResetPolicy | null): void; close(): void } {
  const { log, submit, now = Date.now } = input;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  function consider(repo: string, policy: ResetPolicy | null): void {
    clearTimeout(timers.get(repo));
    timers.delete(repo);
    if (policy?.intervalMs === undefined) return;
    const resets = log.resets(repo);
    // The queue re-asks when an open reset ends.
    if (resets.some((operation) => operation.status === "queued" || operation.status === "running")) return;
    // A reset cancelled or superseded while queued never started.
    const started = resets.filter((operation) => operation.stage !== "queued");
    // One that reached the step ran it; one the owner killed counts too, so the kill stands.
    const ran = started.find((operation) => operation.stage === "resetting" || operation.status === "cancelled");
    // One that failed before the step (a fetch, the probe's tip) never touched the target: it retries
    // RETRY_MS after it started, not a whole interval later, and not at once, so a lasting failure cannot spin.
    const [last] = started;
    const due = Math.max(ran ? Date.parse(ran.submittedAt) + policy.intervalMs : 0,
      last && last !== ran ? Date.parse(last.submittedAt) + Math.min(RETRY_MS, policy.intervalMs) : 0);
    const wait = due - now();
    if (wait <= 0) {
      submit(repo);
      return;
    }
    // A timer longer than about 24.8 days fires at once, so a longer wait re-asks when it ends.
    const timer = setTimeout(() => { timers.delete(repo); consider(repo, policy); }, Math.min(wait, MAX_TIMER_MS));
    timer.unref?.();
    timers.set(repo, timer);
  }
  return {
    consider,
    close() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
