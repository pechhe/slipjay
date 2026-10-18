import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vite-plus/test";
import { parseExecutionPolicy } from "../src/lib/execution-policy.ts";
import { commitIssue, withIssueTrailer } from "../src/lib/issue-references.ts";
import { controlRunner, landThroughRunner, readBuildThroughRunner } from "../src/lib/runner-client.ts";
import { createWorkspace } from "../src/lib/slipjay.ts";
import { metadataPath } from "../src/lib/workspace-state.ts";
import { repairFailedLanding } from "../src/lib/repair-workspace.ts";
import { buildRoute } from "../src/lib/build-admission.ts";
import { buildLandingHandoff } from "../src/lib/build-handoff.ts";
import { BuildRefusal, buildItemClosed, trackerOf, workItemClosed, workItemTitle } from "../src/lib/tracker.ts";
import type { BuildItem, BuildReader } from "../src/lib/tracker.ts";
import { jj, landThroughTestRunner, project, withTestRunner } from "./support/workspace-project.ts";

const item = (fields: Partial<BuildItem> & Pick<BuildItem, "number">): BuildItem =>
  ({ id: `00000000-0000-4000-8000-${String(fields.number).padStart(12, "0")}`, kind: "ticket", status: "ready", parentId: null, title: `Item ${fields.number}`, ...fields });

/** A Build reader answering from `items`, by number or id, and listing a parent's Tickets. */
function build(items: BuildItem[]): { read: BuildReader; calls: string[] } {
  const calls: string[] = [];
  const read: BuildReader = async (action, input) => {
    calls.push(`${action} ${JSON.stringify(input)}`);
    if (action === "list") return items.filter((entry) => entry.parentId === input.parentId && entry.kind === input.kind);
    const found = items.find((entry) => entry.number === input.number || entry.id === input.itemId);
    if (!found) throw new BuildRefusal("read", "build_item_unavailable");
    return found;
  };
  return { read, calls };
}

/**
 * A stand-in for Build's runner route on loopback: reads from `items` and `binds` (by Spec id), and
 * accepts the runner's admissions and receipts, recording every request. Clearing `admits` leaves admissions
 * unanswered; clearing `answers` leaves every request unanswered. A `held` promise delays the next `binds` answer until it settles.
 */
