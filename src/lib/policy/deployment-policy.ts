import { command, environmentKeys } from "./post-integration-policy.ts";
import type { FinalizationCommand } from "./post-integration-policy.ts";

/**
 * One deployed project of an environment: its name in deploy records and the command that
 * deploys it. `healthCheck` then runs against the deployment (`SLIPJAY_DEPLOY_URL`); a
 * failing check fails the project. An environment whose projects declare `activate`
 * deploys without taking traffic: only once every project deployed and passed its check
 * does `activate` move each one's traffic to its deployment (`SLIPJAY_DEPLOY_URL`), and
 * if one activation fails, the projects already moved are activated back on the
 * deployment they served before.
 */
export type DeploymentProject = { name: string; command: FinalizationCommand; healthCheck?: FinalizationCommand; activate?: FinalizationCommand };

/**
 * One environment the runner deploys. `staging` follows the integration branch: the
 * runner deploys its latest landed commit after landings, at most once per
 * `minIntervalMs`, plus on demand. Any other environment follows it the same way, and says so
 * (`followsIntegrationBranch: true`), so a misspelt `staging` is refused rather than deployed. `production` does not follow the integration branch: it
 * deploys only through a promotion (`slipjay promote`), so its `minIntervalMs` is unused, and must activate, so a failed promotion can be rolled back.
 * Each project's command runs in an exact source view
 * of the deployed commit, with the declared `environmentKeys` and
 * `SLIPJAY_DEPLOY_ENVIRONMENT`/`SLIPJAY_DEPLOY_COMMIT`; the last line it prints that is a
 * URL is recorded as the project's deployment.
 */
export type DeploymentEnvironment = {
  minIntervalMs: number;
  timeoutMs: number;
  environmentKeys: string[];
  projects: DeploymentProject[];
  /** Production only: how the runner brings the database to the deployed commit (see `DeploymentMigrations`). */
  migrations?: DeploymentMigrations;
  /**
   * A build machine pool: the runner leases the repository's machine of this pool for the whole deploy (see
   * `MachineLease`), holding the deployed commit, and every command reaches it through `SLIPJAY_MACHINE_SSH`.
   */
  machine?: string;
};

/**
 * How a promotion migrates production, in the same source view and environment as the
 * projects: before any project deploys when its known migration files are all additive,
 * otherwise once every project deployed and passed its check, before any activates.
 * `verify` exits 0 when the database matches the commit, 2 when the commit's migrations
 * are pending (the only case `apply` runs), and anything else to refuse; after `apply`,
 * `verify` must exit 0.
 */
export type DeploymentMigrations = { verify: FinalizationCommand; apply: FinalizationCommand };

export type DeploymentPolicy = { version: 1; environments: Record<string, DeploymentEnvironment> };

/** Environments the runner knows how to drive; production deploys only through promotion (#32). */
export const DEPLOYMENT_ENVIRONMENTS = ["staging", "production"] as const;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
/** A machine pool's name: never a number, so it cannot be taken for a gate slot's VM. */
const MACHINE = /^[a-z][a-z0-9-]{0,29}$/;
const HOUR = 3_600_000;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}

function machineName(value: unknown, environment: string): string {
  if (typeof value !== "string" || !MACHINE.test(value)) throw new Error(`deployments ${environment} names a machine that is not a pool name (a-z, 0-9, -)`);
  return value;
}

/** `deployments`: strict, so a typo never silently stops an environment deploying. */
export function deploymentPolicy(value: unknown): DeploymentPolicy | null {
  if (value === undefined) return null;
  const row = object(value, "deployments policy");
  if (row.version !== 1) throw new Error("deployments must be version 1");
  const environments: Record<string, DeploymentEnvironment> = {};
  for (const [name, declared] of Object.entries(object(row.environments, "deployments environments"))) {
    const environment = object(declared, `deployments environment ${name}`);
    if (!(DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(name) && !(NAME.test(name) && environment.followsIntegrationBranch === true))
      throw new Error(`deployments declares unknown environment ${name}; another environment that follows the integration branch declares followsIntegrationBranch: true`);
    const minIntervalMs = environment.minIntervalMs ?? HOUR;
    if (!Number.isInteger(minIntervalMs) || (minIntervalMs as number) < 0 || (minIntervalMs as number) > 24 * HOUR)
      throw new Error(`deployments ${name} minIntervalMs must be an integer from 0 to 86400000`);
    if (!Number.isInteger(environment.timeoutMs) || (environment.timeoutMs as number) < 1 || (environment.timeoutMs as number) > 1_800_000)
      throw new Error(`deployments ${name} timeoutMs must be an integer from 1 to 1800000`);
    if (!Array.isArray(environment.projects) || environment.projects.length === 0) throw new Error(`deployments ${name} declares no projects`);
    const projects = environment.projects.map((project): DeploymentProject => {
      const entry = object(project, `deployments ${name} project`);
      if (typeof entry.name !== "string" || !NAME.test(entry.name)) throw new Error(`deployments ${name} has a project without a valid name`);
      return { name: entry.name, command: command(entry.command, "Deployment"),
        ...entry.healthCheck === undefined ? {} : { healthCheck: command(entry.healthCheck, "Health check") },
        ...entry.activate === undefined ? {} : { activate: command(entry.activate, "Activation") } };
    });
    if (new Set(projects.map((project) => project.name)).size !== projects.length) throw new Error(`deployments ${name} names a project twice`);
    // Activation is all or nothing: a project that took traffic on deploy could not be held back.
    if (projects.some((project) => project.activate) && !projects.every((project) => project.activate))
      throw new Error(`deployments ${name} declares activate for some projects but not all`);
    // A failed promotion is rolled back by never moving traffic, so production must control it.
    if (name === "production" && !projects.every((project) => project.activate))
      throw new Error("deployments production must declare activate for every project");
    let migrations: DeploymentMigrations | undefined;
    if (environment.migrations !== undefined) {
      // Staging runs on a database landing already migrates.
      if (name !== "production") throw new Error(`deployments ${name} declares migrations; only production migrates on deploy`);
      const declared = object(environment.migrations, "deployments production migrations");
      migrations = { verify: command(declared.verify, "Migration verify"), apply: command(declared.apply, "Migration apply") };
    }
    environments[name] = {
      minIntervalMs: minIntervalMs as number, timeoutMs: environment.timeoutMs as number,
      environmentKeys: environmentKeys(environment, "Deployment"), projects, ...migrations ? { migrations } : {},
      ...environment.machine === undefined ? {} : { machine: machineName(environment.machine, name) },
    };
  }
  return { version: 1, environments };
}
