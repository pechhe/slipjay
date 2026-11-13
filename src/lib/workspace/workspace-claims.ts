import { closeSync, fsyncSync, openSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { stateHome } from "./workspace-paths.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "../infra/workspace-transaction.ts";
import { claimController, sameClaimController } from "./workspace-claim-identity.ts";
import type { ClaimController } from "./workspace-claim-identity.ts";

export class WorkspaceClaimError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = "WorkspaceClaimError"; }
}
function fail(code: string, message: string): never { throw new WorkspaceClaimError(code, message); }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const requestDigest = (input: unknown) => hash(JSON.stringify(input, (_key, value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value));
const home = () => join(stateHome(), "custody");
const file = (root: string) => join(home(), `${hash(root)}.json`);
export async function canonicalClaimPath(path: string): Promise<string> {
  const root = resolve(path);
  try { return await realpath(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(root);
    return parent === root ? root : join(await canonicalClaimPath(parent), basename(root));
  }
}
export type ClaimAcquisition = {
  requestId: string; ownerId: string; credential: string; controller: ClaimController | null; obligationRef: string;
};
export type ClaimView = {
  claimId: string; ownerId: string; generation: string; state: "active" | "recovery-required" | "released" | "transferred";
  reason: string; obligationRef: string; settlementRef: string | null; controller: ClaimController | null;
};
type Claim = Omit<ClaimView, "state" | "reason"> & { state: "active" | "released" | "transferred"; credentialHash: string; recoveryReason?: string };
type Generation = {
  id: string; fingerprint: string; repository: string; workspaceName: string; retired: boolean; claims: Claim[];
  retirement?: { id: string; reason: string };
};
type RecordState = { version: 1; path: string; current: string; generations: Generation[]; receipts: Record<string, { digest: string; result: unknown }> };
export type ClaimStatus = { version: 1; path: string; generation: string | null; claims: ClaimView[]; retirement: Generation["retirement"] | null; reason: string | null };
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/.test(value);
function validateAcquisition(input: ClaimAcquisition) {
  if (!validId(input.requestId) || !validId(input.ownerId) || !validId(input.obligationRef)
    || typeof input.credential !== "string" || input.credential.length < 32 || input.credential.length > 512) fail("CLAIM_REQUEST_INVALID", "Claim identifiers and a credential of 32–512 characters are required");
  if (input.controller !== null && (!input.controller || !Number.isSafeInteger(input.controller.pid) || input.controller.pid <= 0
    || ![input.controller.platform, input.controller.boot, input.controller.start].every((value) => typeof value === "string" && value.length > 0 && value.length <= 256))) fail("CLAIM_REQUEST_INVALID", "Invalid controller identity");
}
async function load(root: string): Promise<RecordState | null> {
  try {
    const record = JSON.parse(await readFile(file(root), "utf8")) as RecordState;
    if (record.version !== 1 || record.path !== root || typeof record.current !== "string" || !Array.isArray(record.generations) || !record.receipts
      || !record.generations.every((g) => typeof g.id === "string" && typeof g.fingerprint === "string" && typeof g.retired === "boolean" && Array.isArray(g.claims)
        && g.claims.every((c) => typeof c.claimId === "string" && typeof c.ownerId === "string" && typeof c.credentialHash === "string"
          && ["active", "released", "transferred"].includes(c.state))) || !record.generations.some((g) => g.id === record.current)) throw new Error("invalid custody record");
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return fail("CLAIM_STATE_UNREADABLE", "Workspace custody identity is unreadable; recovery required");
  }
}
async function save(record: RecordState) {
  await mkdir(home(), { recursive: true, mode: 0o700 });
  await writeWorkspaceJson(file(record.path), record);
  for (const path of [file(record.path), home()]) {
    const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
async function view(claim: Claim): Promise<ClaimView> {
  const { recoveryReason } = claim;
  const publicClaim = { claimId: claim.claimId, ownerId: claim.ownerId, generation: claim.generation,
    state: claim.state, controller: claim.controller, obligationRef: claim.obligationRef, settlementRef: claim.settlementRef };
  const active = claim.state === "active";
  const healthy = active && !recoveryReason && sameClaimController(claim.controller, await claimController(claim.controller?.pid ?? 0));
  return { ...publicClaim, state: active && !healthy ? "recovery-required" : claim.state,
    reason: active ? healthy ? "active caller custody" : recoveryReason ?? "controller identity unavailable or changed; settlement required" : "caller custody ended" };
}
function retained(record: RecordState): Claim[] { return record.generations.flatMap((g) => g.claims.filter((c) => c.state === "active")); }
/** The innermost lock: allocation/pool/name-writer locks may precede it, never the reverse. */
export async function withClaimWriter<T>(path: string, operation: (root: string) => Promise<T>): Promise<T> {
  const root = await canonicalClaimPath(path);
  return withWorkspaceTransaction(`writer:canonical:${root}`, () => operation(root));
}
export async function workspaceClaimStatus(path: string): Promise<ClaimStatus> {
  const root = await canonicalClaimPath(path);
  const record = await load(root);
  const current = record?.generations.find((g) => g.id === record.current);
  return { version: 1, path: root, generation: current?.id ?? null, claims: await Promise.all((record?.generations ?? []).flatMap((g) => g.claims).map(view)),
    retirement: current?.retirement ?? null, reason: current?.retirement ? "retirement in progress or interrupted; recovery required" : null };
}
/** Read-only plans and all destructive paths fail closed on unknown authority. */
export async function workspaceClaimRefusal(path: string): Promise<string | null> {
  try {
    const status = await workspaceClaimStatus(path);
    const claims = status.claims.filter((c) => c.state === "active" || c.state === "recovery-required");
    return claims.length ? `workspace custody retained: ${claims.map((c) => `${c.ownerId} (${c.state}: ${c.reason})`).join(", ")}` : status.reason;
  } catch { return "workspace custody identity unreadable; recovery required"; }
}
async function fingerprint(root: string) {
  const info = await stat(root, { bigint: true });
  return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
}
async function generationFor(root: string, repository: string, workspaceName: string): Promise<RecordState> {
  const currentFingerprint = await fingerprint(root);
  const record = await load(root) ?? { version: 1 as const, path: root, current: "", generations: [], receipts: {} };
  const current = record.generations.find((g) => g.id === record.current);
  if (current?.retirement) fail("CLAIM_RETIRING", "Checkout retirement is in progress or requires recovery");
  if (current && !current.retired && current.fingerprint === currentFingerprint) return record;
  if (retained(record).length) fail("CLAIM_GENERATION_CONFLICT", "Checkout identity changed while custody remains; recovery required");
  const generation: Generation = { id: randomUUID(), fingerprint: currentFingerprint, repository, workspaceName, retired: false, claims: [] };
  record.generations.push(generation); record.current = generation.id;
  return record;
}
function receipt<T>(record: RecordState, requestId: string, input: unknown): T | undefined {
  if (!validId(requestId)) fail("CLAIM_REQUEST_INVALID", "Invalid requestId");
  const found = record.receipts[requestId];
  if (found && found.digest !== requestDigest(input)) fail("CLAIM_REPLAY_CONFLICT", "Request id was already used for different claim input");
  return found?.result as T | undefined;
}
async function finish<T>(record: RecordState, requestId: string, input: unknown, result: T): Promise<T> {
  record.receipts[requestId] = { digest: requestDigest(input), result };
  await save(record); return result;
}
export type AcquiredClaim = { version: 1; path: string; generation: string; claimId: string; ownerId: string };
/** Called while allocation is still held, before dependency preparation or publication. */
export async function acquireWorkspaceClaim(path: string, repository: string, workspaceName: string, input: ClaimAcquisition, expectedGeneration?: string): Promise<AcquiredClaim> {
  validateAcquisition(input);
  return withClaimWriter(path, async (root) => {
    const record = await generationFor(root, repository, workspaceName);
    const replay = receipt<AcquiredClaim>(record, input.requestId, { action: "acquire", input, expectedGeneration });
    if (replay) {
      if (record.current !== replay.generation || !record.generations.find((g) => g.id === replay.generation)?.claims.some((c) => c.claimId === replay.claimId && c.state === "active")) fail("CLAIM_ENDED", "Replayed acquisition no longer authorizes work");
      return replay;
    }
    if (expectedGeneration && record.current !== expectedGeneration) fail("CLAIM_GENERATION_MISMATCH", "The checkout allocation generation changed");
    const generation = record.generations.find((g) => g.id === record.current)!;
    if (generation.claims.some((c) => c.ownerId === input.ownerId)) fail("CLAIM_OWNER_CONFLICT", "Owner id already names a claim; reconcile its original request");
    const claim: Claim = { claimId: randomUUID(), ownerId: input.ownerId, generation: generation.id, state: "active", credentialHash: hash(input.credential), controller: input.controller && { platform: input.controller.platform, pid: input.controller.pid, boot: input.controller.boot, start: input.controller.start },
      obligationRef: input.obligationRef, settlementRef: null };
    generation.claims.push(claim);
    return finish(record, input.requestId, { action: "acquire", input, expectedGeneration }, { version: 1 as const, path: root, generation: generation.id, claimId: claim.claimId, ownerId: claim.ownerId });
  });
}
export type ClaimMutation = { requestId: string; generation: string; claimId: string; credential: string; settlementRef: string };
/** T3 attests settlement of its closed obligation set; SlipJay never interprets that registry. */
export async function releaseWorkspaceClaim(path: string, input: ClaimMutation): Promise<{ version: 1; released: true; claimId: string; generation: string }> {
  return mutate(path, "release", input, undefined);
}
export async function transferWorkspaceClaim(path: string, input: ClaimMutation, next: Omit<ClaimAcquisition, "requestId">): Promise<AcquiredClaim> {
  validateAcquisition({ ...next, requestId: input.requestId });
  return mutate(path, "transfer", input, next);
}
async function mutate<T>(path: string, action: "release" | "transfer", input: ClaimMutation, next: Omit<ClaimAcquisition, "requestId"> | undefined): Promise<T> {
  if (!input || typeof input.credential !== "string") fail("CLAIM_UNAUTHORIZED", "Claim mutation credential required");
  if (!validId(input.settlementRef)) fail("CLAIM_SETTLEMENT_REQUIRED", "Evidence-backed settlement or acknowledged transfer reference required");
  return withClaimWriter(path, async (root) => {
    const record = await load(root) ?? fail("CLAIM_NOT_FOUND", "No custody identity for checkout");
    const request = { action, input, next };
    const replay = receipt<T>(record, input.requestId, request); if (replay) return replay;
    if (record.current !== input.generation) fail("CLAIM_GENERATION_MISMATCH", "Cannot mutate a different allocation generation");
    const generation = record.generations.find((g) => g.id === input.generation)!;
    const claim = generation.claims.find((c) => c.claimId === input.claimId);
    if (!claim || claim.credentialHash !== hash(input.credential)) fail("CLAIM_UNAUTHORIZED", "Claim mutation credential does not match");
    if (claim.state !== "active") fail("CLAIM_ENDED", "Claim already ended");
    if (next && generation.claims.some((c) => c.ownerId === next.ownerId)) fail("CLAIM_OWNER_CONFLICT", "Transfer owner id already exists");
    claim.state = next ? "transferred" : "released"; claim.settlementRef = input.settlementRef;
    if (!next) return finish(record, input.requestId, request, { version: 1, released: true, claimId: claim.claimId, generation: generation.id }) as Promise<T>;
    const replacement: Claim = { claimId: randomUUID(), ownerId: next.ownerId, generation: generation.id, state: "active", credentialHash: hash(next.credential), controller: next.controller && { platform: next.controller.platform, pid: next.controller.pid, boot: next.controller.boot, start: next.controller.start },
      obligationRef: next.obligationRef, settlementRef: input.settlementRef };
    generation.claims.push(replacement);
    return finish(record, input.requestId, request, { version: 1, path: root, generation: generation.id, claimId: replacement.claimId, ownerId: replacement.ownerId }) as Promise<T>;
  });
}
export type ClaimRecovery = Omit<ClaimMutation, "settlementRef"> & { reason: string };
/** The publisher may retain explicit uncertainty even while its controller is alive. */
export async function markWorkspaceClaimRecovery(path: string, input: ClaimRecovery): Promise<{ version: 1; recoveryRequired: true; claimId: string }> {
  if (!validId(input.reason) || typeof input.credential !== "string") fail("CLAIM_REQUEST_INVALID", "Credential and bounded non-secret recovery reason required");
  return withClaimWriter(path, async (root) => {
    const record = await load(root) ?? fail("CLAIM_NOT_FOUND", "No custody identity for checkout");
    const request = { action: "recover", input };
    const replay = receipt<{ version: 1; recoveryRequired: true; claimId: string }>(record, input.requestId, request); if (replay) return replay;
    if (record.current !== input.generation) fail("CLAIM_GENERATION_MISMATCH", "Cannot recover a different allocation generation");
    const generation = record.generations.find((g) => g.id === input.generation)!;
    const claim = generation.claims.find((c) => c.claimId === input.claimId);
    if (!claim || claim.credentialHash !== hash(input.credential)) fail("CLAIM_UNAUTHORIZED", "Claim mutation credential does not match");
    if (claim.state !== "active") fail("CLAIM_ENDED", "Claim already ended");
    claim.recoveryReason = input.reason;
    return finish(record, input.requestId, request, { version: 1 as const, recoveryRequired: true as const, claimId: claim.claimId });
  });
}

/** Fence admission under a short canonical writer lock; slow teardown runs outside this lock. */
export async function withUnclaimedWorkspace<T>(path: string, reason: string, operation: (check: () => Promise<void>) => Promise<T>, options: { retired?: boolean } = {}): Promise<T> {
  const root = await canonicalClaimPath(path);
  const id = randomUUID();
  await withClaimWriter(root, async () => {
    const refusal = await workspaceClaimRefusal(root); if (refusal) fail("CLAIM_RETAINED", refusal);
    const record = await load(root) ?? { version: 1 as const, path: root, current: "", generations: [], receipts: {} };
    if (!record.current) {
      record.current = randomUUID();
      record.generations.push({ id: record.current, fingerprint: await fingerprint(root).catch(() => "missing"), repository: "", workspaceName: "", retired: false, claims: [] });
    }
    record.generations.find((g) => g.id === record.current)!.retirement = { id, reason };
    await save(record);
  });
  const check = () => withClaimWriter(root, async () => {
    const record = await load(root); const current = record?.generations.find((g) => g.id === record.current);
    if (!record || current?.retirement?.id !== id || retained(record).length) fail("CLAIM_FENCE_CHANGED", "Destructive custody authority changed; recovery required");
  });
  let completed = false; let unchanged = false;
  try { await check(); const result = await operation(check); completed = true; return result; }
  catch (error) {
    unchanged = (error as { code?: string } | null)?.code === "WORKING_COPY_CHANGED";
    throw error;
  }
  finally {
    // A partial/unknown destructive failure is not permission to admit new work.
    if (completed || unchanged) await withClaimWriter(root, async () => {
      const record = await load(root); const current = record?.generations.find((g) => g.id === record.current);
      if (!record || current?.retirement?.id !== id) fail("CLAIM_FENCE_CHANGED", "Destructive custody fence changed; recovery required");
      delete current.retirement;
      if (completed && options.retired) current.retired = true;
      await save(record);
    });
  }
}
export async function resetWorkspaceClaimGeneration(path: string): Promise<void> {
  await withClaimWriter(path, async (root) => {
    const refusal = await workspaceClaimRefusal(root); if (refusal) fail("CLAIM_RETAINED", refusal);
    const record = await load(root); if (!record) return;
    record.generations.find((g) => g.id === record.current)!.retired = true;
    await save(record);
  });
}
export async function assertWorkspaceNotRetiring(path: string): Promise<void> {
  const status = await workspaceClaimStatus(path);
  if (status.retirement) fail("CLAIM_RETIRING", "Checkout has a destructive admission fence; no allocation may use it");
}
