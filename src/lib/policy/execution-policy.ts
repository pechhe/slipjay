import type { DeploymentPolicy } from "./deployment-policy.ts";
import type { ResetPolicy } from "./post-integration-policy.ts";
import type { VerificationDeclaration } from "./verification-policy.ts";
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
  requiredLandingVerification: VerificationDeclaration[];
  /** The branch `slipjay promote` promotes the integration branch to. */
  releaseBranch?: string;
  /** Checks the exact release candidate must pass; undefined when undeclared. */
  requiredReleaseVerification?: VerificationDeclaration[];
  migrationFinalization: MigrationFinalizationPolicy | null;
  /** Run in a workspace (cwd = its path) before it is removed; undefined when undeclared. */
  workspaceTeardown?: { executable: string; args: string[] };
  generatedPaths?: unknown;
  /** Paths of review, acceptance or recovery evidence that retiring a workspace preserves in the state home (see `preserveWorkspaceEvidence`). */
  evidencePaths?: unknown;
  /** Repository-relative directories each workspace links to the same path in the primary checkout. */
  sharedPaths?: string[];
  /** How many prepared spare workspaces the pool keeps; 1 when undeclared. */
  spares?: number;
  /** How much process agents apply to the repository's work; `standard` when undeclared. SlipJay only reports it. */
  process?: ProcessLevel;
  postIntegration?: unknown;
  /** The target the runner resets on a schedule and on demand; undefined when undeclared. */
  reset?: ResetPolicy;
  /** Environments the runner deploys; undefined when undeclared. */
  deployments?: DeploymentPolicy;
  /** Where the repository's work is tracked (see `tracker.ts`); GitHub Issues when undeclared. */
  tracker?: "github" | "build";
};

export type ProcessLevel = "standard" | "light";

export type IntegrationBranchProbes = {
  originHead?: () => Promise<string | null>;
  exists: (branch: string) => Promise<boolean>;
};

/**
 * The one reader of a repository's policy, `slipjay.json` at its root: strict parsing, reading
 * from a checkout or an exact revision, and integration-branch resolution
 * (declared → origin/HEAD → main → master). Landing reads the policy committed on
 * the integration bookmark, never the primary checkout's working files.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deploymentPolicy } from "./deployment-policy.ts";
import { postIntegrationPolicy, resetPolicy } from "./post-integration-policy.ts";
import { declaredPublicationRemote } from "./source-publication-policy.ts";
import { normalizeVerificationDeclaration } from "./verification-policy.ts";
import { runWorkspaceCommand } from "../infra/workspace-command.ts";

export const EXECUTION_POLICY_PATH: "slipjay.json" = "slipjay.json";
/** The canonical policy is the only repository configuration path. */
export const EXECUTION_POLICY_PROBE_PATHS: readonly ["slipjay.json"] = Object.freeze([EXECUTION_POLICY_PATH]);
const POLICY_BYTES = 64 * 1024;
const MAX_CHECKS = 20;
const MAX_ARGS = 100;
const MAX_ARG_LENGTH = 32_000;
/** A bookmark name that cannot be read as an option, a revset operator or a range. */
export const SAFE_BRANCH: RegExp = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const EXECUTABLE = /^[A-Za-z0-9._+-]+$/;
/** A landing gate runs a named tool, never a shell or the VCS it is guarding. */
const FORBIDDEN_GATE_EXECUTABLES = new Set(["bash", "sh", "zsh", "fish", "pwsh", "powershell", "git", "jj"]);
const FALLBACK_BRANCHES = ["main", "master"];

// Parsing is synchronous, so the file being parsed can name itself in every failure.
let policyLabel: string = EXECUTION_POLICY_PATH;
const fail: (message: string) => never = (message) => { throw new Error(`${policyLabel} ${message}`); };

/** The canonical policy path when present, otherwise no declared policy. */
export async function selectExecutionPolicyPath(exists: (path: string) => Promise<boolean>): Promise<string | null> {
  return await exists(EXECUTION_POLICY_PATH) ? EXECUTION_POLICY_PATH : null;
}
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A repository-relative directory that stays inside the checkout (lexically; runners re-check the real path). */
function containedCwd(value: unknown, field: string): void {
  if (typeof value !== "string" || !value.trim() || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\0")
    || value.split(/[\\/]/).includes("..")) fail(`${field} must be a relative path inside the checkout`);
}

