import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openOperationLog } from "../src/lib/runner-log.ts";
import type { CompletedRelease, OperationEvent } from "../src/lib/runner-contract.ts";
import type { WatchEnvelope } from "../src/lib/runner-watch.ts";
import { fixtureRelease } from "./menu-lifecycle-fixture.ts";

/** Generate the Swift notification fixture from the runner's typed ledger/projection. */
export function menuNotificationFixture(): string {
  const log = openOperationLog(":memory:");
  const at = "2026-10-14T00:00:00Z";
  const envelopes: WatchEnvelope[] = [{ version: 1, type: "snapshot", snapshot: { ...log.snapshot("fixture-runner"), observedAt: at } }];
  const result: CompletedRelease = { ...fixtureRelease, releasedAt: at };
  const facts: [string, OperationEvent][] = [
    ["release-failure", { type: "submitted", kind: "release", repo: "fixture/repo", commitId: "failed-candidate", migrationsReady: false, submittedBy: "owner" }],
    ["release-failure", { type: "stage", stage: "verifying" }],
    ["release-failure", { type: "failed", stage: "verifying", reason: "fixture gate failure", command: "bun run verify:release" }],
    ["release", { type: "submitted", kind: "release", repo: "fixture/repo", commitId: result.candidate, migrationsReady: false, submittedBy: "owner" }],
    ["release", { type: "released", result, deploy: "deploy" }],
    ["deploy", { type: "submitted", kind: "deploy", environment: "production", repo: "fixture/repo", commitId: result.merge, submittedBy: "owner", promotion: { merge: result.merge, nonAdditiveMigrations: [] } }],
    ["deploy", { type: "deployed", record: { environment: "production", commitId: result.merge, previous: null, changes: [], projects: [{ name: "app", ok: true, activated: true }] } }],
    ["rollback", { type: "submitted", kind: "deploy", environment: "production", repo: "fixture/repo", commitId: "failed-merge", submittedBy: "owner" }],
    ["rollback", { type: "failed", stage: "deploying", reason: "fixture deploy failure", deployment: { environment: "production", commitId: "failed-merge", previous: result.merge, changes: [], projects: [], rollback: { automatic: true, reason: "restored", releaseBranch: "previous-release" }, migrations: { artifacts: [], status: "applied" } } }],
    ["superseded", { type: "submitted", repo: "fixture/repo", changeId: "same-change", commitId: "old-submission", bookmark: "slipjay/changes/same-change", submittedBy: "owner" }],
    ["superseded", { type: "superseded", by: "new-submission" }],
  ];
  try {
    for (const [id, fact] of facts) log.append(id, fact);
    for (const event of log.events()) envelopes.push({ version: 1, type: "event", event });
    // Timestamps are fixture data; sequence, payloads and projections come from the ledger.
    return envelopes.map((envelope) => JSON.stringify(envelope.type === "event" ? { ...envelope, event: { ...envelope.event, at } } : envelope)).join("\n") + "\n";
  } finally { log.close(); }
}

if (import.meta.main) await writeFile(fileURLToPath(new URL("../macos/fixtures/notification-events.jsonl", import.meta.url)), menuNotificationFixture());
