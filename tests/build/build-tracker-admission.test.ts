import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { jj, project } from "../support/workspace-project.ts";
import { landOnTestRunner, withTestRunner } from "../support/test-runner.ts";
import { item, buildServer, until, SESSION } from "./fixtures/build-tracker-fixture.ts";

test("Build-tracked landings admit active Tickets, report unbound work as chores, and land fixes on a Landed Spec as chores (SJ-43)", async () => {
  const f = await project({ policy: { tracker: "build" } });
  const buildToken = "build-secret";
  const spec = item({ number: 96610, kind: "spec", status: "in_progress", title: "The Spec", bodyRevision: 4 });
  const ticket = item({ number: 96611, parentId: spec.id, title: "Title from Build" });
  const landedSpec = item({ number: 96620, kind: "spec", status: "landed", title: "The Spec that landed" });
  const fake = await buildServer(buildToken, [spec, ticket, landedSpec], { [spec.id]: [{ generation: 2, endedAt: "2026-10-16T00:00:00Z" }, { generation: 3, endedAt: null }] });
  try {
    await withTestRunner(f, async (runner) => {
      // 1. Ticket landing writes its own Build handoff: Spec, current bind and lead session.
      const ticketWs = await createWorkspace("Placeholder task", f.repo, { issueNumber: 96611 });
      try {
        await writeFile(join(ticketWs.workspacePath, "a.txt"), "a\n");
        const landed = await landOnTestRunner(runner, ticketWs.workspacePath, { session: SESSION });
        assert.equal(landed.ok, true, landed.lines.join("\n"));
        const message = execFileSync("git", ["--git-dir", f.remote, "log", "-1", "--format=%B", "main"], { encoding: "utf8" }).trim();
        assert.equal(message, "Title from Build\n\nBuild: #96611");
        const admission = fake.requests.find((request) => request.action === "admitAttempt")?.input;
        assert.ok(admission, "Build was asked to admit the landing");
        assert.deepEqual({ specId: admission.specId, ticketIds: admission.ticketIds, specBodyRevision: admission.specBodyRevision, bindGeneration: admission.bindGeneration, sessionId: admission.sessionId },
          { specId: spec.id, ticketIds: [ticket.id], specBodyRevision: 4, bindGeneration: 3, sessionId: SESSION });
      } finally { await rm(ticketWs.workspacePath, { recursive: true, force: true }); }

      // 2. Landing with no Build item is reported to Build as a chore without admission.
      const admissionsBefore = fake.requests.filter((request) => request.action === "admitAttempt").length;
      const choreWs = await createWorkspace("Tidy", f.repo);
      try {
        await writeFile(join(choreWs.workspacePath, "b.txt"), "b\n");
        jj(choreWs.workspacePath, ["describe", "-m", "Tidy the readme"]);
        const landed = await landOnTestRunner(runner, choreWs.workspacePath);
        assert.equal(landed.ok, true, landed.lines.join("\n"));
        await until(() => fake.requests.filter((request) => request.action === "recordChoreLanding").length >= 1, "the chore receipt");
        const chore = fake.requests.filter((request) => request.action === "recordChoreLanding")[0]!.input;
        assert.equal(chore.unassociated, true);
        assert.equal(fake.requests.filter((request) => request.action === "admitAttempt").length, admissionsBefore, "a chore is never admitted");
      } finally { await rm(choreWs.workspacePath, { recursive: true, force: true }); }

      // 3. Landing from a Landed Spec's own workspace lands as a chore with no second workspace (SJ-43).
      const landedSpecWs = await createWorkspace("Placeholder task", f.repo, { issueNumber: 96620 });
      try {
        await writeFile(join(landedSpecWs.workspacePath, "c.txt"), "c\n");
        const landed = await landOnTestRunner(runner, landedSpecWs.workspacePath, { session: SESSION });
        assert.equal(landed.ok, true, landed.lines.join("\n"));
        await until(() => fake.requests.filter((request) => request.action === "recordChoreLanding").length >= 2, "the landed-spec chore receipt");
        assert.equal(fake.requests.filter((request) => request.action === "admitAttempt").length, admissionsBefore, "a closed Spec takes no delivery");
        const chore = fake.requests.filter((request) => request.action === "recordChoreLanding")[1]!.input;
        assert.equal(chore.unassociated, true);
        assert.equal(chore.title, "The Spec that landed");
        const said = landed.lines.join("\n");
        assert.match(said, /\[build\] Build #96620's Spec #\d+ is landed, so Build takes no delivery of this landing: dispose the finding with weave_forge_finding \(action "dispose_finding", decision fix\)/);
        assert.match(said, /as a chore.*attach it with weave_forge_session \(action "associate_landing"\)/);
        const message = execFileSync("git", ["--git-dir", f.remote, "log", "-1", "--format=%B", "main"], { encoding: "utf8" }).trim();
        assert.equal(message, "The Spec that landed\n\nBuild: #96620", "the workspace's own item still names the landing");
      } finally { await rm(landedSpecWs.workspacePath, { recursive: true, force: true }); }
    }, { build: { origin: fake.origin, token: buildToken } });
  } finally {
    await fake.close();
    await f.dispose();
  }
}, 120_000);
