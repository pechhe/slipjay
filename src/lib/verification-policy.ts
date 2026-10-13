export type VerificationCommand = { executable: string; args: string[]; cwd?: string; baseline?: unknown; concurrent?: boolean };

export type CapabilityDeclaration = {
  id: string;
  probe: VerificationCommand;
  onUnavailable: "continue";
  unavailableExitCodes: number[];
  unavailableStderrIncludes: string[];
};

export type VerificationDeclaration = VerificationCommand & { capability?: CapabilityDeclaration };

export type VerificationGap = {
  capability: string;
  command: string;
  reason: string;
  probeCommand?: string;
  probeExitCode?: number | null;
};

export type VerificationEvidence = {
  status: "passed" | "passed_with_gaps";
  passed: string[];
  gaps: VerificationGap[];
  policyDigest: string;
};

import { createHash } from "node:crypto";

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object";

const command = (value: unknown, field: string): VerificationCommand => {
  if (!isObject(value) || typeof value.executable !== "string"
    || !value.executable.trim() || !Array.isArray(value.args)
    || value.args.some((arg) => typeof arg !== "string")
    || (value.cwd != null && typeof value.cwd !== "string")) {
    throw new Error(`Malformed ${field} command`);
  }
  return { executable: value.executable, args: [...(value.args as string[])], ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(value.baseline && typeof value.baseline === "object" ? { baseline: value.baseline } : {}),
    ...(value.concurrent === true ? { concurrent: true } : {}) };
};

/**
 * Run declared checks in order, except that consecutive `concurrent` checks run
 * together. Outcomes keep declaration order; the first failure in that order is
 * thrown once its group has settled, so no check is left running.
 */
export async function runVerificationStages<Check extends { concurrent?: unknown } | null, Outcome>(checks: readonly Check[], verify: (check: Check, index: number) => Promise<Outcome>): Promise<Outcome[]> {
  const stages: number[][] = [];
  checks.forEach((check, index) => {
    const last = stages.at(-1);
    if (check?.concurrent === true && last && checks[last[0]!]?.concurrent === true) last.push(index);
    else stages.push([index]);
  });
  const outcomes: Outcome[] = [];
  for (const stage of stages) {
    const settled = await Promise.allSettled(stage.map((index) => verify(checks[index]!, index)));
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
      outcomes.push(result.value);
    }
  }
  return outcomes;
}

export function normalizeVerificationDeclaration(value: unknown, field = "requiredLocalVerification"): VerificationDeclaration {
  const base = command(value, field);
  if ((value as Record<string, unknown>).capability == null) return base;
  const capability = (value as Record<string, unknown>).capability;
  if (!isObject(capability) || typeof capability.id !== "string"
    || !capability.id.trim() || capability.onUnavailable !== "continue"
    || !Array.isArray(capability.unavailableExitCodes) || capability.unavailableExitCodes.length === 0
    || capability.unavailableExitCodes.some((code) => !Number.isInteger(code))
    || !Array.isArray(capability.unavailableStderrIncludes) || capability.unavailableStderrIncludes.length === 0
    || capability.unavailableStderrIncludes.some((part) => typeof part !== "string" || !part)) {
    throw new Error(`Malformed ${field}.capability declaration`);
  }
  return { ...base, capability: {
    id: capability.id, probe: command(capability.probe, `${field}.capability.probe`),
    onUnavailable: "continue", unavailableExitCodes: [...(capability.unavailableExitCodes as number[])],
    unavailableStderrIncludes: [...(capability.unavailableStderrIncludes as string[])],
  } };
}

export function classifyCapabilityProbe(capability: CapabilityDeclaration, result: {
  code?: number; exitCode?: number | null; signal?: string | null; stderr?: string;
  timedOut?: boolean; cancelled?: boolean; error?: unknown;
}): { status: "available" } | { status: "unavailable" | "failed"; reason: string } {
  if (!result || result.timedOut || result.cancelled || result.error || result.signal) return { status: "failed", reason: "probe did not complete normally" };
  if (result.code === 0 || result.exitCode === 0) return { status: "available" };
  const exitCode = result.code ?? result.exitCode;
  const stderr = String(result.stderr ?? "");
  const unavailableExitCodes: readonly unknown[] = capability.unavailableExitCodes;
  const declared = unavailableExitCodes.includes(exitCode)
    && capability.unavailableStderrIncludes.every((part) => stderr.includes(part));
  return declared
    ? { status: "unavailable", reason: stderr.trim().slice(0, 2_000) }
    : { status: "failed", reason: stderr.trim().slice(0, 2_000) || `probe exited ${exitCode}` };
}

const boundedCommand = (value: unknown): string => Buffer.from(String(value), "utf8").subarray(0, 1_000).toString("utf8").replace(/\uFFFD+$/u, "");

export function verificationGap(capability: CapabilityDeclaration, command: string, result: {
  code?: number; exitCode?: number | null;
}, reason: string): VerificationGap {
  return {
    capability: capability.id,
    command: boundedCommand(command),
    reason: String(reason).slice(0, 2_000),
    probeCommand: boundedCommand([capability.probe.executable, ...capability.probe.args].join(" ")),
    probeExitCode: result.code ?? result.exitCode ?? null,
  };
}

export function verificationEvidence(passed: string[], gaps: VerificationGap[], declarations: unknown): VerificationEvidence {
  return {
    status: gaps.length ? "passed_with_gaps" : "passed",
    passed: [...passed], gaps: [...gaps],
    policyDigest: createHash("sha256").update(JSON.stringify(declarations)).digest("hex"),
  };
}

export function verificationReviewEvidence(evidence: VerificationEvidence): string[] {
  return [
    ...evidence.passed,
    ...evidence.gaps.map((gap) => `UNAVAILABLE ${gap.capability}: ${gap.command} (${gap.reason})`),
  ];
}

export function normalizeDeclaredVerification(value: unknown): VerificationDeclaration[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    try {
      return [normalizeVerificationDeclaration(entry, `requiredLocalVerification[${index}]`)];
    } catch {
      return [];
    }
  });
}

