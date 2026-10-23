import { randomUUID } from "node:crypto";
import { jj } from "../infra/workspace-jj.ts";
import type { WorkspaceContext } from "../infra/workspace-jj.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "../infra/workspace-transaction.ts";
import { adoptions, frozenAdoptions, publishedLandingArchives } from "../workspace/workspace-coverage.ts";
import type { Adoption } from "../workspace/workspace-coverage.ts";
import { metadataPath, recordedWorkspaceBase, workspaceMetadata } from "../workspace/workspace-state.ts";
import { helperScope, validSubmissionHandoff } from "./submission-handoff.ts";
import type { SubmissionHandoff } from "./submission-handoff.ts";
import { KILLABLE_STAGES } from "../runner/runner-contract.ts";
import type { Operation } from "../runner/runner-types.ts";

/** Freeze source and adoption provenance together; retries never consume newer pending work. */
export async function writtenLandingHandoff(context: WorkspaceContext, key: string, source: string, awaitingAdmission: boolean,
  write: (hasAdoptions: boolean) => Promise<SubmissionHandoff | undefined>, warn: (message: string) => void = console.error,
  readResult: (operationId: string) => Promise<Operation["result"] | undefined> = async () => undefined,
  replacing: ReadonlyArray<{ id: string; commitId: string }> = []): Promise<SubmissionHandoff | undefined> {
  if (context.current.name === "default") return write(false);
  const initial = await workspaceMetadata(context.current.name);
  if (frozenAdoptions(initial?.landingAdoptions)[key] && (awaitingAdmission || (initial?.pendingLandingRequests as Record<string, string> | undefined)?.[key])) {
    return (initial?.landingHandoffs as Record<string, SubmissionHandoff> | undefined)?.[key];
  }
  // Read runner facts outside the writer lock. Missing facts, including a lost
  // submission response, never establish that a landing cannot still publish.
  const stopped = new Set<string>();
  await Promise.all([...new Set(Object.values(frozenAdoptions(initial?.landingAdoptions)).filter((item) => item.adoptions.length).flatMap((item) => item.operationId ? [item.operationId] : []))].map(async (id) => {
    const result = await readResult(id).catch(() => undefined);
    if (result?.type === "declined" || result?.type === "cancelled" || result?.type === "superseded"
      || result?.type === "failed" && (["queued", "paused"].includes(result.stage) || KILLABLE_STAGES.includes(result.stage))) stopped.add(id);
  }));
  const transferable = (other: string, record: ReturnType<typeof frozenAdoptions>[string], pending: Record<string, string>) =>
    other !== key && (record.operationId ? stopped.has(record.operationId) : !pending[other]);
  const replacement = (record: ReturnType<typeof frozenAdoptions>[string]) => replacing.find((operation) =>
    operation.commitId === record.source && (!record.operationId || record.operationId === operation.id));
  const initialPending = (initial?.pendingLandingRequests ?? {}) as Record<string, string>;
  const hasAdoptions = adoptions(initial?.adoptions).length > 0 || Object.entries(frozenAdoptions(initial?.landingAdoptions))
    .some(([other, record]) => record.adoptions.length > 0 && (other === key || transferable(other, record, initialPending) || replacement(record)));
  const supplied = await write(hasAdoptions);
  return withWorkspaceTransaction(`writer:${context.current.name}`, async () => {
    const metadata = await workspaceMetadata(context.current.name);
    if (!metadata) return supplied;
    const pending = { ...(metadata.pendingLandingRequests as Record<string, string> | undefined) };
    const handoffs = { ...(metadata.landingHandoffs as Record<string, SubmissionHandoff> | undefined) };
    const handoff = supplied ?? handoffs[key];
    const frozen = frozenAdoptions(metadata.landingAdoptions);
    if (frozen[key] && (awaitingAdmission || pending[key])) return handoffs[key];
    if (!pending[key]) {
      if (Object.keys(pending).length >= 32) throw new Error("Too many unresolved landing requests; reconcile earlier submissions before submitting more source");
      pending[key] = randomUUID();
    }
    const base = await recordedWorkspaceBase(context.current.root, metadata);
    const published = await publishedLandingArchives(context);
    const isPublished = (record: ReturnType<typeof frozenAdoptions>[string] | undefined) => Boolean(record?.operationId
      && published.some((archive) => archive.operationId === record.operationId && archive.publishedSource === record.source));
    const selected = [...(frozen[key]?.adoptions ?? adoptions(metadata.adoptions))];
    for (const [other, record] of Object.entries(frozen)) {
      if (other === key || isPublished(record)) continue;
      const queued = replacement(record);
      if (!transferable(other, record, pending) && !queued) continue;
      selected.push(...record.adoptions);
      // Copy before POST without consuming a queued predecessor: it might start
      // running before admission, or the response might be lost. Only confirmed
      // supersession releases its original provenance.
      if (transferable(other, record, pending)) {
        frozen[other] = { ...record, adoptions: [] };
        delete pending[other];
      } else frozen[other] = { ...record, operationId: queued!.id };
    }
    const identity = (adoption: Adoption, revision: string) => JSON.stringify([adoption.workspaceName, adoption.base, revision]);
    const identities = (records: Adoption[]) => records.flatMap((record) => record.revisions.map((revision) => identity(record, revision)));
    // A refused replacement may leave an unsubmitted copy. Defer it while the
    // original operation is unresolved; archived coverage needs no resubmission.
    const elsewhere = new Set([
      ...published.flatMap((archive) => identities(adoptions(archive.adoptionCoverage))),
      ...Object.entries(frozen).filter(([other, record]) => other !== key && record.operationId
        && !stopped.has(record.operationId) && !replacement(record) && !isPublished(record))
        .flatMap(([, record]) => identities(record.adoptions)),
    ]);
    const keptAdoptions = [];
    const seen = new Set<string>();
    const helpers = new Map(handoff?.helpers.map((helper) => [helper.revision, helper]));
    if (selected.length) {
      if (!base) throw new Error("Lead workspace has no recorded start base");
      const evolution = new Set((await jj(context.current.root, ["--ignore-working-copy", "evolog", "-r", `${base}..${source}`, "--no-graph", "-T", 'commit.commit_id() ++ "\\n"'])).split("\n").filter(Boolean));
      const changed = new Set((await jj(context.current.root, ["--ignore-working-copy", "diff", "--from", base, "--to", source, "--name-only"])).split("\n").filter(Boolean));
      for (const adoption of selected) {
        const revisions: string[] = [];
        for (const revision of adoption.revisions) {
          const revisionIdentity = identity(adoption, revision);
          if (seen.has(revisionIdentity) || elsewhere.has(revisionIdentity)) continue;
          const paths = (await jj(context.current.root, ["--ignore-working-copy", "diff", "-r", revision, "--name-only"])).split("\n").filter(Boolean);
          if (!adoption.adoptedCommit || !evolution.has(adoption.adoptedCommit) || !paths.some((path) => changed.has(path))) {
            helpers.delete(revision);
            warn(`Dropped adoption ${revision} from ${adoption.workspaceName}: no longer present in the landing candidate`);
            continue;
          }
          seen.add(revisionIdentity);
          revisions.push(revision);
          helpers.set(revision, { revision, base: adoption.base, scope: helperScope(paths) });
        }
        if (revisions.length) keptAdoptions.push({ ...adoption, revisions });
      }
    }
    if (keptAdoptions.length && !handoff) throw new Error("Adopted work requires a submission handoff; retry the landing");
    const merged = handoff ? { ...handoff, helpers: [...helpers.values()] } : undefined;
    if (merged && !validSubmissionHandoff(merged)) throw new Error("Adopted helper evidence exceeds handoff bounds");
    delete frozen[key];
    delete handoffs[key];
    const keys = [...new Set([...Object.keys(frozen), ...Object.keys(handoffs)])];
    const expired = new Set(keys.filter((other) => !pending[other]
      && (!frozen[other]?.adoptions.length || isPublished(frozen[other]))).slice(0, -32));
    for (const other of expired) { delete frozen[other]; delete handoffs[other]; }
    frozen[key] = { source, adoptions: keptAdoptions };
    if (merged) handoffs[key] = merged;
    await writeWorkspaceJson(metadataPath(context.current.name), { ...metadata, adoptions: [], pendingLandingRequests: pending,
      landingAdoptions: frozen, landingHandoffs: handoffs });
    return merged;
  }, { waitMs: 1000 });
}

/** Bind before following, so cleanup can recover provenance if the client disappears. */
export async function bindLandingOperation(context: WorkspaceContext, key: string, operationId: string, superseded?: string): Promise<void> {
  if (context.current.name === "default") return;
  await withWorkspaceTransaction(`writer:${context.current.name}`, async () => {
    const metadata = await workspaceMetadata(context.current.name);
    const frozen = frozenAdoptions(metadata?.landingAdoptions);
    if (!metadata || !frozen[key]) return;
    frozen[key] = { ...frozen[key], operationId };
    const pending = { ...(metadata.pendingLandingRequests as Record<string, string> | undefined) };
    for (const [other, record] of Object.entries(frozen)) {
      if (other !== key && superseded && record.operationId === superseded) {
        frozen[other] = { ...record, adoptions: [] };
        delete pending[other];
      }
    }
    await writeWorkspaceJson(metadataPath(context.current.name), { ...metadata, landingAdoptions: frozen, pendingLandingRequests: pending });
  });
}
