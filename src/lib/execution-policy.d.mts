import type { VerificationDeclaration } from "./verification-policy.mjs";
import type { PostLandCheck } from "./post-land-verification.mjs";

export type MigrationCommand = { executable: string; args: string[]; cwd: string | null };
export type MigrationFinalizationPolicy = {
  mode: "late_bound_serialized";
  triggerPaths: string[];
  artifactPaths: string[];
  generate: MigrationCommand;
  verify: MigrationCommand;
};
/** A parsed version-1 policy: landing sections normalized, every other declaration kept as declared. */
export type ExecutionPolicy = {
  [key: string]: unknown;
  version: 1;
  integrationBranch?: string;
  remote: string | null;
  parallelExecution: boolean;
  requiredLocalVerification: VerificationDeclaration[];
  /** The branch `slipjay release` promotes the integration branch to. */
  releaseBranch?: string;
  /** Checks the exact release candidate must pass; undefined when undeclared. */
  requiredReleaseVerification?: VerificationDeclaration[];
  postLandVerification: PostLandCheck[];
  migrationFinalization: MigrationFinalizationPolicy | null;
  /** Run in a workspace (cwd = its path) before it is removed; undefined when undeclared. */
  workspaceTeardown?: { executable: string; args: string[] };
  generatedPaths?: unknown;
  /** Repository-relative directories each workspace links to the same path in the primary checkout. */
  sharedPaths?: string[];
  /** How many prepared spare workspaces the pool keeps; 1 when undeclared. */
  spares?: number;
  postIntegration?: unknown;
  postRelease?: unknown;
};
export type IntegrationBranchProbes = {
  originHead?: () => Promise<string | null>;
  exists: (branch: string) => Promise<boolean>;
};

export const EXECUTION_POLICY_PATH: "slipjay.json";
export const RETIRED_EXECUTION_POLICY_PATH: "slipway.json";
export const EXECUTION_POLICY_PROBE_PATHS: readonly ["slipjay.json", "slipway.json"];
export function retiredExecutionPolicyError(location: string): Error & { code: "SLIPJAY_RETIRED_POLICY_PATH" };
export function selectExecutionPolicyPath(exists: (path: string) => Promise<boolean>, location: string): Promise<string | null>;
export const SAFE_BRANCH: RegExp;
export const UNDECLARED_POLICY: Readonly<Pick<ExecutionPolicy, "requiredLocalVerification" | "postLandVerification" | "remote" | "parallelExecution" | "migrationFinalization">>;
export function parseExecutionPolicy(raw: string, path?: string): ExecutionPolicy;
export function readExecutionPolicy(root: string): Promise<ExecutionPolicy | null>;
export function readExecutionPolicyAtCommit(repo: string, revision: string): Promise<{ commitId: string; policy: ExecutionPolicy | null }>;
export function sharedPathList(declared: unknown): string[];
export const DEFAULT_SPARES: 1;
export function spareCount(declared: unknown): number;
export function generatedPathMatchers(declared: unknown): RegExp[];
export function resolveIntegrationBranch(input: { declared?: string | null } & IntegrationBranchProbes): Promise<string | null>;
export function jjIntegrationProbes(repo: string): Required<IntegrationBranchProbes>;
export function readIntegrationPolicy(repo: string, options?: { hintRoot?: string }): Promise<{ integrationBranch: string; commitId: string; policy: ExecutionPolicy | null }>;
