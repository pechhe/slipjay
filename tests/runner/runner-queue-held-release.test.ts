import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { createRunnerHandler } from "../../src/lib/runner/runner-api.ts";
import { releaseHeldIntegration } from "../../src/lib/runner/runner-client.ts";
import { serveRunner } from "../../src/lib/runner/runner-http.ts";
import { RUNNER_CONTROL_ID } from "../../src/lib/runner/runner-contract.ts";
import { test, jj, fixture, until } from "./fixtures/runner-queue-fixture.ts";

async function releaseServer(f: Awaited<ReturnType<typeof fixture>>) {
  return serveRunner(createRunnerHandler({ log: f.log, token: "fixture-token", runnerName: "fixture",
    readLog: f.queue.readLog, onSubmitted: f.queue.wake, kill: f.queue.kill, releaseHeld: f.queue.releaseHeld,
    subscribe: () => () => {} }), { host: "127.0.0.1", port: 0 });
}
const env = { ...process.env, SLIPJAY_RUNNER_TOKEN: "fixture-token" };

test("the sanctioned release clears a pre-command hold, records its requester and lets the next landing proceed", async () => {
  const f = await fixture(true);
  const server = await releaseServer(f);
  try {
    await f.candidate("schema/held.ts");
    const file = join(f.author, "slipjay.json");
    const policy = JSON.parse(await readFile(file, "utf8"));
    policy.postIntegration.targetProbe.args = ["-e", 'console.log(JSON.stringify({target:"wrong-db"}))'];
    await writeFile(file, JSON.stringify(policy));
    const id = f.submit(await f.push());
    assert.equal((await f.land(id))?.type, "failed");
    const [hold] = f.log.held();
    assert.equal(hold?.targetReached, false);
    assert.deepEqual(await f.development(), [], "the command never ran");
    const result = await releaseHeldIntegration(server.url, "fixture/repo", env);
    assert.equal(result.ok, true, result.line);
    assert.deepEqual(f.log.held(), []);
    const released = f.log.events().findLast((row) => row.event.type === "integration_released")?.event;
    assert.equal(released?.type === "integration_released" && released.by, hostname());
    assert.equal(jj(join(f.home, "repos/fixture/repo"), ["log", "-r", "main", "--no-graph", "-T", "commit_id"]), f.main());
    assert.equal((await f.land(f.submit(await f.candidate("next.txt"))))?.type, "landed");
    assert.equal((await releaseHeldIntegration(server.url, "fixture/repo", env)).ok, false, "nothing held is refused");
  } finally { await server.close(); await f.dispose(); }
}, 180_000);

test("release refuses a command that ran, and unknown evidence in any retry stays conservative", async () => {
  const f = await fixture(true);
  try {
    await writeFile(join(f.root, "fail-finalize"), "");
    assert.equal((await f.land(f.submit(await f.candidate("schema/ran.ts"))))?.type, "failed");
    const [hold] = f.log.held();
    assert.equal(hold?.targetReached, true);
    const refusal = await f.queue.releaseHeld("fixture/repo", "agent");
    assert.equal(refusal.ok, false); assert.match(refusal.reason, /may have reached/);
    assert.deepEqual(f.log.held(), [hold]);
    // A later retry that fails before its command cannot erase an earlier unknown attempt.
    f.log.append(RUNNER_CONTROL_ID, { type: "integration_held", repo: hold!.repo, commitId: hold!.commitId, reason: "legacy unknown attempt" });
    f.log.append(RUNNER_CONTROL_ID, { type: "integration_held", repo: hold!.repo, commitId: hold!.commitId, reason: "probe failed", targetReached: false });
    assert.equal(f.log.held()[0]?.targetReached, true);
    assert.equal((await f.queue.releaseHeld("fixture/repo", "agent")).ok, false);
    assert.equal(f.log.held().length, 1);
    assert.ok(!f.log.events().some((row) => row.event.type === "integration_released"));
  } finally { await f.dispose(); }
}, 180_000);

