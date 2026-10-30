import { auditSummary, promotionRefusal } from "../release/audit-ledger.ts";
import { nextAuditSlot } from "../release/audit-schedule.ts";
import { repositoryKey } from "./runner-contract.ts";
import type { DeployOperation, OperationLog, RunnerConfig, StoredEvent, WatchRelease, WatchRepository } from "./runner-types.ts";

/** Cache ledger reads between events; heartbeats only advance the wall-clock schedule. */
export function watchRepositoryProjection(config: Pick<RunnerConfig, "repos">) {
  let cached: { seq: number; day: string; repositories: WatchRepository[] } | undefined;
  return (log: OperationLog, events: readonly StoredEvent[], now: Date): WatchRepository[] => {
    const seq = events.at(-1)?.seq ?? 0, day = now.toDateString();
    if (!cached || cached.seq !== seq || cached.day !== day) cached = { seq, day, repositories: projectWatchRepositories(log, config, events, now) };
    return cached.repositories.map((repository) => {
      const release = repository.release;
      if (!release?.audit) return repository;
      const event = events.findLast(({ event }) => event.type === "repository_policy" && repositoryKey(event.repo) === repositoryKey(repository.repo))?.event;
      const schedule = event?.type === "repository_policy" ? event.policy.audit : null;
      return schedule ? { ...repository, release: { ...release, audit: { ...release.audit, nextRunAt: new Date(nextAuditSlot(now.getTime(), schedule)).toISOString() } } } : repository;
    });
  };
}

