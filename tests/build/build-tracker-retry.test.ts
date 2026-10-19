import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { controlRunner, landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { metadataPath } from "../../src/lib/workspace/workspace-state.ts";
import { jj, project } from "../support/workspace-project.ts";
import { withTestRunner } from "../support/test-runner.ts";
import { item, buildServer, until, SESSION } from "./fixtures/build-tracker-fixture.ts";

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
