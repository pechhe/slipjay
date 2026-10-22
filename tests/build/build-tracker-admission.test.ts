import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { jj, project } from "../support/workspace-project.ts";
import { landThroughTestRunner } from "../support/test-runner.ts";
import { item, buildServer, until, SESSION } from "./fixtures/build-tracker-fixture.ts";

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

test("a landing from a Landed Spec's own workspace lands as a chore, reaching Build with no second workspace (SJ-43)", async () => {
  const f = await project({ policy: { tracker: "build" } });
  const buildToken = "build-secret";
  // Build binds a Spec for delivery only while it is Ready or In progress: this one has landed already.
  const spec = item({ number: 96620, kind: "spec", status: "landed", title: "The Spec that landed" });
  const fake = await buildServer(buildToken, [spec]);
  const workspace = await createWorkspace("Placeholder task", f.repo, { issueNumber: 96620 });
  try {
    await writeFile(join(workspace.workspacePath, "a.txt"), "a\n");
    const landed = await landThroughTestRunner(f, workspace.workspacePath, { build: { origin: fake.origin, token: buildToken }, session: SESSION,
      before: () => until(() => fake.requests.some((request) => request.action === "recordChoreLanding"), "the chore receipt") });
    assert.equal(landed.ok, true, landed.lines.join("\n"));
    // The fix is published rather than refused for a session Build would not bind, and Build records a chore, not an admission.
    assert.equal(fake.requests.some((request) => request.action === "admitAttempt"), false, "a closed Spec takes no delivery");
    const chore = fake.requests.find((request) => request.action === "recordChoreLanding")!.input;
    assert.equal(chore.unassociated, true);
    assert.equal(chore.title, "The Spec that landed");
    const said = landed.lines.join("\n");
    assert.match(said, /\[build\] Build #96620's Spec #\d+ is landed, so Build takes no delivery of this landing: dispose the finding with hq_build_dispose_finding \(decision fix\)/);
    // The chore note still names the association, so the fix is attached to the Spec from Build's own item.
    assert.match(said, /as a chore.*attach it with hq_build_associate_landing/);
    const message = execFileSync("git", ["--git-dir", f.remote, "log", "-1", "--format=%B", "main"], { encoding: "utf8" }).trim();
    assert.equal(message, "The Spec that landed\n\nBuild: #96620", "the workspace's own item still names the landing");
  } finally {
    await rm(workspace.workspacePath, { recursive: true, force: true });
    await fake.close();
    await f.dispose();
  }
}, 120_000);