async function buildServer(token: string, items: BuildItem[], binds: Record<string, { generation: number; endedAt: string | null }[]> = {}) {
  const requests: { action: string; input: Record<string, unknown> }[] = [];
  const state: { admits: boolean; answers: boolean; held?: Promise<void> } = { admits: true, answers: true };
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", async () => {
      const reply = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
      if (request.url !== "/api/build/runner" || request.headers.authorization !== `Bearer ${token}`) return reply(401, { status: "unauthorised", code: "runner_unauthenticated" });
      const { action, input } = JSON.parse(text) as { action: string; input: Record<string, unknown> };
      requests.push({ action, input });
      if (!state.answers || action === "admitAttempt" && !state.admits) return reply(503, { status: "unavailable", code: "hq_build_store_unavailable" });
      if (action === "read") {
        const found = items.find((entry) => entry.number === input.number || entry.id === input.itemId);
        // As Build does: an unknown item is its `unavailable` outcome, which the route sends as 503.
        return found ? reply(200, { status: "succeeded", value: found }) : reply(503, { status: "unavailable", code: "build_item_unavailable" });
      }
      if (action === "binds" && state.held) { const held = state.held; state.held = undefined; await held; }
      if (action === "binds") return reply(200, { status: "succeeded", value: binds[input.specId as string] ?? [] });
      if (action === "admitAttempt") return reply(200, { status: "succeeded", value: { admission: { recordedAt: new Date().toISOString() } } });
      if (["recordAttempt", "recordAttemptRun", "recordChoreLanding"].includes(action)) return reply(200, { status: "succeeded", value: null });
      return reply(400, { status: "invalid", code: "runner_action_invalid" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, state, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Waits until `condition` holds, failing after `timeoutMs`. */
async function until(condition: () => boolean, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("slipjay.json chooses the tracker: GitHub unless it declares Build, and nothing else", () => {
  const policy = (extra: Record<string, unknown>) => JSON.stringify({ version: 1, requiredLandingVerification: [], ...extra });
  assert.equal(trackerOf(parseExecutionPolicy(policy({}))), "github");
  assert.equal(trackerOf(parseExecutionPolicy(policy({ tracker: "github" }))), "github");
  assert.equal(trackerOf(parseExecutionPolicy(policy({ tracker: "build" }))), "build");
  assert.throws(() => parseExecutionPolicy(policy({ tracker: "linear" })), /tracker other than "github" or "build"/);
});

test("a Build-tracked landing names its item in a Build trailer, which promotion reads back", () => {
  assert.equal(withIssueTrailer("Do it", 41, "o/r", "build"), "Do it\n\nBuild: #41");
  assert.equal(withIssueTrailer("Do it", 41, "o/r"), "Do it\n\nIssue: o/r#41");
  // `#N` in a description may be a GitHub reference, so it never stands in for the Build trailer.
  assert.equal(withIssueTrailer("Implement #41", 41, "o/r", "build"), "Implement #41\n\nBuild: #41");
  assert.equal(withIssueTrailer("Fix o/r#41", 41, "o/r", "build"), "Fix o/r#41\n\nBuild: #41");
  assert.equal(withIssueTrailer("Do it\n\nBuild: #41", 41, "o/r", "build"), "Do it\n\nBuild: #41");
  assert.equal(commitIssue("Do it\n\nBuild: #41", "o/r", "build"), 41);
  // Only the Build trailer names a Build item: GitHub references from before the switch name none.
  for (const description of ["Fix workspace (#48)", "Fixes #48", "Do it\n\nIssue: o/r#48"]) assert.equal(commitIssue(description, "o/r", "build"), null, description);
});

test("a Build item is closed once nothing is left to deliver, and a legacy item always is", async () => {
  for (const status of ["landed", "accepted", "dropped", "achieved", "superseded", "imported_closed"]) assert.equal(buildItemClosed({ kind: "ticket", status }), true, status);
  for (const status of ["inbox", "shaping", "ready", "in_progress", "open", "proposed"]) assert.equal(buildItemClosed({ kind: "spec", status }), false, status);
  assert.equal(buildItemClosed({ kind: "legacy", status: "ready" }), true);

  const { read } = build([item({ number: 5, status: "dropped" }), item({ number: 6, title: "  Ship it  " }), item({ number: 7, kind: "legacy", status: "imported" })]);
  assert.equal(await workItemClosed("/unused", "build", 5, read), true);
  assert.equal(await workItemClosed("/unused", "build", 6, read), false);
  assert.equal(await workItemClosed("/unused", "build", 7, read), true);
  assert.equal(await workItemTitle("/unused", "build", 6, read), "Ship it");
  // Unknown, never guessed: a missing item, or no way to read Build, keeps the workspace and the description as they are.
  assert.equal(await workItemClosed("/unused", "build", 8, read), null);
  assert.equal(await workItemClosed("/unused", "build", 6), null);
  assert.equal(await workItemTitle("/unused", "build", 6), null);
});

test("a client reads Build only through the runner, and only Build's read actions", async () => {
  const f = await project();
  const buildToken = "build-secret";
  const fake = await buildServer(buildToken, [item({ number: 77, title: "From Build" })]);
  try {
    await withTestRunner(f, async ({ location, env }) => {
      assert.equal(((await readBuildThroughRunner("read", { number: 77 }, env)) as BuildItem).title, "From Build");
      await assert.rejects(readBuildThroughRunner("read", { number: 78 }, env), /Build refused read: build_item_unavailable/);
      const refuse = await fetch(`${location}/v1/build/read`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        body: JSON.stringify({ action: "setStatus", input: {} }) });
      assert.equal(refuse.status, 400);
      assert.deepEqual(fake.requests.map((request) => request.action), ["read", "read"], "a write action never reaches Build");
    }, { build: { origin: fake.origin, token: buildToken } });
    // A runner without a Build connection refuses the read rather than answering for Build.
    await withTestRunner(f, async ({ env }) => {
      await assert.rejects(readBuildThroughRunner("read", { number: 77 }, env), /no Build connection/);
    });
  } finally {
    await fake.close();
    await f.dispose();
  }
}, 120_000);

const SESSION = "11111111-2222-4333-8444-555555555555";

test("a Build-tracked landing of a Ticket writes its own Build handoff: the Ticket's Spec, its current bind and the lead's session", async () => {
  const f = await project({ policy: { tracker: "build" } });
  const buildToken = "build-secret";
  const spec = item({ number: 96610, kind: "spec", status: "in_progress", title: "The Spec", bodyRevision: 4 });
  const ticket = item({ number: 96611, parentId: spec.id, title: "Title from Build" });
  const fake = await buildServer(buildToken, [spec, ticket], { [spec.id]: [{ generation: 2, endedAt: "2026-10-16T00:00:00Z" }, { generation: 3, endedAt: null }] });
  const workspace = await createWorkspace("Placeholder task", f.repo, { issueNumber: 96611 });
  try {
    await writeFile(join(workspace.workspacePath, "a.txt"), "a\n");
    const landed = await landThroughTestRunner(f, workspace.workspacePath, { build: { origin: fake.origin, token: buildToken }, session: SESSION });
    assert.equal(landed.ok, true, landed.lines.join("\n"));
    const message = execFileSync("git", ["--git-dir", f.remote, "log", "-1", "--format=%B", "main"], { encoding: "utf8" }).trim();
    assert.equal(message, "Title from Build\n\nBuild: #96611");
    const admission = fake.requests.find((request) => request.action === "admitAttempt")?.input;
    assert.ok(admission, "Build was asked to admit the landing");
    assert.deepEqual({ specId: admission.specId, ticketIds: admission.ticketIds, specBodyRevision: admission.specBodyRevision, bindGeneration: admission.bindGeneration, sessionId: admission.sessionId },
      { specId: spec.id, ticketIds: [ticket.id], specBodyRevision: 4, bindGeneration: 3, sessionId: SESSION });
  } finally {
    await rm(workspace.workspacePath, { recursive: true, force: true });
    await fake.close();
    await f.dispose();
  }
}, 120_000);

test("a Build-tracked landing with no Build item is reported to Build as a chore", async () => {
  const f = await project({ policy: { tracker: "build" } });
  const buildToken = "build-secret";
  const fake = await buildServer(buildToken, []);
  const workspace = await createWorkspace("Tidy", f.repo);
  try {
    await writeFile(join(workspace.workspacePath, "a.txt"), "a\n");
    jj(workspace.workspacePath, ["describe", "-m", "Tidy the readme"]);
    const landed = await landThroughTestRunner(f, workspace.workspacePath, { build: { origin: fake.origin, token: buildToken },
      // Receipts go on the runner's own schedule: wait for the chore before the runner closes.
      before: () => until(() => fake.requests.some((request) => request.action === "recordChoreLanding"), "the chore receipt") });
    assert.equal(landed.ok, true, landed.lines.join("\n"));
    const chore = fake.requests.find((request) => request.action === "recordChoreLanding")!.input;
    assert.equal(chore.unassociated, true);
    assert.equal(fake.requests.some((request) => request.action === "admitAttempt"), false, "a chore is never admitted");
  } finally {
    await rm(workspace.workspacePath, { recursive: true, force: true });
    await fake.close();
    await f.dispose();
  }
}, 120_000);

test("a retried Build landing replays the handoff it first wrote, and following one needs neither the session nor Build", async () => {
  const f = await project({ policy: { tracker: "build" } });
  const buildToken = "build-secret";
  const spec = item({ number: 96620, kind: "spec", status: "in_progress", bodyRevision: 4 });
  const ticket = item({ number: 96621, parentId: spec.id });
  const binds = { [spec.id]: [{ generation: 3, endedAt: null as string | null }] };
  const fake = await buildServer(buildToken, [spec, ticket], binds);
  const workspace = await createWorkspace("Placeholder task", f.repo, { issueNumber: 96621 });
  try {
    await writeFile(join(workspace.workspacePath, "a.txt"), "a\n");
    await withTestRunner(f, async ({ location, env }) => {
      const land = (session?: string) => landThroughRunner(workspace.workspacePath, { location, env, session, onLine: () => {} });
      fake.state.admits = false;
      await assert.rejects(land(SESSION), /Build admission did not complete/);
      // Another candidate written meanwhile keeps its own handoff, not this one's, and retention beyond
      // its cap forgets only acknowledged ones: here 40 older candidates whose requests were acknowledged.
      const metadataFile = metadataPath(workspace.current.name);
      const metadata = JSON.parse(await readFile(metadataFile, "utf8")) as { landingHandoffs: Record<string, unknown> };
      const older = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`acknowledged-${index}`, {}]));
      await writeFile(metadataFile, JSON.stringify({ ...metadata, landingHandoffs: { ...older, ...metadata.landingHandoffs } }));
      const first = jj(workspace.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]).trim();
      jj(workspace.workspacePath, ["new"]);
      await writeFile(join(workspace.workspacePath, "b.txt"), "b\n");
      await assert.rejects(land(SESSION), /Build admission did not complete/);
      jj(workspace.workspacePath, ["edit", first]);
      const retained = Object.keys((JSON.parse(await readFile(metadataFile, "utf8")) as { landingHandoffs: Record<string, unknown> }).landingHandoffs);
      assert.deepEqual([retained.length, retained.filter((key) => key.startsWith("acknowledged-")).length], [34, 32]);
      // Build moves on before the retry: regenerated evidence would no longer match what was submitted.
      spec.bodyRevision = 5;
      binds[spec.id] = [{ generation: 3, endedAt: "2026-10-17T00:00:00Z" }, { generation: 4, endedAt: null }];
      // Counted from before Build admits again: the runner's own drain may resend the admission before the client does.
      const retrying = fake.requests.length;
      fake.state.admits = true;
      await controlRunner(location, "pause", env);
      const following = new AbortController();
      const followed: string[] = [];
      const retried = landThroughRunner(workspace.workspacePath, { location, env, signal: following.signal, onLine: (line) => { followed.push(line); } }).catch(() => undefined);
      // The client's own retry was accepted and is being followed, whichever of it or the drain sent the admission.
      await until(() => followed.some((line) => line.startsWith("[runner ")) && fake.requests.slice(retrying).some((request) => request.action === "admitAttempt"),
        "the retried submission and its admission");
      following.abort();
      await retried;
      // The client reads nothing from Build again: the admission carries the evidence first written. Only the
      // runner reads, by id, the numbers of the items Build admitted.
      const retry = fake.requests.slice(retrying);
      for (const request of retry.filter((request) => request.action !== "admitAttempt"))
        assert.ok(request.action === "read" && [spec.id, ticket.id].includes(request.input.itemId as string), JSON.stringify(request));
      for (const { input } of retry.filter((request) => request.action === "admitAttempt")) assert.deepEqual([input.specBodyRevision, input.bindGeneration, input.sessionId], [4, 3, SESSION]);
      // The submitted landing is followed with no session while Build answers nothing.
      fake.state.answers = false;
      const reads = fake.requests.length;
      await controlRunner(location, "resume", env);
      const landed = await land();
      assert.equal(landed.ok, true);
      assert.equal(fake.requests.slice(reads).some((request) => request.action === "read" || request.action === "binds"), false, "following reads nothing from Build");
    }, { build: { origin: fake.origin, token: buildToken } });
  } finally {
    await rm(workspace.workspacePath, { recursive: true, force: true });
    await fake.close();
    await f.dispose();
  }
}, 180_000);

