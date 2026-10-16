import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { parseExecutionPolicy } from "../src/lib/execution-policy.ts";
import { withIssueTrailer } from "../src/lib/issue-references.ts";
import { commitIssue, halfBuiltSpecs } from "../src/lib/release-specs.ts";
import { readBuildThroughRunner } from "../src/lib/runner-client.ts";
import { createWorkspace } from "../src/lib/slipjay.ts";
import { buildRoute } from "../src/lib/build-admission.ts";
import { BuildRefusal, buildItemClosed, trackerOf, workItemClosed, workItemTitle } from "../src/lib/tracker.ts";
import type { BuildItem, BuildReader } from "../src/lib/tracker.ts";
import { landThroughTestRunner, project, withTestRunner } from "./support/workspace-project.ts";

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

/** A stand-in for Build's runner route on loopback, answering `read` from `items`. */
async function buildServer(token: string, items: BuildItem[]) {
  const requests: { action: string; input: unknown }[] = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      const reply = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
      if (request.url !== "/api/build/runner" || request.headers.authorization !== `Bearer ${token}`) return reply(401, { status: "unauthorised", code: "runner_unauthenticated" });
      const { action, input } = JSON.parse(text) as { action: string; input: { number?: number } };
      requests.push({ action, input });
      const found = items.find((entry) => entry.number === input.number);
      if (action !== "read") return reply(400, { status: "invalid", code: "runner_action_invalid" });
      // As Build does: an unknown item is its `unavailable` outcome, which the route sends as 503.
      return found ? reply(200, { status: "succeeded", value: found }) : reply(503, { status: "unavailable", code: "build_item_unavailable" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
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

test("promotion reports a Build-tracked release's open parent Specs with their Tickets' progress", async () => {
  const open = item({ number: 10, kind: "spec", status: "in_progress", title: "Open Spec" });
  const done = item({ number: 20, kind: "spec", status: "landed", title: "Landed Spec" });
  const { read, calls } = build([open, done,
    item({ number: 11, parentId: open.id, status: "landed" }), item({ number: 12, parentId: open.id, status: "dropped" }), item({ number: 13, parentId: open.id }),
    item({ number: 21, parentId: done.id, status: "landed" }), item({ number: 30 })]);
  const result = await halfBuiltSpecs("o/r", ["A\n\nBuild: #11", "B\n\nBuild: #12", "C\n\nBuild: #21", "D\n\nBuild: #30", "E"], { tracker: "build", readBuild: read });
  assert.deepEqual(result, { checked: true, specs: [{ number: 10, title: "Open Spec", url: null, closedTickets: 2, totalTickets: 3, summary: "#10 Open Spec: 2 of 3 Tickets closed" }] });
  assert.equal(calls.filter((call) => call.startsWith(`read {"itemId":"${open.id}"`)).length, 1, "each parent Spec is read once");

  assert.deepEqual(await halfBuiltSpecs("o/r", ["A\n\nBuild: #11"], { tracker: "build" }), { checked: false, reason: "could not check Build for half-built Specs: no Build reader" });
  // A number Build does not know serves no Spec; Build not answering means the check could not run.
  assert.deepEqual(await halfBuiltSpecs("o/r", ["A\n\nBuild: #99"], { tracker: "build", readBuild: read }), { checked: true, specs: [] });
  const down: BuildReader = async () => { throw new Error("Build did not answer: Build answered HTTP 503"); };
  assert.deepEqual(await halfBuiltSpecs("o/r", ["A\n\nBuild: #11"], { tracker: "build", readBuild: down }),
    { checked: false, reason: "could not check Build for half-built Specs: Build did not answer: Build answered HTTP 503" });
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

test("a Build-tracked landing with no description takes its item's title from Build and a Build trailer", async () => {
  const f = await project({ policy: { tracker: "build" } });
  const buildToken = "build-secret";
  const fake = await buildServer(buildToken, [item({ number: 96611, title: "Title from Build" })]);
  const workspace = await createWorkspace("Placeholder task", f.repo, { issueNumber: 96611 });
  try {
    await writeFile(join(workspace.workspacePath, "a.txt"), "a\n");
    const landed = await landThroughTestRunner(f, workspace.workspacePath, { build: { origin: fake.origin, token: buildToken } });
    assert.equal(landed.ok, true, landed.lines.join("\n"));
    const message = execFileSync("git", ["--git-dir", f.remote, "log", "-1", "--format=%B", "main"], { encoding: "utf8" }).trim();
    assert.equal(message, "Title from Build\n\nBuild: #96611");
  } finally {
    await rm(workspace.workspacePath, { recursive: true, force: true });
    await fake.close();
    await f.dispose();
  }
}, 120_000);


test("Build's 503 for an unknown item is its refusal; any other 503 is no answer", async () => {
  const answering = (status: number, body: unknown) => buildRoute({ origin: "https://hq.example.com", token: "t",
    fetch: async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } }) });
  assert.deepEqual(await answering(503, { status: "unavailable", code: "build_item_unavailable" })("read", { number: 1 }), { kind: "refused", code: "build_item_unavailable" });
  assert.equal((await answering(503, { status: "unavailable", code: "hq_build_store_unavailable" })("read", { number: 1 })).kind, "unavailable");
  assert.equal((await answering(503, "<html>Service Unavailable</html>")("read", { number: 1 })).kind, "unavailable");
});