function gateCommand(command: VerificationDeclaration, field: string): void {
  if (!EXECUTABLE.test(command.executable)) fail(`${field}.executable must be a bare executable name`);
  if (FORBIDDEN_GATE_EXECUTABLES.has(command.executable.toLowerCase())) fail(`${field}.executable is unsafe for a landing gate`);
  if (command.args.length > MAX_ARGS) fail(`${field}.args must contain at most ${MAX_ARGS} entries`);
  if (command.args.some((arg) => arg.length > MAX_ARG_LENGTH)) fail(`${field}.args entries must be at most ${MAX_ARG_LENGTH} characters`);
  if (command.cwd !== undefined) containedCwd(command.cwd, `${field}.cwd`);
}

/** The landing gate. Its former name is refused, so a stale policy never lands with an empty gate. */
function landingGate(parsed: Record<string, unknown>): VerificationDeclaration[] {
  if (parsed.requiredLocalVerification !== undefined)
    fail("declares requiredLocalVerification, the gate's former name; rename it requiredLandingVerification");
  return gateChecks(parsed.requiredLandingVerification);
}

/** Declared gate checks (landing's in exactly the shape the verification digest has always covered). */
function gateChecks(value: unknown, name = "requiredLandingVerification"): VerificationDeclaration[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_CHECKS) fail(`${name} must be a list of at most ${MAX_CHECKS} commands`);
  return value.map((entry, index) => {
    const field = `${name}[${index}]`;
    const check = normalizeVerificationDeclaration(entry, field);
    gateCommand(check, field);
    if (check.capability) gateCommand(check.capability.probe, `${field}.capability.probe`);
    return check;
  });
}

const migrationPath = (value: unknown): string => {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/")
    || value.split("/").some((part) => !part || part === "." || part === ".."))
    fail("migrationFinalization declares an unsafe path");
  return value;
};
const migrationPaths = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || !value.length || value.length > 50) fail(`migrationFinalization.${field} must list 1-50 paths`);
  return [...new Set(value.map(migrationPath))];
};
const migrationCommand = (value: unknown, field: string): MigrationCommand => {
  if (!isObject(value) || typeof value.executable !== "string" || !EXECUTABLE.test(value.executable)
    || !Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string" || arg.length > MAX_ARG_LENGTH))
    fail(`migrationFinalization.${field} is not a safe command`);
  return { executable: value.executable, args: [...(value.args as string[])], cwd: value.cwd == null ? null : migrationPath(value.cwd) };
};

function migrationFinalization(value: unknown): MigrationFinalizationPolicy | null {
  if (value == null) return null;
  if (!isObject(value) || value.mode !== "late_bound_serialized") fail("migrationFinalization.mode must be late_bound_serialized");
  return { mode: value.mode, triggerPaths: migrationPaths(value.triggerPaths, "triggerPaths"),
    artifactPaths: migrationPaths(value.artifactPaths, "artifactPaths"),
    generate: migrationCommand(value.generate, "generate"), verify: migrationCommand(value.verify, "verify") };
}

/** `workspaceTeardown`: a bare executable and its args, run with the workspace as cwd before it is removed. */
function workspaceTeardown(value: unknown): { executable: string; args: string[] } | undefined {
  if (value == null) return undefined;
  if (!isObject(value) || typeof value.executable !== "string" || !EXECUTABLE.test(value.executable)
    || !Array.isArray(value.args ?? []) || (value.args as unknown[] ?? []).length > MAX_ARGS
    || (value.args as unknown[] ?? []).some((arg) => typeof arg !== "string" || arg.length > MAX_ARG_LENGTH))
    fail("workspaceTeardown must be { executable: <bare name>, args?: string[] }");
  return { executable: value.executable, args: [...(value.args as string[] ?? [])] };
}

/**
 * Compile a repository's `generatedPaths` declaration: repository-relative paths or
 * globs (`*` within one segment, `**` across segments) of generated output that
 * cleanup may discard. A match also covers everything below it. Anything that could
 * escape or be ambiguous fails closed. `evidencePaths` (evidence retirement preserves)
 * uses the same form.
 */
export function generatedPathMatchers(declared: unknown, key: "generatedPaths" | "evidencePaths" = "generatedPaths"): RegExp[] {
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) fail(`${key} must be an array of repository-relative paths`);
  return declared.map((entry) => {
    const segments = typeof entry === "string" ? entry.split("/") : [];
    if (!segments.length || entry.startsWith("/") || entry.includes("\\") || entry.includes("\0")
      || segments.some((segment) => !segment || segment === "." || segment === ".." || (segment.includes("**") && segment !== "**"))
      || segments.every((segment) => /^\**$/.test(segment))) {
      fail(`${key} entry ${JSON.stringify(entry)} must be a specific repository-relative path without '.', '..', or empty segments`);
    }
    const pattern = segments.map((segment) => segment === "**" ? "(?:[^/]+/)*"
      : `${segment.split("*").map((part) => part.replace(/[.+?^${}()|[\]]/g, "\\$&")).join("[^/]*")}/`).join("");
    return new RegExp(`^${pattern}$`); // tested against `path/`
  });
}

