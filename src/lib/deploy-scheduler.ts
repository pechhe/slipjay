import type { DeploymentEnvironment } from "./deployment-policy.ts";
import type { DeployOperation, OperationLog } from "./runner-contract.ts";

/**
 * When the runner deploys an environment that follows the integration branch: its
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
    const due = latest ? Date.parse(latest.submittedAt) + policy.minIntervalMs : 0;
    const wait = due - now();
    const key = `${repo}\n${environment}`;
    if (wait <= 0) {
      clearTimeout(timers.get(key));
      timers.delete(key);
      submit(repo, environment, landed.commitId);
      return;
    }
    if (timers.has(key)) return;
    const timer = setTimeout(() => { timers.delete(key); considerOne(repo, environment, policy); }, wait);
    timer.unref?.();
    timers.set(key, timer);
  }
  return {
    consider(repo, environments) {
      for (const [environment, policy] of Object.entries(environments)) considerOne(repo, environment, policy);
    },
    close() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

/** A deploy whose projects ran (deployed, or some failed): retried only on demand. One the runner never ran retries on schedule. */
const attempted = (operation: DeployOperation): boolean =>
  operation.result?.type === "deployed" || (operation.result?.type === "failed" && operation.result.deployment !== undefined);
