import { createHash } from "node:crypto";
import { redactMigrationOutput } from "./migration-command-evidence.ts";
import { posix } from "node:path";
import type { BuildBinding, BuildUnassociated, SubmissionHandoff } from "../runner/runner-types.ts";
export type { BuildBinding, BuildUnassociated, SubmissionHandoff } from "../runner/runner-types.ts";

/** Bound helper scope without omitting paths: replace files with enclosing directories as needed. */
export function helperScope(paths: string[]): string {
  let scope = [...new Set(paths)];
  while (scope.join("\n").length > 2000) {
    scope = [...new Set(scope.map((path) => posix.dirname(path)))];
    if (scope.includes(".")) return ".";
  }
  return scope.join("\n") || ".";
}

export const isBuildBinding = (build: BuildBinding | BuildUnassociated | undefined): build is BuildBinding => build !== undefined && !("unassociated" in build);

export const HANDOFF_MAX_BYTES = 65536;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
export const handoffDigest = (value: SubmissionHandoff | undefined): string | undefined => value === undefined ? undefined
  : createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const int = (v: unknown, min: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= 2_147_483_647;
function validBuildBinding(value: unknown): value is BuildBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  const names = ["specId", "ticketIds", "bodyRevision", "bindGeneration", "sessionId"];
  return Object.keys(binding).length === names.length && names.every((name) => name in binding)
    && typeof binding.specId === "string" && UUID.test(binding.specId)
    && Array.isArray(binding.ticketIds) && binding.ticketIds.length <= 200
    && binding.ticketIds.every((id) => typeof id === "string" && UUID.test(id)) && new Set(binding.ticketIds.map((id) => (id as string).toLowerCase())).size === binding.ticketIds.length
    && (binding.bodyRevision === null || int(binding.bodyRevision, 0)) && int(binding.bindGeneration, 1)
    && typeof binding.sessionId === "string" && UUID.test(binding.sessionId);
}

export function validSubmissionHandoff(value: unknown): value is SubmissionHandoff {
  const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every((name) => name in v);
  const text = (v: unknown, max = 2000): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
  const revision = (v: unknown) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
  const list = (v: unknown, test: (v: unknown) => boolean) => Array.isArray(v) && v.length <= 32 && v.every(test);
  const { build, ...required } = object(value) ? value : { build: undefined };
  if (!object(value) || !keys(required, ["version", "source", "intent", "scope", "spec", "helpers", "checks", "reviews", "toolchain", "gaps"])) return false;
  if ("build" in value && !validBuildBinding(build) && !(object(build) && keys(build, ["unassociated"]) && build.unassociated === true)) return false;
  if (value.version !== 1 || !revision(value.source) || !text(value.intent) || !list(value.scope, (v) => text(v)) || !list(value.gaps, (v) => text(v))) return false;
  const spec = value.spec;
  if (spec !== null && (!object(spec) || !keys(spec, ["ref", "bodySha256", "snapshot"]) || !text(spec.ref, 300)
    || !/^[\w.-]+\/[\w.-]+#[1-9][0-9]*$/.test(spec.ref) || typeof spec.bodySha256 !== "string"
    || !text(spec.snapshot, 32768) || createHash("sha256").update(spec.snapshot).digest("hex") !== spec.bodySha256)) return false;
  if (!list(value.helpers, (v) => object(v) && keys(v, ["revision", "base", "scope"]) && revision(v.revision) && revision(v.base) && text(v.scope))) return false;
  if (!list(value.checks, (v) => object(v) && keys(v, ["revision", "command", "result", "detail"]) && revision(v.revision) && text(v.command)
    && ["passed", "failed", "not-run"].includes(String(v.result)) && text(v.detail))) return false;
  if (!list(value.reviews, (v) => object(v) && keys(v, ["revision", "reference", "result", "detail"]) && revision(v.revision) && text(v.reference)
    && ["complete", "incomplete"].includes(String(v.result)) && text(v.detail))) return false;
  if (!list(value.toolchain, (v) => object(v) && keys(v, ["name", "version"]) && text(v.name, 100) && text(v.version, 100))) return false;
  return Buffer.byteLength(JSON.stringify(value)) <= HANDOFF_MAX_BYTES;
}

export function sanitizedHandoff(value: SubmissionHandoff, environment: NodeJS.ProcessEnv): { evidence: unknown; redacted: boolean } {
  let redacted = false;
  const sanitize = (v: unknown): unknown => {
    if (typeof v === "string") {
      const safe = redactMigrationOutput(v, "", environment).replace(/(--?(?:token|secret|password|passwd|api[-_]?key|private[-_]?key|authorization|cookie|credential|access[-_]?token))(?:=|\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)/gi, "$1=[REDACTED]");
      redacted ||= safe !== v;
      return safe;
    }
    if (Array.isArray(v)) return v.map(sanitize);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([key, item]) => [key, sanitize(item)]));
    return v;
  };
  const evidence = sanitize(value);
  return { evidence, redacted };
}

/** Redact with the author's environment before sending evidence off the machine. */
export function prepareSubmissionHandoff(value: SubmissionHandoff, environment: NodeJS.ProcessEnv): SubmissionHandoff {
  const sanitized = sanitizedHandoff(value, environment);
  const evidence = sanitized.evidence as SubmissionHandoff;
  if (sanitized.redacted) {
    const originalSpecHash = evidence.spec?.bodySha256;
    if (evidence.spec) evidence.spec.bodySha256 = createHash("sha256").update(evidence.spec.snapshot).digest("hex");
    if (evidence.gaps.length >= 32) throw new Error("Handoff has no capacity for required redaction provenance");
    evidence.gaps = [...evidence.gaps, `Author evidence was sanitized before submission${originalSpecHash ? `; original Spec body SHA256 ${originalSpecHash}; submitted snapshot may differ` : ""}`];
  }
  if (!validSubmissionHandoff(evidence)) throw new Error("Sanitized handoff exceeds the supported evidence bounds");
  return evidence;
}