const MAX_SHARED_PATHS = 20;
const MAX_SPARES = 8;
/** How many spares the pool keeps when `spares` is undeclared. */
export const DEFAULT_SPARES: 1 = 1;

/**
 * `sharedPaths`: repository-relative directories every workspace links to the same
 * path in the primary checkout (for git-ignored output that must outlive a
 * workspace, such as `artifacts/`). Specific literal paths only, none inside
 * another, none in `.jj`/`.git`.
 */
export function sharedPathList(declared: unknown): string[] {
  if (declared === undefined) return [];
  if (!Array.isArray(declared) || declared.length > MAX_SHARED_PATHS) fail(`sharedPaths must be an array of at most ${MAX_SHARED_PATHS} repository-relative directory paths`);
  const paths = [...new Set(declared.map((entry) => {
    const segments = typeof entry === "string" ? entry.replace(/\/+$/, "").split("/") : [];
    if (!segments.length || entry.startsWith("/") || entry.includes("\\") || entry.includes("\0")
      || segments.some((segment) => !segment || segment === "." || segment === ".." || /[*?[\]{}]/.test(segment))
      || [".jj", ".git"].includes(segments[0]!)) {
      fail(`sharedPaths entry ${JSON.stringify(entry)} must be a literal repository-relative directory without '.', '..', globs or empty segments, outside .jj and .git`);
    }
    return segments.join("/");
  }))];
  for (const path of paths) {
    if (paths.some((other) => other !== path && path.startsWith(`${other}/`))) fail(`sharedPaths entry ${JSON.stringify(path)} is inside another entry`);
  }
  return paths;
}

/** `spares`: how many prepared spare workspaces the pool keeps (default `DEFAULT_SPARES`, at most 8; 0 disables the pool). */
export function spareCount(declared: unknown): number {
  if (declared === undefined) return DEFAULT_SPARES;
  if (!Number.isInteger(declared) || (declared as number) < 0 || (declared as number) > MAX_SPARES) fail(`spares must be an integer from 0 to ${MAX_SPARES}`);
  return declared as number;
}

/** `process`: `standard` (the default) or `light`. */
export function processLevel(declared: unknown): ProcessLevel {
  if (declared === undefined) return "standard";
  if (declared !== "standard" && declared !== "light") fail('process must be "standard" or "light"');
  return declared;
}

/** Declarations that drive nothing: a policy still declaring them loads, and `land` and `policy show` warn of them. */
export const RETIRED_POLICY_FIELDS: readonly ["parallelExecution", "unattendedMergeToIntegration"] = Object.freeze(["parallelExecution", "unattendedMergeToIntegration"]);

/** The one-line warning for a policy that declares retired fields, or null when it declares none. */
export function retiredFieldsWarning(policy: Record<string, unknown> | null | undefined): string | null {
  const retired = RETIRED_POLICY_FIELDS.filter((field) => policy?.[field] !== undefined);
  if (!retired.length) return null;
  const them = retired.length === 1 ? "it" : "them";
  return `${EXECUTION_POLICY_PATH} declares ${retired.join(" and ")}, which ${retired.length === 1 ? "drives" : "drive"} nothing; remove ${them} (slipjay policy set drops ${them})`;
}