/** Repository reporting uses ledger facts only, including the conventional `images` deploy environment. */
export function projectWatchRepositories(log: OperationLog, config: Pick<RunnerConfig, "repos">, events: readonly StoredEvent[], now: Date): WatchRepository[] {
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  return Object.entries(config.repos).map(([repo, configuration]) => {
    const matches = (name: string) => repositoryKey(name) === repositoryKey(repo);
    const policyEvent = events.findLast(({ event }) => event.type === "repository_policy" && matches(event.repo))?.event;
    const policy = policyEvent?.type === "repository_policy" ? policyEvent.policy : null;
    const landings = log.landings(repo);
    const today = { landed: landings.filter((landing) => Date.parse(landing.at) >= midnight.getTime()).length,
      failedScreens: events.filter(({ event, operationId, at }) => Date.parse(at) >= midnight.getTime() && event.type === "failed" && event.stage === "screening" && matches(log.operation(operationId)?.repo ?? "")).length };
    const result: WatchRepository = { repo, screeningLanes: configuration.screeningLanes ?? 0, today, release: null };
    if (!policy?.releases) return result;
    const candidate = log.lastLanded(repo);
    const deploys = log.deployments(repo, "production");
    const production = deploymentState(deploys);
    const stagingDeploys = log.deployments(repo, "staging");
    const imageDeploys = policy.images ? log.deployments(repo, "images").filter((entry) => entry.status !== "superseded" && entry.status !== "cancelled") : [];
    const candidateImages = imageDeploys.find((entry) => entry.commitId === candidate?.commitId);
    const imageDeploy = candidateImages ?? imageDeploys[0];
    const images: WatchRelease["images"] = policy.images ? {
      commitId: imageDeploy?.commitId ?? candidate?.commitId ?? "",
      status: imageDeploy?.result?.type === "deployed" ? "built" : imageDeploy?.result?.type === "failed" ? "failed" : imageDeploy ? "building" : "none",
      at: imageDeploy ? imageDeploy.finishedAt ?? imageDeploy.startedAt ?? imageDeploy.submittedAt : null,
      reason: imageDeploy?.result?.type === "failed" ? imageDeploy.result.reason : null,
    } : null;
    const imagesPending = policy.images && (!candidateImages || candidateImages.status === "queued" || candidateImages.status === "running");
    const summary = auditSummary({ audits: log.audits(repo), landings }, now);
    const refusal = (policy.promotionAudit ?? Boolean(policy.audit)) ? promotionRefusal(summary) : null;
    const verification = candidate ? log.verifications(repo).find((entry) => entry.commitId === candidate.commitId) : undefined;
    const release = candidate ? log.releases(repo).find((entry) => entry.commitId === candidate.commitId) : undefined;
    const candidateAttempt = deploys.find((entry) => entry.commitId === candidate?.commitId);
    const staging = stagingDeploys.find((entry) => entry.commitId === candidate?.commitId);
    const pendingDeploy = log.openOperations(repo).some((entry) => entry.kind === "release" || entry.kind === "deploy");
    const failed = [verification, release, candidateAttempt, staging, candidateImages].find((entry) => entry?.result?.type === "failed");
    let waitingOn: WatchRelease["waitingOn"];
    if (log.paused()) waitingOn = { kind: "paused", detail: "The runner is paused." };
    else if (!candidate || candidate.commitId === production.live?.commitId) waitingOn = { kind: "up_to_date", detail: null };
    else if (imagesPending) waitingOn = { kind: "images", detail: null };
    else if (refusal) waitingOn = { kind: "audit", detail: refusal };
    else if (verification?.status === "queued" || verification?.status === "running") waitingOn = { kind: "verification", detail: null };
    else if (pendingDeploy) waitingOn = { kind: "deploy", detail: null };
    else if (failed) waitingOn = { kind: "failed", detail: failed.result?.type === "failed" ? failed.result.reason : null };
    else if (!verification && !release && !candidateAttempt) waitingOn = { kind: "verification", detail: null };
    else if (!policy.stagingSkipped) waitingOn = { kind: "approval", detail: null };
    else {
      // Automatic promotion records safeguards (including unassessed/non-additive migrations) on verification.
      const reason = verification && log.events({ operationId: verification.id }).findLast(({ event }) => event.type === "progress" && event.line.startsWith("Not promoting "))?.event;
      waitingOn = { kind: "failed", detail: reason?.type === "progress" ? reason.line : "Automatic promotion has not queued a release." };
    }
    result.release = {
      integrationBranch: policy.integrationBranch, candidate: candidate ? { commitId: candidate.commitId, landedAt: candidate.at } : null,
      stagingSkipped: policy.stagingSkipped,
      staging: !policy.stagingSkipped && policy.staging ? deploymentState(stagingDeploys) : null,
      production,
      images,
      audit: policy.audit ? { latest: summary.latest ? { status: summary.latest.status, commitId: summary.latest.commit, finishedAt: summary.latest.finishedAt } : null,
        nextRunAt: new Date(nextAuditSlot(now.getTime(), policy.audit)).toISOString() } : null,
      waitingOn,
    };
    return result;
  });
}

/** Keep the last successful deploy separate from a newer open or unsuccessful attempt in either environment. */
function deploymentState(deploys: DeployOperation[]): WatchRelease["production"] {
  const live = deploys.find((entry) => entry.result?.type === "deployed");
  const latest = deploys.find((entry) => entry.status !== "superseded" && entry.status !== "cancelled");
  const record = live?.result?.type === "deployed" ? live.result.record : null;
  const attempt = latest && latest.id !== live?.id && latest.result?.type !== "deployed" ? latest : null;
  return {
    live: live ? { commitId: live.commitId, deployedAt: live.finishedAt!,
      healthy: record?.projects.some((project) => project.timings?.health) ? record.projects.every((project) => !project.timings?.health || project.timings.health.outcome === "passed") : null } : null,
    latestAttempt: attempt ? { commitId: attempt.commitId, status: attempt.result?.type === "failed" ? attempt.result.deployment?.rollback?.automatic ? "rolled_back" : "failed" : "running",
      at: attempt.finishedAt ?? attempt.startedAt ?? attempt.submittedAt, reason: attempt.result?.type === "failed" ? attempt.result.reason : null } : null,
  };
}
