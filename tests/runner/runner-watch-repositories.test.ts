import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { openOperationLog } from "../../src/lib/runner/runner-log.ts";
import { watchRepositoryProjection } from "../../src/lib/runner/runner-watch-repositories.ts";
import { projectWatchOperation } from "../../src/lib/runner/runner-watch-projection.ts";

const config = { repos: { "a/repo": { url: "unused", screeningLanes: 2 }, "a/empty": { url: "unused" } } };
function fixture() {
  return openOperationLog(":memory:", {}, { watch: projectWatchOperation,
    repositories: watchRepositoryProjection(config) });
}
function policy(log: ReturnType<typeof fixture>, development = false, images = false, staging = true) {
  log.append("runner", { type: "repository_policy", repo: "a/repo", policy: { integrationBranch: "develop", releases: true, stagingSkipped: development, staging, images,
    audit: { timeOfDay: "02:00", timeZone: "Europe/London" } } });
}
const landing = { type: "submitted" as const, repo: "a/repo", changeId: "change", commitId: "candidate", bookmark: "b", submittedBy: "author" };
const deploy = { type: "submitted" as const, kind: "deploy" as const, repo: "a/repo", environment: "production", commitId: "old", submittedBy: "runner" };
function publish(log: ReturnType<typeof fixture>) {
  log.append("landing", landing);
  log.append("landing", { type: "landed", commitId: "candidate", base: "old", branch: "develop", remote: "origin" });
}

test("configured repositories include idle repositories, local-day counts and scheduled audit", () => {
  const log = fixture();
  try {
    policy(log, true); publish(log);
    log.append("bad", landing); log.append("bad", { type: "failed", stage: "screening", reason: "screen failed" });
    const snapshot = log.snapshot("runner");
    assert.deepEqual(snapshot.repositories[1], { repo: "a/empty", screeningLanes: 0, today: { landed: 0, failedScreens: 0 }, release: null });
    const repo = snapshot.repositories[0]!;
    assert.deepEqual(repo.today, { landed: 1, failedScreens: 1 });
    assert.equal(repo.screeningLanes, 2);
    assert.equal(repo.release?.candidate?.commitId, "candidate");
    assert.equal(repo.release?.stagingSkipped, true);
    assert.equal(repo.release?.waitingOn.kind, "verification");
    assert.ok(Date.parse(repo.release!.audit!.nextRunAt!) > Date.now());
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0, 0, 0, 0);
    assert.deepEqual(log.snapshot("runner", tomorrow).repositories[0]!.today, { landed: 0, failedScreens: 0 });
  } finally { log.close(); }
});

test("failed and rolled back attempts do not replace live production, even with many later attempts", () => {
  const log = fixture();
  try {
    policy(log); publish(log);
    log.append("live", deploy); log.append("live", { type: "deployed", record: { environment: "production", commitId: "old", previous: null, changes: [], projects: [{ name: "app", ok: true }] } });
    for (let i = 0; i < 12; i++) {
      log.append(`failed${i}`, { ...deploy, commitId: "candidate" });
      log.append(`failed${i}`, { type: "failed", stage: "deploying", reason: "unhealthy", deployment: { environment: "production", commitId: "candidate", previous: "old", changes: [], projects: [], rollback: { automatic: true, reason: "restored" } } });
    }
    const release = log.snapshot("runner").repositories[0]!.release!;
    assert.deepEqual(release.production.live, { commitId: "old", deployedAt: log.operation("live")!.finishedAt!, healthy: null });
    assert.equal(release.production.latestAttempt?.status, "rolled_back");
    assert.equal(release.production.latestAttempt?.reason, "unhealthy");
    log.append("runner", { type: "paused", by: "owner" });
    assert.equal(log.snapshot("runner").repositories[0]!.release!.waitingOn.kind, "paused");
  } finally { log.close(); }
});