/**
 * `slipjay promote`'s declaration: the branch the integration branch is promoted to
 * and the checks the exact candidate commit must pass first. A release branch with
 * no declared checks is refused at release time, so an empty list must be explicit.
 */
function releasePolicy(parsed: Record<string, unknown>): Pick<ExecutionPolicy, "releaseBranch" | "requiredReleaseVerification"> {
  if (parsed.releaseBranch == null) {
    if (parsed.requiredReleaseVerification != null) fail("declares requiredReleaseVerification without a releaseBranch");
    return { releaseBranch: undefined, requiredReleaseVerification: undefined };
  }
  if (typeof parsed.releaseBranch !== "string" || !SAFE_BRANCH.test(parsed.releaseBranch)) fail("declares an unsafe releaseBranch");
  if (parsed.releaseBranch === (parsed.integrationBranch ?? null)) fail("releaseBranch must differ from integrationBranch");
  return {
    releaseBranch: parsed.releaseBranch,
    requiredReleaseVerification: parsed.requiredReleaseVerification == null ? undefined
      : gateChecks(parsed.requiredReleaseVerification, "requiredReleaseVerification"),
  };
}

/**
 * Parse a policy file's text strictly. Landing's sections are normalized; every
 * other declaration (`postIntegration`, `generatedPaths`, `sourcePublication`,
 * `requiredChecks`, …) is kept as declared, after validation where Peach owns it.
 */
export function parseExecutionPolicy(raw: string, path: string = EXECUTION_POLICY_PATH): ExecutionPolicy {
  const previous = policyLabel;
  policyLabel = path;
  try { return parsePolicyText(raw); } finally { policyLabel = previous; }
}

function parsePolicyText(raw: string): ExecutionPolicy {
  if (typeof raw !== "string") fail("must be text");
  if (Buffer.byteLength(raw, "utf8") > POLICY_BYTES) fail("exceeds the 64 KiB policy budget");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { fail("is not valid JSON"); }
  if (!isObject(parsed) || parsed.version !== 1) fail("must be a version-1 policy");
  if (parsed.integrationBranch != null && (typeof parsed.integrationBranch !== "string" || !SAFE_BRANCH.test(parsed.integrationBranch)))
    fail("declares an unsafe integrationBranch");
  if (parsed.projectCode != null && (typeof parsed.projectCode !== "string" || !/^[a-z0-9]{2,8}$/.test(parsed.projectCode)))
    fail("declares a projectCode that is not 2-8 lowercase letters or digits");
  // Refused, not ignored: a declared check that silently stopped running would read as passing.
  if (parsed.postLandVerification !== undefined) fail("declares postLandVerification, which is no longer run; move its checks into requiredLandingVerification or remove it");
  postIntegrationPolicy(parsed.postIntegration);
  if (parsed.postRelease !== undefined) fail("declares postRelease, which no longer runs at promotion; declare it as reset with an intervalMs (see README)");
  if (parsed.reset !== undefined && parsed.integrationBranch == null) fail("declares reset without an integrationBranch");
  const reset = resetPolicy(parsed.reset);
  const deployments = deploymentPolicy(parsed.deployments);
  if (parsed.tracker !== undefined && parsed.tracker !== "github" && parsed.tracker !== "build") fail('declares a tracker other than "github" or "build"');
  generatedPathMatchers(parsed.generatedPaths);
  generatedPathMatchers(parsed.evidencePaths, "evidencePaths");
  const sharedPaths = sharedPathList(parsed.sharedPaths);
  const spares = spareCount(parsed.spares);
  const level = processLevel(parsed.process);
  return {
    ...parsed,
    version: 1,
    integrationBranch: (parsed.integrationBranch as string | null | undefined) ?? undefined,
    remote: declaredPublicationRemote(parsed),
    requiredLandingVerification: landingGate(parsed),
    ...releasePolicy(parsed),
    migrationFinalization: migrationFinalization(parsed.migrationFinalization),
    workspaceTeardown: workspaceTeardown(parsed.workspaceTeardown),
    ...(parsed.sharedPaths === undefined ? {} : { sharedPaths }),
    ...(parsed.spares === undefined ? {} : { spares }),
    ...(parsed.process === undefined ? {} : { process: level }),
    ...(deployments ? { deployments } : {}),
    ...(reset ? { reset } : {}),
  };
}

