import type { DeploymentEnvironment } from "./deployment-policy.ts";
import type { DeployOperation, OperationLog } from "./runner-contract.ts";

const RETRY_MS = 3_600_000;

/**
 * When the runner deploys an environment that follows the integration branch (not production): its
 * latest landed commit, once the environment's interval has passed since the last
 * attempt, and never a commit already deployed or tried. A deploy that is not due yet
 * gets one timer; the runner re-asks after every landing, every deploy and at startup,
 * so nothing here outlives a restart.
 */
export function createDeployScheduler(input: {
  log: OperationLog;
  submit(repo: string, environment: string, commitId: string): void;
  now?: () => number;
}): { consider(repo: string, environments: Record<string, DeploymentEnvironment>): void; close(): void } {
  const { log, submit, now = Date.now } = input;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  function considerOne(repo: string, environment: string, policy: DeploymentEnvironment): void {
    const landed = log.lastLanded(repo);
    if (!landed) return;
    const deploys = log.deployments(repo, environment);
    // The deploy lane re-asks when an open deploy ends.
    if (deploys.some((operation) => operation.status === "queued" || operation.status === "running")) return;
    if (deploys.some((operation) => operation.commitId === landed.commitId && attempted(operation))) return;
    const latest = deploys.find((operation) => operation.status !== "superseded" && operation.status !== "cancelled");
    // A pre-project failure may be retried, but a zero deploy interval must not
    // turn a persistent fetch/policy failure into an unbounded operation loop.
    // A newer landed commit still uses its normal deployment interval.
    const retry = latest?.commitId === landed.commitId && latest.result?.type === "failed" && !attempted(latest);
    const interval = retry ? Math.max(policy.minIntervalMs, RETRY_MS) : policy.minIntervalMs;
    const due = latest ? Date.parse(latest.submittedAt) + interval : 0;
    const wait = due - now();
    const key = `${repo}\n${environment}`;
    clearTimeout(timers.get(key));
    timers.delete(key);
    if (wait <= 0) {
      submit(repo, environment, landed.commitId);
      return;
    }
    const timer = setTimeout(() => { timers.delete(key); considerOne(repo, environment, policy); }, wait);
    timer.unref?.();
    timers.set(key, timer);
  }
  return {
    consider(repo, environments) {
      for (const [environment, policy] of Object.entries(environments)) {
        // Production moves only through promotion, never the integration branch.
        if (environment !== "production") considerOne(repo, environment, policy);
      }
    },
    close() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

/** Projects that ran, or an owner's cancellation, are retried only on demand. */
const attempted = (operation: DeployOperation): boolean =>
  operation.status === "cancelled" || operation.result?.type === "deployed" || (operation.result?.type === "failed" && operation.result.deployment !== undefined);