test("failed staging attempt preserves the last successful staging deploy", () => {
  const log = fixture();
  try {
    policy(log); publish(log);
    log.append("staging-a", { ...deploy, environment: "staging", commitId: "A" });
    log.append("staging-a", { type: "deployed", record: { environment: "staging", commitId: "A", previous: null, changes: [], projects: [{ name: "app", ok: true }] } });
    log.append("staging-b", { ...deploy, environment: "staging", commitId: "B" });
    log.append("staging-b", { type: "failed", stage: "deploying", reason: "staging activation failed" });
    assert.deepEqual(log.snapshot("runner").repositories[0]!.release!.staging, {
      live: { commitId: "A", deployedAt: log.operation("staging-a")!.finishedAt!, healthy: null },
      latestAttempt: { commitId: "B", status: "failed", at: log.operation("staging-b")!.finishedAt!, reason: "staging activation failed" },
    });
    policy(log, true);
    assert.equal(log.snapshot("runner").repositories[0]!.release!.staging, null);
    policy(log, false, false, false);
    assert.equal(log.snapshot("runner").repositories[0]!.release!.staging, null);
  } finally { log.close(); }
});

test("audit refusal precedes verification; a recorded cause removes the hold", () => {
  const log = fixture();
  try {
    policy(log, true); publish(log);
    log.append("audit", { type: "submitted", kind: "audit", repo: "a/repo", commitId: "candidate", slot: new Date().toISOString(), submittedBy: "runner" });
    log.append("audit", { type: "failed", stage: "verifying", reason: "nightly failed" });
    const release = log.snapshot("runner").repositories[0]!.release!;
    assert.equal(release.waitingOn.kind, "audit"); assert.match(release.waitingOn.detail!, /no cause is recorded/);
    assert.equal(release.audit?.latest?.status, "failed");
    log.append("audit", { type: "audit_cause", cause: { kind: "flake" }, by: "owner" });
    assert.equal(log.snapshot("runner").repositories[0]!.release!.waitingOn.kind, "verification");
  } finally { log.close(); }
});

test("watch names chores and uses one-based lanes only during screening", () => {
  const log = fixture();
  try {
    log.append("landing", landing); log.append("landing", { type: "landing_title", title: "Clean the queue" });
    log.append("landing", { type: "screen_started", slot: 0 }); log.append("landing", { type: "stage", stage: "screening" });
    assert.equal(log.snapshot("runner").lanes.serial[0]!.title, "Clean the queue");
    assert.equal(log.snapshot("runner").lanes.serial[0]!.lane, 1);
    log.append("landing", { type: "screen_admitted", attempt: 1 });
    log.append("landing", { type: "stage", stage: "verifying" });
    assert.equal(log.snapshot("runner").lanes.serial[0]!.lane, undefined);
  } finally { log.close(); }
});

test("successful pre-verification waits for approval; deploy and failure take over; live wins", () => {
  const log = fixture();
  try {
    policy(log); publish(log);
    log.append("verify", { type: "submitted", kind: "verification", repo: "a/repo", commitId: "candidate", submittedBy: "runner" });
    log.append("verify", { type: "verified", base: "old", candidate: "candidate", checks: [], nonAdditiveMigrations: [] });
    const release = () => log.snapshot("runner").repositories[0]!.release!;
    assert.equal(release().waitingOn.kind, "approval");
    log.append("deploy", { ...deploy, commitId: "candidate" });
    assert.equal(release().waitingOn.kind, "deploy");
    assert.equal(release().production.latestAttempt?.status, "running");
    log.append("deploy", { type: "failed", stage: "deploying", reason: "activation failed" });
    assert.equal(release().waitingOn.kind, "failed");
    log.append("retry", { ...deploy, commitId: "candidate" });
    log.append("retry", { type: "deployed", record: { environment: "production", commitId: "candidate", previous: null, changes: [], projects: [
      { name: "app", ok: true, timings: { health: { startedAt: new Date().toISOString(), durationMs: 1, outcome: "passed" } } },
    ] } });
    assert.equal(release().waitingOn.kind, "up_to_date");
    assert.equal(release().production.live?.healthy, true);
    assert.equal(release().production.latestAttempt, null);
  } finally { log.close(); }
});


test("heartbeats and command progress reuse ledger projections while the audit clock advances", () => {
  const log = fixture();
  try {
    policy(log);
    const before = new Date("2026-10-30T00:30:00Z"), after = new Date("2026-10-30T02:30:00Z");
    assert.equal(log.snapshot("runner", before).repositories[0]!.release!.audit!.nextRunAt, "2026-10-30T02:00:00.000Z");
    log.landings = () => { throw new Error("Heartbeat must not reload ledger history"); };
    log.append("command", { type: "progress", line: "building the project" });
    assert.equal(log.snapshot("runner", after).repositories[0]!.release!.audit!.nextRunAt, "2026-10-31T02:00:00.000Z");
  } finally { log.close(); }
});