/** The landing configuration of a repository that declares no policy. */
export const UNDECLARED_POLICY: Readonly<Pick<ExecutionPolicy, "requiredLandingVerification" | "remote" | "migrationFinalization">> = Object.freeze({ requiredLandingVerification: [], remote: null, migrationFinalization: null });

/** The policy in a checkout's working files, or null when it declares none. */
export async function readExecutionPolicy(root: string): Promise<ExecutionPolicy | null> {
  const texts = new Map<string, string>();
  const exists = async (candidate: string) => readFile(join(root, candidate), "utf8").then((raw) => { texts.set(candidate, raw); return true; },
    (error: unknown) => { if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return false; throw error; });
  const found = await selectExecutionPolicyPath(exists);
  return found ? parseExecutionPolicy(texts.get(found)!, found) : null;
}

const jjRead = (repo: string, args: string[]) => runWorkspaceCommand("jj", ["--color=never", "--ignore-working-copy", ...args], { cwd: repo });
const symbol = (name: string): string => JSON.stringify(name);

async function commitOf(repo: string, revision: string): Promise<string | null> {
  const result = await jjRead(repo, ["log", "--no-graph", "-r", symbol(revision), "-T", "commit_id"]);
  const commitId = result.stdout.trim();
  return result.code === 0 && /^[a-f0-9]{40,64}$/.test(commitId) ? commitId : null;
}

/**
 * The policy committed at a bookmark or commit id of a JJ repository (`repo` is any
 * of its checkouts), never that checkout's working files.
 */
export async function readExecutionPolicyAtCommit(repo: string, revision: string): Promise<{ commitId: string; policy: ExecutionPolicy | null }> {
  const commitId = await commitOf(repo, revision);
  if (!commitId) throw new Error(`Revision '${revision}' does not exist`);
  return policyAtCommitId(repo, commitId);
}

/** `readExecutionPolicyAtCommit` for a revision already resolved to its commit id. */
async function policyAtCommitId(repo: string, commitId: string): Promise<{ commitId: string; policy: ExecutionPolicy | null }> {
  const text = await readPolicyTextAtCommit(repo, commitId);
  return { commitId, policy: text === null ? null : parseExecutionPolicy(text, EXECUTION_POLICY_PATH) };
}

/** The policy file's text committed at a resolved commit id, or null when that commit declares none. */
export async function readPolicyTextAtCommit(repo: string, commitId: string): Promise<string | null> {
  const shown = new Map<string, string>();
  const exists = async (candidate: string) => {
    const result = await jjRead(repo, ["file", "show", "-r", commitId, `root-file:${symbol(candidate)}`]);
    if (result.code === 0) { shown.set(candidate, result.stdout); return true; }
    if (/No such path/i.test(result.stderr)) return false;
    throw new Error(`Could not read ${candidate} at ${commitId}: ${result.stderr.trim()}`);
  };
  const found = await selectExecutionPolicyPath(exists);
  return found ? shown.get(found)! : null;
}

/**
 * D4: the declared branch, else the remote's default (`origin/HEAD`), else `main`,
 * else `master`. Probes are injected so Git-only setup and JJ checkouts share the
 * order. Null when nothing resolves.
 */
export async function resolveIntegrationBranch({ declared, originHead = async () => null, exists }: { declared?: string | null } & IntegrationBranchProbes): Promise<string | null> {
  if (declared != null) {
    if (typeof declared !== "string" || !SAFE_BRANCH.test(declared)) fail("declares an unsafe integrationBranch");
    return declared;
  }
  const head = await originHead();
  if (typeof head === "string" && SAFE_BRANCH.test(head) && await exists(head)) return head;
  for (const candidate of FALLBACK_BRANCHES) if (await exists(candidate)) return candidate;
  return null;
}

