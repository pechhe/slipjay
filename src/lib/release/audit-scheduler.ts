import type { AuditPolicy } from "../policy/audit-policy.ts";
import { latestAuditSlot, nextAuditSlot } from "./audit-schedule.ts";
import type { OperationLog } from "../runner/runner-types.ts";

const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * When the runner audits a repository: once for every scheduled wall-clock time (`timeOfDay` in `timeZone`), not an
 * interval after the last run. The latest scheduled time that has passed is covered once an audit submitted for it
 * reached a verdict, green or failing; until then an audit is due and is submitted at once. So a time the runner
 * missed (it was down, or the repository declared the audit only now), and a run that was cancelled, or interrupted by
 * a restart, are submitted again at the next consideration; unlike the reset scheduler, a killed run is not counted as run.
 * A failing audit is a verdict: it is not retried before the next scheduled time. Several missed times are one run.
 * An audit that is queued or running is never doubled; the queue re-asks when it ends, and the runner re-asks at
 * startup and after every landing, so nothing here outlives a restart. A time that is not yet due gets one timer.
 */
export function createAuditScheduler(input: {
  log: OperationLog;
  /** Submit an audit of `repo` for the scheduled instant `slot` (milliseconds since the epoch). */
  submit(repo: string, slot: number): void;
  now?: () => number;
}): {
  consider(repo: string, policy: AuditPolicy | null): void;
  /** Consider `repo` again with the policy last given for it; nothing when it had none. */
  reconsider(repo: string): void;
  close(): void;
} {
  const { log, submit, now = Date.now } = input;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const policies = new Map<string, AuditPolicy>();
  function consider(repo: string, policy: AuditPolicy | null): void {
    clearTimeout(timers.get(repo));
    timers.delete(repo);
    if (!policy) { policies.delete(repo); return; }
    policies.set(repo, policy);
    const audits = log.audits(repo);
    if (audits.some((operation) => operation.status === "queued" || operation.status === "running")) return;
    const slot = latestAuditSlot(now(), policy);
    if (!audits.some((operation) => Date.parse(operation.slot) >= slot && (operation.status === "audited" || operation.status === "failed"))) {
      submit(repo, slot);
      return;
    }
    // A timer longer than about 24.8 days fires at once, so a longer wait re-asks when it ends.
    const wait = nextAuditSlot(now(), policy) - now();
    const timer = setTimeout(() => { timers.delete(repo); consider(repo, policy); }, Math.min(Math.max(wait, 0), MAX_TIMER_MS));
    timer.unref?.();
    timers.set(repo, timer);
  }
  return {
    consider,
    reconsider(repo) {
      const policy = policies.get(repo);
      if (policy) consider(repo, policy);
    },
    close() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