test("images convention reports none, queued/running, failed and built from deploy facts", () => {
  const log = fixture();
  try {
    policy(log, true, true); publish(log);
    const release = () => log.snapshot("runner").repositories[0]!.release!;
    assert.deepEqual(release().images, { commitId: "candidate", status: "none", at: null, reason: null });
    assert.equal(release().waitingOn.kind, "images");
    log.append("images", { ...deploy, environment: "images", commitId: "candidate" });
    assert.equal(release().images?.status, "building");
    assert.equal(release().images?.at, log.operation("images")!.submittedAt);
    assert.equal(release().waitingOn.kind, "images");
    log.append("images", { type: "stage", stage: "deploying" });
    assert.equal(release().images?.status, "building");
    assert.equal(release().waitingOn.kind, "images");
    log.append("images", { type: "failed", stage: "deploying", reason: "registry refused upload" });
    assert.deepEqual(release().images, { commitId: "candidate", status: "failed", at: log.operation("images")!.finishedAt, reason: "registry refused upload" });
    assert.deepEqual(release().waitingOn, { kind: "failed", detail: "registry refused upload" });
    log.append("retry-images", { ...deploy, environment: "images", commitId: "candidate" });
    assert.equal(release().images?.status, "building");
    log.append("retry-images", { type: "deployed", record: { environment: "images", commitId: "candidate", previous: null, changes: [], projects: [{ name: "images", ok: true }] } });
    assert.deepEqual(release().images, { commitId: "candidate", status: "built", at: log.operation("retry-images")!.finishedAt, reason: null });
    assert.equal(release().waitingOn.kind, "verification");
  } finally { log.close(); }
});

test("candidate images take precedence over newer other-commit builds; older builds do not satisfy its wait", () => {
  const log = fixture();
  try {
    policy(log, false, true); publish(log);
    const release = () => log.snapshot("runner").repositories[0]!.release!;
    const built = (id: string, commitId: string) => {
      log.append(id, { ...deploy, environment: "images", commitId });
      log.append(id, { type: "deployed", record: { environment: "images", commitId, previous: null, changes: [], projects: [{ name: "images", ok: true }] } });
    };
    built("old-images", "old");
    assert.equal(release().images?.commitId, "old");
    assert.equal(release().images?.status, "built");
    assert.equal(release().waitingOn.kind, "images");
    log.append("runner", { type: "paused", by: "owner" });
    assert.equal(release().waitingOn.kind, "paused");
    log.append("runner", { type: "resumed", by: "owner" });
    built("candidate-images", "candidate"); built("other-images", "other");
    assert.equal(release().images?.commitId, "candidate");
    assert.equal(release().waitingOn.kind, "verification");
    policy(log);
    assert.equal(release().images, null);
  } finally { log.close(); }
});

test("images wait precedes audit, and a live candidate outranks an image rebuild", () => {
  const log = fixture();
  try {
    policy(log, true, true); publish(log);
    log.append("audit", { type: "submitted", kind: "audit", repo: "a/repo", commitId: "candidate", slot: new Date().toISOString(), submittedBy: "runner" });
    log.append("audit", { type: "failed", stage: "verifying", reason: "nightly failed" });
    const release = () => log.snapshot("runner").repositories[0]!.release!;
    assert.equal(release().waitingOn.kind, "images");
    log.append("images", { ...deploy, environment: "images", commitId: "candidate" });
    log.append("images", { type: "deployed", record: { environment: "images", commitId: "candidate", previous: null, changes: [], projects: [] } });
    assert.equal(release().waitingOn.kind, "audit");
    assert.match(release().waitingOn.detail!, /no cause is recorded/);
    log.append("live", { ...deploy, commitId: "candidate" });
    log.append("live", { type: "deployed", record: { environment: "production", commitId: "candidate", previous: null, changes: [], projects: [] } });
    log.append("rebuild", { ...deploy, environment: "images", commitId: "candidate" });
    assert.equal(release().images?.status, "building");
    assert.equal(release().waitingOn.kind, "up_to_date");
  } finally { log.close(); }
});
