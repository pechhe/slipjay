import { command, environmentKeys } from "./post-integration-policy.ts";
import type { FinalizationCommand } from "./post-integration-policy.ts";

/** One deployed project of an environment: its name in deploy records and the command that deploys it. */
export type DeploymentProject = { name: string; command: FinalizationCommand };

/**
 * One environment the runner deploys. `staging` follows the integration branch: the
 * runner deploys its latest landed commit after landings, at most once per
 * `minIntervalMs`, plus on demand. Each project's command runs in an exact source view
 * of the deployed commit, with the declared `environmentKeys` and
 * `SLIPJAY_DEPLOY_ENVIRONMENT`/`SLIPJAY_DEPLOY_COMMIT`; the last line it prints that is a
 * URL is recorded as the project's deployment.
 */
export type DeploymentEnvironment = {
  minIntervalMs: number;
  timeoutMs: number;
  environmentKeys: string[];
  projects: DeploymentProject[];
};

export type DeploymentPolicy = { version: 1; environments: Record<string, DeploymentEnvironment> };

/** Environments the runner knows how to drive; production joins with promotion (#32). */
export const DEPLOYMENT_ENVIRONMENTS = ["staging"] as const;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const HOUR = 3_600_000;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

/** `deployments`: strict, so a typo never silently stops an environment deploying. */
export function deploymentPolicy(value: unknown): DeploymentPolicy | null {
  if (value === undefined) return null;
  const row = object(value, "deployments policy");
  if (row.version !== 1) throw new Error("deployments must be version 1");
  const environments: Record<string, DeploymentEnvironment> = {};
  for (const [name, declared] of Object.entries(object(row.environments, "deployments environments"))) {
    if (!(DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(name)) throw new Error(`deployments declares unknown environment ${name}`);
    const environment = object(declared, `deployments environment ${name}`);
    const minIntervalMs = environment.minIntervalMs ?? HOUR;
    if (!Number.isInteger(minIntervalMs) || (minIntervalMs as number) < 0 || (minIntervalMs as number) > 24 * HOUR)
      throw new Error(`deployments ${name} minIntervalMs must be an integer from 0 to 86400000`);
    if (!Number.isInteger(environment.timeoutMs) || (environment.timeoutMs as number) < 1 || (environment.timeoutMs as number) > 1_800_000)
      throw new Error(`deployments ${name} timeoutMs must be an integer from 1 to 1800000`);
    if (!Array.isArray(environment.projects) || environment.projects.length === 0) throw new Error(`deployments ${name} declares no projects`);
    const projects = environment.projects.map((project): DeploymentProject => {
      const entry = object(project, `deployments ${name} project`);
      if (typeof entry.name !== "string" || !NAME.test(entry.name)) throw new Error(`deployments ${name} has a project without a valid name`);
      return { name: entry.name, command: command(entry.command, "Deployment") };
    });
    if (new Set(projects.map((project) => project.name)).size !== projects.length) throw new Error(`deployments ${name} names a project twice`);
    environments[name] = {
      minIntervalMs: minIntervalMs as number, timeoutMs: environment.timeoutMs as number,
      environmentKeys: environmentKeys(environment, "Deployment"), projects,
    };
  }
  return { version: 1, environments };
}
