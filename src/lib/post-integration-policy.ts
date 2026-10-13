export type FinalizationCommand = { executable: string; args: string[]; cwd: string };

export type PostIntegrationPolicy = {
  version: 1;
  target: string;
  idempotency: "artifact-key";
  command: FinalizationCommand;
  targetProbe: FinalizationCommand;
  timeoutMs: number;
  environmentKeys: string[];
  approvalMode: "explicit-human" | "automatic-development";
};

export type PostReleasePolicy = {
  version: 1;
  target: string;
  command: FinalizationCommand;
  targetProbe: FinalizationCommand;
  timeoutMs: number;
  environmentKeys: string[];
};

export type PostIntegrationApproval = {
  humanApproved: true;
  integratedCommitSha: string;
  policyDigest: string;
  target: string;
};

import { createHash } from "node:crypto";
import path from "node:path";
function object(value: unknown, step = "Post-integration"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${step.toLowerCase()} policy`);
  return value as Record<string, unknown>;
}
function command(value: unknown, step = "Post-integration"): FinalizationCommand {
  const row = object(value, step);
  if (typeof row.executable !== "string" || !row.executable.trim() || row.executable.includes("\x00") || !Array.isArray(row.args) || row.args.some((arg) => typeof arg !== "string" || arg.includes("\x00"))) {
    throw new Error(`Invalid ${step.toLowerCase()} command`);
  }
  const cwd = row.cwd ?? ".";
  if (typeof cwd !== "string" || path.isAbsolute(cwd) || cwd.includes("\x00") || cwd.split(/[\\/]/).includes(".."))
    throw new Error(`${step} cwd must stay within the exact source view`);
  return { executable: row.executable, args: [...(row.args as string[])], cwd };
}
/** Variables a step passes through from SlipJay's environment; SlipJay's own and loader controls stay out. */
function environmentKeys(row: Record<string, unknown>, step: string): string[] {
  const keys = row.environmentKeys ?? [];
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(key) || key.startsWith("SLIPJAY_FINALIZATION_") || key.startsWith("SLIPJAY_RELEASE_") || ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "NODE_OPTIONS", "BUN_OPTIONS"].includes(key))) {
    throw new Error(`Invalid ${step.toLowerCase()} environment declaration`);
  }
  return [...new Set(keys as string[])];
}
const TARGET = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/;
export function postIntegrationPolicy(value: unknown): PostIntegrationPolicy | null {
  if (value === undefined)
    return null;
  const row = object(value);
  if (row.version !== 1 || row.idempotency !== "artifact-key" || typeof row.target !== "string" || !TARGET.test(row.target) || !Number.isInteger(row.timeoutMs) || Number(row.timeoutMs) < 1 || Number(row.timeoutMs) > 600000) {
    throw new Error("Invalid post-integration identity, idempotency contract or deadline");
  }
  const keys = environmentKeys(row, "Post-integration");
  const approvalMode = row.approvalMode ?? "explicit-human";
  const approvalModes: readonly unknown[] = ["explicit-human", "automatic-development"];
  if (!approvalModes.includes(approvalMode)) {
    throw new Error("Invalid post-integration approval mode");
  }
  return {
    version: 1,
    target: row.target,
    idempotency: "artifact-key",
    command: command(row.command),
    targetProbe: command(row.targetProbe),
    timeoutMs: Number(row.timeoutMs),
    environmentKeys: keys,
    approvalMode: approvalMode as PostIntegrationPolicy["approvalMode"]
  };
}
/**
 * `postRelease`: a step `slipjay release` runs against an external target once a
 * release has published, in the integration branch's exact source (the target
 * follows it), alone in the runner's queue. The human's release confirmation is its
 * approval, and it reruns until it succeeds, so it declares no approval mode or
 * idempotency contract. A reset of a whole database takes longer than a
 * migration, so its deadline may run to 15 minutes.
 */
export function postReleasePolicy(value: unknown): PostReleasePolicy | null {
  if (value === undefined)
    return null;
  const row = object(value, "Post-release");
  if (row.version !== 1 || typeof row.target !== "string" || !TARGET.test(row.target) || !Number.isInteger(row.timeoutMs) || Number(row.timeoutMs) < 1 || Number(row.timeoutMs) > 900000) {
    throw new Error("Invalid post-release identity or deadline");
  }
  return {
    version: 1,
    target: row.target,
    command: command(row.command, "Post-release"),
    targetProbe: command(row.targetProbe, "Post-release"),
    timeoutMs: Number(row.timeoutMs),
    environmentKeys: environmentKeys(row, "Post-release"),
  };
}
export function postIntegrationPolicyDigest(policy: PostIntegrationPolicy | null): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}
export function exactPostIntegrationApproval(value: unknown, commit: string, digest: string, target: string): boolean {
  if (!value || typeof value !== "object")
    return false;
  const row = value as Record<string, unknown>;
  return row.humanApproved === true && row.integratedCommitSha === commit && row.policyDigest === digest && row.target === target;
}
