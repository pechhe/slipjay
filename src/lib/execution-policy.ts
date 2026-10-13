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
  parallelExecution: boolean;
  requiredLandingVerification: VerificationDeclaration[];
  /** The branch `slipjay release` promotes the integration branch to. */
  releaseBranch?: string;
  /** Checks the exact release candidate must pass; undefined when undeclared. */
  requiredReleaseVerification?: VerificationDeclaration[];
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

/**
 * The one reader of a repository's policy, `slipjay.json` at its root (a repository
 * governed only by Slipway's retired `slipway.json` is refused): strict parsing, reading
 * from a checkout or an exact revision, and integration-branch resolution
 * (declared → origin/HEAD → main → master). Landing reads the policy committed on
 * the integration bookmark, never the primary checkout's working files.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { postIntegrationPolicy, postReleasePolicy } from "./post-integration-policy.ts";
import { declaredPublicationRemote } from "./source-publication-policy.ts";
import { normalizeVerificationDeclaration } from "./verification-policy.ts";
import { runWorkspaceCommand } from "./workspace-command.ts";

export const EXECUTION_POLICY_PATH: "slipjay.json" = "slipjay.json";
/** Slipway's policy path. Never read: a repository governed only by it is refused. */
export const RETIRED_EXECUTION_POLICY_PATH: "slipway.json" = "slipway.json";
/** Paths to probe for a policy: `slipjay.json` governs; the retired path alone is refused. */
export const EXECUTION_POLICY_PROBE_PATHS: readonly ["slipjay.json", "slipway.json"] = Object.freeze([EXECUTION_POLICY_PATH, RETIRED_EXECUTION_POLICY_PATH]);
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

/** The refusal for a repository (`location`: a checkout or its `.git` directory) governed only by the retired path. */
export function retiredExecutionPolicyError(location: string): Error & { code: "SLIPJAY_RETIRED_POLICY_PATH" };
export function retiredExecutionPolicyError(location: string): Error & { code?: "SLIPJAY_RETIRED_POLICY_PATH" } {
  const where = String(location).replace(/\/\.git\/?$/, "");
  const error: Error & { code?: "SLIPJAY_RETIRED_POLICY_PATH" } = new Error(`${RETIRED_EXECUTION_POLICY_PATH} is no longer read (since SlipJay v2.0.0); rename it to ${EXECUTION_POLICY_PATH} at the repository root (${where})`);
  error.code = "SLIPJAY_RETIRED_POLICY_PATH";
  return error;
}

/**
 * The policy path that governs, given a probe of which paths exist: `slipjay.json`,
 * else null. A repository with only the retired path is refused.
 */
export async function selectExecutionPolicyPath(exists: (path: string) => Promise<boolean>, location: string): Promise<string | null> {
  if (await exists(EXECUTION_POLICY_PATH)) return EXECUTION_POLICY_PATH;
  if (await exists(RETIRED_EXECUTION_POLICY_PATH)) throw retiredExecutionPolicyError(location);
  return null;
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
 * escape or be ambiguous fails closed.
 */
export function generatedPathMatchers(declared: unknown): RegExp[] {
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) fail("generatedPaths must be an array of repository-relative paths");
  return declared.map((entry) => {
    const segments = typeof entry === "string" ? entry.split("/") : [];
    if (!segments.length || entry.startsWith("/") || entry.includes("\\") || entry.includes("\0")
      || segments.some((segment) => !segment || segment === "." || segment === ".." || (segment.includes("**") && segment !== "**"))
      || segments.every((segment) => /^\**$/.test(segment))) {
      fail(`generatedPaths entry ${JSON.stringify(entry)} must be a specific repository-relative path without '.', '..', or empty segments`);
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

/**
 * `slipjay release`'s declaration: the branch the integration branch is promoted to
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
 * other declaration (`postIntegration`, `postRelease`, `generatedPaths`, `sourcePublication`,
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
  if (parsed.postRelease !== undefined && parsed.releaseBranch == null) fail("declares postRelease without a releaseBranch");
  postReleasePolicy(parsed.postRelease);
  generatedPathMatchers(parsed.generatedPaths);
  const sharedPaths = sharedPathList(parsed.sharedPaths);
  const spares = spareCount(parsed.spares);
  return {
    ...parsed,
    version: 1,
    integrationBranch: (parsed.integrationBranch as string | null | undefined) ?? undefined,
    remote: declaredPublicationRemote(parsed),
    parallelExecution: parsed.parallelExecution === true,
    requiredLandingVerification: landingGate(parsed),
    ...releasePolicy(parsed),
    migrationFinalization: migrationFinalization(parsed.migrationFinalization),
    workspaceTeardown: workspaceTeardown(parsed.workspaceTeardown),
    ...(parsed.sharedPaths === undefined ? {} : { sharedPaths }),
    ...(parsed.spares === undefined ? {} : { spares }),
  };
}

/** The landing configuration of a repository that declares no policy. */
export const UNDECLARED_POLICY: Readonly<Pick<ExecutionPolicy, "requiredLandingVerification" | "remote" | "parallelExecution" | "migrationFinalization">> = Object.freeze({ requiredLandingVerification: [], remote: null, parallelExecution: false, migrationFinalization: null });

/** The policy in a checkout's working files, or null when it declares none. */
export async function readExecutionPolicy(root: string): Promise<ExecutionPolicy | null> {
  const texts = new Map<string, string>();
  const exists = async (candidate: string) => readFile(join(root, candidate), "utf8").then((raw) => { texts.set(candidate, raw); return true; },
    (error: unknown) => { if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return false; throw error; });
  const found = await selectExecutionPolicyPath(exists, root);
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
  const shown = new Map<string, string>();
  const exists = async (candidate: string) => {
    const result = await jjRead(repo, ["file", "show", "-r", commitId, `root-file:${symbol(candidate)}`]);
    if (result.code === 0) { shown.set(candidate, result.stdout); return true; }
    if (/No such path/i.test(result.stderr)) return false;
    throw new Error(`Could not read ${candidate} at ${commitId}: ${result.stderr.trim()}`);
  };
  const found = await selectExecutionPolicyPath(exists, repo);
  if (found) return { commitId, policy: parseExecutionPolicy(shown.get(found)!, found) };
  return { commitId, policy: null };
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
 */
export async function readIntegrationPolicy(repo: string, { hintRoot }: { hintRoot?: string } = {}): Promise<{ integrationBranch: string; commitId: string; policy: ExecutionPolicy | null }> {
  const probes = jjIntegrationProbes(repo);
  let fallback: { branch: string | null } | undefined;
  const undeclared = async () => (fallback ??= { branch: await resolveIntegrationBranch(probes) }).branch;
  const hint = hintRoot ? (await readExecutionPolicy(hintRoot).catch(() => null))?.integrationBranch : undefined;
  const start = hint && await probes.exists(hint) ? hint : await undeclared();
  if (!start) throw new Error("Could not resolve an integration bookmark (tried the declared branch, origin/HEAD, main and master)");
  const first = await readExecutionPolicyAtCommit(repo, start);
  const target = first.policy?.integrationBranch ?? await undeclared();
  if (target === start) return { integrationBranch: start, ...first };
  if (!target || !await probes.exists(target)) throw new Error(`Configured integration bookmark '${target}' does not exist locally`);
  const second = await readExecutionPolicyAtCommit(repo, target);
  const confirmed = second.policy?.integrationBranch ?? await undeclared();
  if (confirmed !== target) {
    throw new Error(`Integration policy drift: '${start}' declares '${target}', whose committed policy resolves to '${confirmed}'`);
  }
  return { integrationBranch: target, ...second };
}