test("of two landings of one candidate racing to submit, the later follows the one submitted first", async () => {
  const f = await project({ policy: { tracker: "build" } });
  const buildToken = "build-secret";
  const spec = item({ number: 96630, kind: "spec", status: "in_progress", bodyRevision: 1 });
  const ticket = item({ number: 96631, parentId: spec.id });
  const binds = { [spec.id]: [{ generation: 1, endedAt: null as string | null }] };
  const fake = await buildServer(buildToken, [spec, ticket], binds);
  const workspace = await createWorkspace("Placeholder task", f.repo, { issueNumber: 96631 });
  try {
    await writeFile(join(workspace.workspacePath, "a.txt"), "a\n");
    await withTestRunner(f, async ({ location, env }) => {
      await controlRunner(location, "pause", env);
      const following = new AbortController();
      // Each landing settles as following the operation, or the error that stopped it.
      const land = () => new Promise<string>((resolve) => {
        landThroughRunner(workspace.workspacePath, { location, env, session: SESSION, signal: following.signal, onLine: () => resolve("followed") })
          .then(() => resolve("followed"), (error: unknown) => resolve(String(error)));
      });
      let release!: () => void;
      fake.state.held = new Promise<void>((resolve) => { release = resolve; });
      // The slower landing reads Build first, but its bind is answered only after the other has submitted.
      const slower = land();
      await until(() => fake.requests.some((request) => request.action === "binds"), "the held bind read");
      assert.equal(await land(), "followed");
      // Acknowledged: the request identity is cleared, while the operation waits behind the paused queue.
      const metadata = () => JSON.parse(readFileSync(metadataPath(workspace.current.name), "utf8")) as { pendingLandingRequests?: object };
      assert.deepEqual(metadata().pendingLandingRequests, {});
      binds[spec.id] = [{ generation: 1, endedAt: "2026-10-17T00:00:00Z" }, { generation: 2, endedAt: null }];
      release();
      // Build changed since the first was written, so its evidence differs: it follows the operation submitted first.
      assert.equal(await slower, "followed");
      assert.deepEqual(metadata().pendingLandingRequests, {}, "the later landing leaves no unresolved request");
      following.abort();
      assert.deepEqual([...new Set(fake.requests.filter((request) => request.action === "admitAttempt").map((request) => request.input.bindGeneration))], [1]);
    }, { build: { origin: fake.origin, token: buildToken } });
  } finally {
    await rm(workspace.workspacePath, { recursive: true, force: true });
    await fake.close();
    await f.dispose();
  }
}, 180_000);