test("release refuses an integration already published without changing its hold", async () => {
  const f = await fixture();
  try {
    const id = f.submit(await f.candidate("published.txt"));
    assert.equal((await f.land(id))?.type, "landed");
    f.log.append(RUNNER_CONTROL_ID, { type: "integration_held", repo: "fixture/repo", commitId: f.main(), reason: "unconfirmed publication", targetReached: false, branch: "main", remote: "origin" });
    const before = f.log.held();
    const result = await f.queue.releaseHeld("fixture/repo", "agent");
    assert.equal(result.ok, false); assert.match(result.reason, /already on the remote/);
    assert.deepEqual(f.log.held(), before);
  } finally { await f.dispose(); }
}, 120_000);

test("an unfinalisable candidate policy is declined before verification and creates no hold", async () => {
  const f = await fixture(false, false, undefined, true);
  try {
    await f.candidate("invalid.txt");
    const file = join(f.author, "slipjay.json");
    const policy = JSON.parse(await readFile(file, "utf8"));
    policy.reset.intervalMs = 1;
    await writeFile(file, JSON.stringify(policy));
    const id = f.submit(await f.push());
    const result = await f.land(id);
    assert.equal(result?.type, "declined", JSON.stringify(result));
    assert.match(result?.type === "declined" ? result.reason : "", /Invalid reset identity, deadline or interval/);
    assert.equal(f.log.operation(id)?.runs.length, 0);
    assert.ok(!f.log.events({ operationId: id }).some((row) => row.event.type === "stage" && row.event.stage === "verifying"));
    const classified = f.log.events({ operationId: id }).findLast((row) => row.event.type === "classified")?.event;
    assert.equal(classified?.type === "classified" && classified.cause, "policy");
    assert.deepEqual(f.log.held(), []);
  } finally { await f.dispose(); }
}, 120_000);

test("an interval-less reset is never scheduled but still runs on demand", async () => {
  const f = await fixture(false, false, undefined, true);
  try {
    await f.candidate("manual-reset.txt");
    const file = join(f.author, "slipjay.json");
    const policy = JSON.parse(await readFile(file, "utf8"));
    delete policy.reset.intervalMs;
    await writeFile(file, JSON.stringify(policy));
    assert.equal((await f.land(f.submit(await f.push())))?.type, "landed");
    assert.deepEqual(f.log.resets("fixture/repo"), []);
    const id = f.submitReset();
    assert.equal((await f.land(id))?.type, "reset");
    assert.equal(f.log.resets("fixture/repo").length, 1);
    assert.equal((await f.lines("reset.jsonl")).length, 1);
  } finally { await f.dispose(); }
}, 120_000);


test("release waits behind an active finalization and refuses its reached outcome", async () => {
  const f = await fixture(true);
  let pending: Promise<{ ok: boolean; reason: string }> | undefined;
  try {
    await writeFile(join(f.root, "hold-finalize"), "");
    await writeFile(join(f.root, "fail-finalize"), "");
    const id = f.submit(await f.candidate("schema/running.ts"));
    f.queue.wake();
    await until(() => {
      const operation = f.log.operation(id);
      return operation?.stage === "finalizing" && operation.runs.filter((run) => run.purpose === "finalization").length === 2 ? true : undefined;
    });
    pending = f.queue.releaseHeld("fixture/repo", "agent");
    await rm(join(f.root, "hold-finalize"));
    const result = await pending;
    assert.equal(result.ok, false); assert.match(result.reason, /may have reached/);
    await f.queue.idle();
    assert.equal(f.log.held()[0]?.targetReached, true);
    assert.ok(!f.log.events().some((row) => row.event.type === "integration_released"));
  } finally {
    await rm(join(f.root, "hold-finalize"), { force: true });
    await pending;
    await f.dispose();
  }
}, 180_000);

test("a failed publication with no post-integration target may be released", async () => {
  const f = await fixture();
  try {
    const candidate = await f.candidate("unpublished.txt");
    await writeFile(join(f.root, "reject-push"), "");
    assert.equal((await f.land(f.submit(candidate)))?.type, "failed");
    assert.equal(f.log.held()[0]?.targetReached, false);
    const released = await f.queue.releaseHeld("fixture/repo", "agent");
    assert.equal(released.ok, true, released.reason);
    assert.deepEqual(f.log.held(), []);
    await rm(join(f.root, "reject-push"));
    assert.equal((await f.land(f.submit(await f.candidate("following.txt"))))?.type, "landed");
  } finally { await f.dispose(); }
}, 120_000);
