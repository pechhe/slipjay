import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { parseExecutionPolicy } from "../../src/lib/policy/execution-policy.ts";
import { commitIssue, withIssueTrailer } from "../../src/lib/build/issue-references.ts";
import { buildRoute } from "../../src/lib/build/build-admission.ts";
import { buildLandingHandoff } from "../../src/lib/build/build-handoff.ts";
import { BuildRefusal, buildItemClosed, trackerOf, workItemClosed, workItemTitle } from "../../src/lib/build/tracker.ts";
import type { BuildItem, BuildReader } from "../../src/lib/build/tracker.ts";
import { item, SESSION } from "./fixtures/build-tracker-fixture.ts";

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

test("slipjay.json chooses the tracker: GitHub unless it declares Forge, and nothing else", () => {
  const policy = (extra: Record<string, unknown>) => JSON.stringify({ version: 1, requiredLandingVerification: [], ...extra });
  assert.equal(trackerOf(parseExecutionPolicy(policy({}))), "github");
  assert.equal(trackerOf(parseExecutionPolicy(policy({ tracker: "github" }))), "github");
  assert.equal(trackerOf(parseExecutionPolicy(policy({ tracker: "forge" }))), "forge");
  // A repository that has not switched yet keeps working; #4667 removes the old value.
  assert.equal(trackerOf(parseExecutionPolicy(policy({ tracker: "build" }))), "build");
  assert.throws(() => parseExecutionPolicy(policy({ tracker: "linear" })), /tracker other than "github", "build" or "forge"/);
});

test("a Forge-tracked landing names its item in a Forge trailer, which promotion reads back", () => {
  assert.equal(withIssueTrailer("Do it", 41, "o/r", "forge"), "Do it\n\nForge: #41");
  // A repository still declaring `build` writes the old trailer, which readers keep accepting.
  assert.equal(withIssueTrailer("Do it", 41, "o/r", "build"), "Do it\n\nBuild: #41");
  assert.equal(withIssueTrailer("Do it", 41, "o/r"), "Do it\n\nIssue: o/r#41");
  // `#N` in a description may be a GitHub reference, so it never stands in for the Build trailer.
  assert.equal(withIssueTrailer("Implement #41", 41, "o/r", "build"), "Implement #41\n\nBuild: #41");
  assert.equal(withIssueTrailer("Fix o/r#41", 41, "o/r", "build"), "Fix o/r#41\n\nBuild: #41");
  assert.equal(withIssueTrailer("Do it\n\nBuild: #41", 41, "o/r", "build"), "Do it\n\nBuild: #41");
  // A full description keeps its body and trailers verbatim; Build joins the trailer block, or is not added twice.
  const body = "Do it\n\nFirst.\n\nSecond.\n\nCo-Authored-By: A <a@b.c>";
  assert.equal(withIssueTrailer(body, 41, "o/r", "build"), `${body}\nBuild: #41`);
  assert.equal(withIssueTrailer(`${body}\nBuild: #41`, 41, "o/r", "build"), `${body}\nBuild: #41`);
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
    item({ number: 30, kind: "decision", status: "proposed" }), item({ number: 40, kind: "spec", status: "inbox" })]);
  const binds: Record<string, { generation: number; endedAt: string | null }[]> = { [spec.id]: [{ generation: 1, endedAt: null }] };
  const reader: BuildReader = (action, input) => action === "binds" ? Promise.resolve(binds[input.specId as string] ?? []) : read(action, input);
  const request = (fields: Partial<Parameters<typeof buildLandingHandoff>[0]>) =>
    buildLandingHandoff({ source: "a".repeat(40), description: "Do it\n\nBody", issueNumber: 11, tickets: [], sessionId: SESSION, read: reader, ...fields });

  assert.deepEqual((await request({})).build, { specId: spec.id, ticketIds: [item({ number: 11 }).id], bodyRevision: null, bindGeneration: 1, sessionId: SESSION });
  assert.deepEqual((await request({ issueNumber: 10 })).build, { specId: spec.id, ticketIds: [], bodyRevision: null, bindGeneration: 1, sessionId: SESSION }, "a Spec lands with no Tickets");
  assert.deepEqual((await request({ tickets: [12, 11] })).build, { specId: spec.id, ticketIds: [item({ number: 11 }).id, item({ number: 12 }).id], bodyRevision: null, bindGeneration: 1, sessionId: SESSION });
  assert.deepEqual((await request({ issueNumber: null, sessionId: undefined })).build, { unassociated: true });
  assert.equal((await request({})).intent, "Do it");

  await assert.rejects(request({ sessionId: undefined }), /hq_forge_start_session.*--session <id>.*HQ_FORGE_SESSION_ID/);
  await assert.rejects(request({ sessionId: "not-a-session" }), /not a session id/);
  await assert.rejects(request({ issueNumber: 21 }), /Spec #20 has no current lead: bind it with hq_forge_bind/);
  await assert.rejects(request({ issueNumber: 40 }), /Spec #40 shaped and bound, but it is in inbox: set it to ready with hq_forge_set_status/, "an unshaped Spec names shaping first, with or without a session");
  await assert.rejects(request({ issueNumber: 40, sessionId: undefined }), /it is in inbox/);
  await assert.rejects(request({ tickets: [21] }), /#21 is not a Ticket of Spec #10/);
  await assert.rejects(request({ issueNumber: 30 }), /is a decision, not a Spec or a Spec's Ticket/);
  await assert.rejects(request({ issueNumber: 99 }), /Build has no item #99/);
  await assert.rejects(request({ issueNumber: null, tickets: [11] }), /--ticket needs a workspace with a Build item/);
  await assert.rejects(request({ issueNumber: null }), /Build session needs a workspace with a Build item: attach the Spec with attach-issue/, "a session with no Build item is refused, not landed as a chore");
  assert.deepEqual((await request({ issueNumber: null, sessionId: "  " })).build, { unassociated: true }, "a blank session is no session");
});
