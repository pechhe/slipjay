import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createDeployScheduler } from "../src/lib/deploy-scheduler.ts";
import type { DeploymentEnvironment } from "../src/lib/deployment-policy.ts";
import { openOperationLog } from "../src/lib/runner-log.ts";

const HOUR = 3_600_000;
const staging: DeploymentEnvironment = { minIntervalMs: HOUR, timeoutMs: 60_000, environmentKeys: [], projects: [{ name: "app", command: { executable: "true", args: [], cwd: "." } }] };

function fixture() {
  const log = openOperationLog(":memory:");
  let clock = Date.now();
  let landings = 0;
  const submitted: string[] = [];
  const scheduler = createDeployScheduler({ log, now: () => clock,
    submit(repo, environment, commitId) {
      submitted.push(commitId);
      log.append(`deploy-${submitted.length}`, { type: "submitted", kind: "deploy", repo, environment, commitId, submittedBy: "schedule" });
    } });
  return {
    log, scheduler, submitted,
    advance(ms: number) { clock += ms; },
    land(commitId: string) {
      const id = `landing-${++landings}`;
      log.append(id, { type: "submitted", repo: "owner/repo", changeId: "k".repeat(32), commitId, bookmark: "b", submittedBy: "author" });
      log.append(id, { type: "landed", base: "base", commitId, branch: "main", remote: "origin" });
    },
    finish(id: string, outcome: "deployed" | "failed" | "restarted") {
      const operation = log.operation(id)!;
      const record = { environment: "staging", commitId: operation.commitId, previous: null, changes: [], projects: [{ name: "app", ok: outcome === "deployed" }] };
      log.append(id, outcome === "deployed" ? { type: "deployed", record }
        : outcome === "failed" ? { type: "failed", stage: "deploying", reason: "deploy failed: app", deployment: record }
          : { type: "failed", stage: "deploying", reason: "runner restarted during deploying" });
    },
  };
}

test("a first landing deploys at once; later ones wait for the interval, then deploy only the latest commit", () => {
  const f = fixture();
  try {
    f.scheduler.consider("owner/repo", { staging });
    assert.deepEqual(f.submitted, [], "nothing has landed");
    f.land("a".repeat(40));
    f.scheduler.consider("owner/repo", { staging });
    assert.deepEqual(f.submitted, ["a".repeat(40)]);
    f.land("b".repeat(40));
    f.scheduler.consider("owner/repo", { staging });
    assert.equal(f.submitted.length, 1, "an open deploy holds the next one");
    f.finish("deploy-1", "deployed");
    f.scheduler.consider("owner/repo", { staging });
    assert.equal(f.submitted.length, 1, "within the hour, the next deploy waits");
    f.land("c".repeat(40));
    // The log stamps submissions with the wall clock, a few ms after this clock started.
    f.advance(HOUR + 1_000);
    f.scheduler.consider("owner/repo", { staging });
    assert.deepEqual(f.submitted, ["a".repeat(40), "c".repeat(40)], "skips straight to the latest landing");
  } finally { f.scheduler.close(); f.log.close(); }
});

test("an unchanged branch never redeploys, a commit whose projects failed retries only on demand, and one the runner never ran retries", () => {
  const f = fixture();
  try {
    f.land("a".repeat(40));
    f.scheduler.consider("owner/repo", { staging });
    f.finish("deploy-1", "deployed");
    f.advance(2 * HOUR);
    f.scheduler.consider("owner/repo", { staging });
    assert.equal(f.submitted.length, 1, "the branch has not moved");
    f.land("b".repeat(40));
    f.scheduler.consider("owner/repo", { staging });
    f.finish("deploy-2", "failed");
    f.advance(2 * HOUR);
    f.scheduler.consider("owner/repo", { staging });
    assert.equal(f.submitted.length, 2, "a failed deploy of the same commit is not retried on schedule");
    f.land("c".repeat(40));
    f.advance(2 * HOUR);
    f.scheduler.consider("owner/repo", { staging });
    f.finish("deploy-3", "restarted");
    f.advance(2 * HOUR);
    f.scheduler.consider("owner/repo", { staging });
    assert.deepEqual(f.submitted.slice(2), ["c".repeat(40), "c".repeat(40)], "a deploy interrupted before its projects ran is retried");
  } finally { f.scheduler.close(); f.log.close(); }
});

test("a deploy that is not due yet is submitted by one timer when the interval ends", async () => {
  const f = fixture();
  const short = { ...staging, minIntervalMs: 50 };
  try {
    f.land("a".repeat(40));
    f.scheduler.consider("owner/repo", { staging: short });
    f.finish("deploy-1", "deployed");
    f.land("b".repeat(40));
    f.scheduler.consider("owner/repo", { staging: short });
    f.scheduler.consider("owner/repo", { staging: short });
    assert.equal(f.submitted.length, 1);
    // Past the due time even with the log's wall-clock stamp a few ms ahead of this clock.
    f.advance(1_000);
    for (const deadline = Date.now() + 5_000; f.submitted.length < 2 && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(f.submitted, ["a".repeat(40), "b".repeat(40)], "one timer, one deploy");
  } finally { f.scheduler.close(); f.log.close(); }
});