/** origin/HEAD and local-bookmark probes for a JJ repository. */
export function jjIntegrationProbes(repo: string): Required<IntegrationBranchProbes> {
  return {
    originHead: async () => {
      const root = await jjRead(repo, ["git", "root"]);
      if (root.code !== 0) return null;
      const head = await runWorkspaceCommand("git", ["--git-dir", root.stdout.trim(), "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repo });
      return head.code === 0 ? head.stdout.trim().replace(/^origin\//, "") || null : null;
    },
    exists: async (name: string) => await commitOf(repo, name) !== null,
  };
}

/**
 * The integration bookmark and the policy committed on it (D3). The checkout's
 * working policy (`hintRoot`) only suggests which bookmark to read first; the
 * committed policy decides, and a bookmark whose policy names another one is
 * followed once and must then name itself.
 * The runner opts into fetching and tracking a missing committed target;
 * ordinary callers remain read-only.
 */
export async function readIntegrationPolicy(repo: string, { hintRoot, fetchMissingBookmarks = false }: { hintRoot?: string; fetchMissingBookmarks?: boolean } = {}): Promise<{ integrationBranch: string; commitId: string; policy: ExecutionPolicy | null }> {
  const probes = jjIntegrationProbes(repo);
  let fallback: { branch: string | null } | undefined;
  const undeclared = async () => (fallback ??= { branch: await resolveIntegrationBranch(probes) }).branch;
  const hint = hintRoot ? (await readExecutionPolicy(hintRoot).catch(() => null))?.integrationBranch : undefined;
  // The hinted bookmark's commit, resolved once for both its existence and its policy.
  const hintCommit = hint ? await commitOf(repo, hint) : null;
  let start = hintCommit ? hint! : null;
  let revision = start;
  if (!start) {
    const head = await probes.originHead();
    if (head && SAFE_BRANCH.test(head)) {
      if (await probes.exists(head)) start = revision = head;
      else {
        // The remote default may remain after its local bookmark was deleted.
        // Use its exact committed policy to discover a local integration bookmark.
        const remote = await jjRead(repo, ["log", "--no-graph", "-r", `${symbol(head)}@${symbol("origin")}`, "-T", "commit_id"]);
        const commitId = remote.stdout.trim();
        if (remote.code === 0 && /^[a-f0-9]{40,64}$/.test(commitId)) {
          start = head;
          revision = commitId;
        }
      }
    }
    if (!start) start = revision = await undeclared();
  }
  if (!start || !revision) throw new Error("Could not resolve an integration bookmark (tried the declared branch, origin/HEAD, main and master)");
  const first = hintCommit ? await policyAtCommitId(repo, hintCommit) : await readExecutionPolicyAtCommit(repo, revision);
  const target = first.policy?.integrationBranch ?? await undeclared();
  if (target === start && revision === start) return { integrationBranch: start, ...first };
  if (target && !await probes.exists(target) && fetchMissingBookmarks) {
    const remote = first.policy?.remote ?? "origin";
    const fetched = await jjRead(repo, ["git", "fetch", "--remote", remote, "--branch", target]);
    if (fetched.code !== 0)
      throw new Error(`Configured integration bookmark '${target}' does not exist locally; could not fetch it from remote '${remote}': ${fetched.stderr.trim()}`);
    const found = await jjRead(repo, ["log", "--no-graph", "-r", `${symbol(target)}@${symbol(remote)}`, "-T", "commit_id"]);
    if (found.code !== 0 || !/^[a-f0-9]{40,64}$/.test(found.stdout.trim()))
      throw new Error(`Configured integration bookmark '${target}' does not exist locally or on remote '${remote}'`);
    const tracked = await jjRead(repo, ["bookmark", "track", `${target}@${remote}`]);
    if (tracked.code !== 0) throw new Error(`Could not track integration bookmark '${target}' from remote '${remote}': ${tracked.stderr.trim()}`);
  }
  if (!target || !await probes.exists(target)) throw new Error(`Configured integration bookmark '${target}' does not exist locally`);
  const second = await readExecutionPolicyAtCommit(repo, target);
  const confirmed = second.policy?.integrationBranch ?? await undeclared();
  if (confirmed !== target) {
    throw new Error(`Integration policy drift: '${start}' declares '${target}', whose committed policy resolves to '${confirmed}'`);
  }
  return { integrationBranch: target, ...second };
}