test("Build's 503 for an unknown item is its refusal; any other 503 is no answer", async () => {
  const answering = (status: number, body: unknown) => buildRoute({ origin: "https://hq.example.com", token: "t",
    fetch: async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }) });
  assert.deepEqual(await answering(503, { status: "unavailable", code: "build_item_unavailable" })("read", { number: 1 }), { kind: "refused", code: "build_item_unavailable" });
  assert.equal((await answering(503, { status: "unavailable", code: "hq_build_store_unavailable" })("read", { number: 1 })).kind, "unavailable");
  assert.equal((await answering(503, "<html>Service Unavailable</html>")("read", { number: 1 })).kind, "unavailable");
});

test("a Build-tracked landing refuses before submitting when Build cannot confirm whose delivery it is", async () => {
  const spec = item({ number: 10, kind: "spec", status: "in_progress" });
  const other = item({ number: 20, kind: "spec", status: "in_progress" });
  const { read } = build([spec, other, item({ number: 11, parentId: spec.id }), item({ number: 12, parentId: spec.id }), item({ number: 21, parentId: other.id }),
    item({ number: 30, kind: "decision", status: "proposed" })]);
  const binds: Record<string, { generation: number; endedAt: string | null }[]> = { [spec.id]: [{ generation: 1, endedAt: null }] };
  const reader: BuildReader = (action, input) => action === "binds" ? Promise.resolve(binds[input.specId as string] ?? []) : read(action, input);
  const request = (fields: Partial<Parameters<typeof buildLandingHandoff>[0]>) =>
    buildLandingHandoff({ source: "a".repeat(40), description: "Do it\n\nBody", issueNumber: 11, tickets: [], sessionId: SESSION, read: reader, ...fields });

  assert.deepEqual((await request({})).build, { specId: spec.id, ticketIds: [item({ number: 11 }).id], bodyRevision: null, bindGeneration: 1, sessionId: SESSION });
  assert.deepEqual((await request({ issueNumber: 10 })).build, { specId: spec.id, ticketIds: [], bodyRevision: null, bindGeneration: 1, sessionId: SESSION }, "a Spec lands with no Tickets");
  assert.deepEqual((await request({ tickets: [12, 11] })).build, { specId: spec.id, ticketIds: [item({ number: 11 }).id, item({ number: 12 }).id], bodyRevision: null, bindGeneration: 1, sessionId: SESSION });
  assert.deepEqual((await request({ issueNumber: null })).build, { unassociated: true });
  assert.equal((await request({})).intent, "Do it");

  await assert.rejects(request({ sessionId: undefined }), /hq_build_start_session.*--session <id>.*HQ_BUILD_SESSION_ID/);
  await assert.rejects(request({ sessionId: "not-a-session" }), /not a session id/);
  await assert.rejects(request({ issueNumber: 21 }), /Spec #20 has no current lead: bind it with hq_build_bind/);
  await assert.rejects(request({ tickets: [21] }), /#21 is not a Ticket of Spec #10/);
  await assert.rejects(request({ issueNumber: 30 }), /is a decision, not a Spec or a Spec's Ticket/);
  await assert.rejects(request({ issueNumber: 99 }), /Build has no item #99/);
  await assert.rejects(request({ issueNumber: null, tickets: [11] }), /--ticket needs a workspace with a Build item/);
});

test("a Build landing's repair keeps its item, lands under the repairer's own session and never as a chore", async () => {
  const f = await project({ policy: { tracker: "build" },
    verify: () => 'if (!require("node:fs").existsSync("fixed.txt")) { console.error("Error: correction required"); process.exit(1); }' });
  const buildToken = "build-secret";
  const spec = item({ number: 96640, kind: "spec", status: "in_progress", bodyRevision: 2 });
  const ticket = item({ number: 96641, parentId: spec.id });
  const binds = { [spec.id]: [{ generation: 1, endedAt: null as string | null }] };
  const fake = await buildServer(buildToken, [spec, ticket], binds);
  const author = await createWorkspace("Placeholder task", f.repo, { issueNumber: 96641 });
  try {
    await writeFile(join(author.workspacePath, "candidate.txt"), "failed source\n");
    await withTestRunner(f, async ({ location, env }) => {
      const failed = await landThroughRunner(author.workspacePath, { location, env, session: SESSION, onLine: () => {} });
      assert.equal(failed.ok, false);
      // Repaired from a fresh clone: the author's workspace still holds #96641 in its own repository.
      const cold = join(f.root, "cold-repository");
      jj(f.root, ["git", "clone", f.remote, cold]);
      jj(cold, ["git", "remote", "set-url", "origin", "https://github.com/fixture/project.git"]);
      for (const [key, value] of [["user.name", "Fixture"], ["user.email", "fixture@example.com"]]) jj(cold, ["config", "set", "--repo", key!, value!]);
      const setup = await repairFailedLanding(cold, failed.operation.id, { location, env });
      assert.equal(setup.issueNumber, 96641, "the repair workspace belongs to the failed landing's Ticket");
      await writeFile(join(setup.workspacePath, "fixed.txt"), "corrected\n");
      const land = (session?: string) => landThroughRunner(setup.workspacePath, { location, env: { ...env, HQ_BUILD_SESSION_ID: "" }, session, onLine: () => {} });
      // Custody is the repairer's own: no session, or a Spec with no current lead, refuses before anything is submitted.
      await assert.rejects(land(), /needs your lead session for Spec #96640/);
      binds[spec.id] = [{ generation: 1, endedAt: "2026-10-17T00:00:00Z" }];
      await assert.rejects(land(SESSION), /has no current lead/);
      binds[spec.id] = [{ generation: 1, endedAt: "2026-10-17T00:00:00Z" }, { generation: 2, endedAt: null }];
      const admissions = fake.requests.length;
      const repaired = await land(SESSION);
      assert.equal(repaired.ok, true);
      const admission = fake.requests.slice(admissions).find((request) => request.action === "admitAttempt")!;
      assert.deepEqual([admission.input.specId, admission.input.ticketIds, admission.input.bindGeneration, admission.input.repairsOperationId],
        [spec.id, [ticket.id], 2, failed.operation.id]);
      assert.equal(fake.requests.slice(admissions).some((request) => request.action === "recordChoreLanding"), false, "never reported as a chore");
    }, { build: { origin: fake.origin, token: buildToken } });
  } finally {
    await rm(author.workspacePath, { recursive: true, force: true });
    await fake.close();
    await f.dispose();
  }
}, 300_000);

/**
 * A repository check that records what SlipJay gave it from Build, appending to `file` under `label`: the binding, and
 * what the runner answered its token for a read of Build #`number`, an unknown item, a write and another route. It prints
 * the token, which must never reach the runner's records. A migration generator also writes a migration.
 */
const buildProbe = (file: string, label: string, number: number, migration = false) => `(async () => {
const fs = require("node:fs"); const e = process.env; const url = e.SLIPJAY_BUILD_READ_URL; let answers = null;
if (url) {
  const headers = { authorization: "Bearer " + e.SLIPJAY_BUILD_READ_TOKEN, "content-type": "application/json" };
  const post = async (action, input) => { const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ action, input }) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  answers = { read: await post("read", { number: ${number} }), unknown: await post("read", { number: 1 }), write: await post("setStatus", {}),
    other: (await fetch(new URL("/v1/queue", url), { headers })).status };
}
${migration ? 'fs.mkdirSync("migrations", { recursive: true }); fs.writeFileSync("migrations/0001.sql", "-- 1\\n");' : ""}
fs.appendFileSync(${JSON.stringify(file)}, JSON.stringify({ label: ${JSON.stringify(label)}, context: e.SLIPJAY_BUILD_CONTEXT ?? null, url: url ?? null, token: e.SLIPJAY_BUILD_READ_TOKEN ?? null, answers }) + "\\n");
console.log("token " + e.SLIPJAY_BUILD_READ_TOKEN);
})()`;
type Probe = { label: string; context: string | null; url: string | null; token: string | null;
  answers: { read: { status: number; body: { value?: BuildItem } }; unknown: { status: number; body: unknown }; write: { status: number }; other: number } | null };

/** Every file under `directory`, as bytes. */
async function filesUnder(directory: string): Promise<Buffer[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return Promise.all(entries.filter((entry) => entry.isFile()).map((entry) => readFile(join(entry.parentPath, entry.name))));
}

test("a Build-tracked landing's checks get its admitted binding and read Build with a token that ends with the operation", async () => {
  const probes = join(await mkdtemp(join(tmpdir(), "build-probe-")), "probes.jsonl");
  const spec = item({ number: 96630, kind: "spec", status: "in_progress", title: "Gated Spec", bodyRevision: 2 });
  const ticket = item({ number: 96631, parentId: spec.id });
  const f = await project({ verify: () => buildProbe(probes, "gate", spec.number), policy: { tracker: "build", migrationFinalization: {
    mode: "late_bound_serialized", triggerPaths: ["schema"], artifactPaths: ["migrations"],
    generate: { executable: "node", args: ["-e", buildProbe(probes, "generate", spec.number, true)] },
    verify: { executable: "node", args: ["-e", buildProbe(probes, "verify", spec.number)] } } } });
  const buildToken = "build-secret";
  const fake = await buildServer(buildToken, [spec, ticket], { [spec.id]: [{ generation: 1, endedAt: null }] });
  const bound = await createWorkspace("Placeholder task", f.repo, { issueNumber: ticket.number });
  const chore = await createWorkspace("Tidy", f.repo);
  const read = (lines: string) => lines.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Probe);
  try {
    await mkdir(join(bound.workspacePath, "schema"), { recursive: true });
    await writeFile(join(bound.workspacePath, "schema", "table.ts"), "table\n");
    await writeFile(join(chore.workspacePath, "a.txt"), "a\n");
    jj(chore.workspacePath, ["describe", "-m", "Tidy the readme"]);
    await withTestRunner(f, async ({ location, env }) => {
      const landed = await landThroughRunner(bound.workspacePath, { location, env, session: SESSION, onLine: () => {} });
      assert.equal(landed.ok, true);
      const runs = read(await readFile(probes, "utf8"));
      assert.deepEqual(runs.map((run) => run.label), ["generate", "verify", "gate"]);
      for (const run of runs) {
        assert.deepEqual(JSON.parse(run.context!), { version: 1, specId: spec.id, specNumber: spec.number, ticketNumbers: [ticket.number], sessionId: SESSION }, run.label);
        assert.equal(run.url, `${location}/v1/build/read`);
        assert.equal(run.token, runs[0]!.token, "one token for the operation's checks");
        assert.notEqual(run.token, "test-token");
        assert.notEqual(run.token, buildToken);
        // Build's own answers, and nothing beyond its read actions.
        assert.equal(run.answers!.read.status, 200);
        assert.equal(run.answers!.read.body.value?.title, "Gated Spec");
        assert.deepEqual(run.answers!.unknown, { status: 409, body: { code: "build_item_unavailable" } });
        assert.equal(run.answers!.write.status, 400);
        assert.equal(run.answers!.other, 401);
      }
      assert.equal(fake.requests.some((request) => request.action === "setStatus"), false);
      // The operation has ended: its token reads nothing now.
      const after = await fetch(runs[0]!.url!, { method: "POST", headers: { authorization: `Bearer ${runs[0]!.token}`, "content-type": "application/json" },
        body: JSON.stringify({ action: "read", input: { number: spec.number } }) });
      assert.equal(after.status, 401);

      // A chore is bound to no Spec: it may read Build, with a token of its own, but has no binding.
      const tidy = await landThroughRunner(chore.workspacePath, { location, env, onLine: () => {} });
      assert.equal(tidy.ok, true);
      const choreRun = read(await readFile(probes, "utf8")).at(-1)!;
      assert.equal(choreRun.context, null);
      assert.equal(choreRun.answers!.read.status, 200);
      assert.notEqual(choreRun.token, runs[0]!.token);
      for (const token of [runs[0]!.token!, choreRun.token!])
        for (const file of await filesUnder(join(f.root, "runner"))) assert.equal(file.includes(token), false, "a check's token never reaches the runner's records");
    }, { build: { origin: fake.origin, token: buildToken } });
  } finally {
    for (const workspace of [bound, chore]) await rm(workspace.workspacePath, { recursive: true, force: true });
    await rm(dirname(probes), { recursive: true, force: true });
    await fake.close();
    await f.dispose();
  }
}, 180_000);

test("a GitHub-tracked landing's checks get nothing from Build, even on a runner connected to it", async () => {
  const probes = join(await mkdtemp(join(tmpdir(), "build-probe-")), "probes.jsonl");
  const f = await project({ verify: () => buildProbe(probes, "gate", 1) });
  const fake = await buildServer("build-secret", []);
  try {
    await writeFile(join(f.repo, "a.txt"), "a\n");
    jj(f.repo, ["describe", "-m", "Add a"]);
    const landed = await landThroughTestRunner(f, f.repo, { direct: true, build: { origin: fake.origin, token: "build-secret" } });
    assert.equal(landed.ok, true, landed.lines.join("\n"));
    const [run] = (await readFile(probes, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Probe);
    assert.deepEqual([run!.context, run!.url, run!.token], [null, null, null]);
  } finally {
    await rm(dirname(probes), { recursive: true, force: true });
    await fake.close();
    await f.dispose();
  }
}, 120_000);
