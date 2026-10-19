/**
 * Settings changes to a repository's policy: the typed patch `slipjay policy set` applies,
 * and the runner's decision that a landing changes only those settings, so it lands
 * without running the landing checks (the settings fast path).
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { EXECUTION_POLICY_PATH, parseExecutionPolicy, RETIRED_POLICY_FIELDS } from "./execution-policy.ts";
import type { ExecutionPolicy } from "./execution-policy.ts";
import type { VerificationDeclaration } from "./verification-policy.ts";

/** The policy fields a settings change may set, each of which only the next landing or refill reads. */
export const SETTINGS_FIELDS: readonly ["spares", "process", "budgets", "requiredLandingVerification"] = Object.freeze(["spares", "process", "budgets", "requiredLandingVerification"]);
export type SettingsField = (typeof SETTINGS_FIELDS)[number];
/** A value sets the field; null removes it, restoring its default. */
export type PolicyPatch = Partial<Record<SettingsField, unknown>>;

/** The commit trailer naming the policy a patch was based on, so the runner refuses it once that policy has moved. */
export const POLICY_BASE_TRAILER = "Policy-Base";

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** JSON with object keys sorted, so equal declarations compare equal however the file orders them. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** The digest of a policy's declarations, independent of formatting and key order. */
export function policyDigest(text: string): string {
  return `sha256:${createHash("sha256").update(canonicalJson(JSON.parse(text))).digest("hex")}`;
}

/** A patch object as supplied, refused when it names anything outside the settings fields. */
export function parsePolicyPatch(value: unknown): PolicyPatch {
  if (!isObject(value) || !Object.keys(value).length) throw new Error(`A policy patch must be an object setting at least one of ${SETTINGS_FIELDS.join(", ")}`);
  const outside = Object.keys(value).filter((key) => !(SETTINGS_FIELDS as readonly string[]).includes(key));
  if (outside.length) throw new Error(`policy set changes only ${SETTINGS_FIELDS.join(", ")}; refused ${outside.join(", ")} (change other policy in a reviewed landing)`);
  return { ...value };
}

/**
 * The policy text with `patch` applied and the retired fields dropped, validated as a
 * landing would parse it. An existing field keeps its place; a new one goes last.
 */
export function applyPolicyPatch(text: string, patch: PolicyPatch): { text: string; policy: ExecutionPolicy } {
  const declared: unknown = JSON.parse(text);
  if (!isObject(declared)) throw new Error(`${EXECUTION_POLICY_PATH} is not a JSON object`);
  const next: Record<string, unknown> = { ...declared };
  for (const field of RETIRED_POLICY_FIELDS) delete next[field];
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) delete next[field];
    else next[field] = value;
  }
  const patched = `${JSON.stringify(next, null, 2)}\n`;
  return { text: patched, policy: parseExecutionPolicy(patched) };
}

/** The settings fields (and retired fields) whose declarations differ; null when anything else differs too. */
export function settingsOnlyDifference(baseText: string, candidateText: string): string[] | null {
  let base: unknown, candidate: unknown;
  try { base = JSON.parse(baseText); candidate = JSON.parse(candidateText); } catch { return null; }
  if (!isObject(base) || !isObject(candidate)) return null;
  const owned = new Set<string>([...SETTINGS_FIELDS, ...RETIRED_POLICY_FIELDS]);
  const rest = (policy: Record<string, unknown>) => canonicalJson(Object.fromEntries(Object.entries(policy).filter(([key]) => !owned.has(key))));
  if (rest(base) !== rest(candidate)) return null;
  return [...owned].filter((field) => canonicalJson(base[field]) !== canonicalJson(candidate[field]));
}

/** Executables of the checks (and their capability probes) that resolve nowhere on `path`. */
export async function unresolvedExecutables(checks: readonly VerificationDeclaration[], path: string | undefined): Promise<string[]> {
  const names = [...new Set(checks.flatMap((check) => [check.executable, ...check.capability ? [check.capability.probe.executable] : []]))];
  const directories = (path ?? "").split(delimiter).filter(Boolean);
  const resolves = async (name: string) => {
    for (const directory of directories) if (await access(join(directory, name), constants.X_OK).then(() => true, () => false)) return true;
    return false;
  };
  const missing: string[] = [];
  for (const name of names) if (!await resolves(name)) missing.push(name);
  return missing;
}

/** Where the runner reads what a landing changes. */
export type SettingsLandingIO = {
  /** Repository-relative paths that differ between two commits. */
  changedPaths(from: string, to: string): Promise<string[]>;
  /** The policy file's text at a commit, or null when it declares none. */
  policyText(commitId: string): Promise<string | null>;
  description(commitId: string): Promise<string>;
};

export type SettingsLanding = { fields: string[]; checks: VerificationDeclaration[]; reason: string };

/**
 * Whether the rebased `candidate` changes only settings on `base`: its one changed path is
 * the policy file, and the parsed policies match outside the settings fields. Null sends it
 * the normal route. An eligible candidate is refused (thrown) when its patch was based on a
 * policy other than `base`'s, or its new policy would not load or names a check whose
 * executable does not resolve on this host.
 */
export async function settingsLanding(io: SettingsLandingIO, base: string, candidate: string, path: string | undefined): Promise<SettingsLanding | null> {
  const changed = await io.changedPaths(base, candidate);
  if (changed.length !== 1 || changed[0] !== EXECUTION_POLICY_PATH) return null;
  const [baseText, candidateText] = await Promise.all([io.policyText(base), io.policyText(candidate)]);
  if (baseText === null || candidateText === null) return null;
  const fields = settingsOnlyDifference(baseText, candidateText);
  if (!fields?.length) return null;
  const based = new RegExp(`^${POLICY_BASE_TRAILER}:\\s*(\\S+)\\s*$`, "m").exec(await io.description(candidate))?.[1];
  if (based && based !== policyDigest(baseText))
    throw new Error(`Settings change refused as stale: it was based on policy ${based.slice(0, 19)}, but ${EXECUTION_POLICY_PATH} on the integration branch has changed since; read it again and reapply`);
  const policy = parseExecutionPolicy(candidateText);
  const missing = await unresolvedExecutables(policy.requiredLandingVerification, path);
  if (missing.length)
    throw new Error(`Settings change refused: requiredLandingVerification names ${missing.join(", ")}, which ${missing.length === 1 ? "does" : "do"} not resolve on the runner host`);
  return { fields, checks: policy.requiredLandingVerification,
    reason: `Only ${fields.join(", ")} changed in ${EXECUTION_POLICY_PATH}; landing checks are not run. A changed check is proven only when a later landing runs it.` };
}
