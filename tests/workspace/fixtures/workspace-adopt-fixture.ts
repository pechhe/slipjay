import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach } from "vite-plus/test";
import { createWorkspace } from "../../../src/lib/workspace/workspace-create.ts";
import { revisionFacts, workspaceContext } from "../../../src/lib/infra/workspace-jj.ts";
import { bindLandingOperation, writtenLandingHandoff } from "../../../src/lib/landing/submission-adoptions.ts";
import type { SubmissionHandoff } from "../../../src/lib/landing/submission-handoff.ts";
import { slipjayHome } from "../../../src/lib/workspace/workspace-paths.ts";
import { emptyTrash } from "../../../src/lib/workspace/workspace-trash.ts";
import { workspaceTransactionLocks } from "../../../src/lib/infra/workspace-transaction.ts";
import { drainFixtureWorkers } from "../../support/fixture-workers.ts";
import { jj, project } from "../../support/workspace-project.ts";

// Shared by the workspace-adopt-*.test.ts files, split by area so they run in parallel workers.
export function isolateAdoptionFixtures() {
  beforeEach(async () => {
    assert.deepEqual(await readdir(slipjayHome()).catch(() => []), [], "each adoption fixture starts with its own SlipJay state");
  });

  afterEach(async () => {
    // Join the exact workers this fixture started, including workers started by
    // its CLI children and housekeeping, rather than probing host-wide processes.
    await drainFixtureWorkers();
    await emptyTrash();
    assert.deepEqual(await workspaceTransactionLocks(), [],
      "fixture workers must release their transactions before the next test");
    // project.dispose() deletes the repository, but intentionally retained helper
    // checkouts and sidecars live here. Leaving them in this file's shared HOME
    // makes later machine-wide sweeps probe every earlier, deleted repository.
    // All delivery/retention assertions above have finished; discard only this
    // hermetic file's state after its background workers have quiesced.
    await rm(slipjayHome(), { recursive: true, force: true, maxRetries: 3 });
  });
}

const cli = fileURLToPath(new URL("../../../src/launcher/workspace.ts", import.meta.url));
export const runCli = (cwd: string, ...args: string[]) => promisify(execFile)("bun", [cli, ...args], { cwd, env: process.env, timeout: 60_000 });
export const handoffFor = (source: string): SubmissionHandoff => ({ version: 1, source, intent: "Fixture", scope: [], spec: null, helpers: [], checks: [], reviews: [], toolchain: [], gaps: [] });

export async function freezeLead(root: string, source: string, key = "fixture") {
  const context = (await workspaceContext(root))!;
  const handoff = await writtenLandingHandoff(context, key, source, false, async () => handoffFor(source));
  await bindLandingOperation(context, key, key);
  return handoff;
}

export async function contribution(f: Awaited<ReturnType<typeof project>>) {
  const lead = await createWorkspace("adopting lead", f.repo);
  await writeFile(join(lead.workspacePath, "lead.txt"), "lead\n");
  jj(lead.workspacePath, ["describe", "-m", "Lead base"]);
  jj(lead.workspacePath, ["new"]);
  const base = jj(lead.workspacePath, ["log", "-r", "@-", "--no-graph", "-T", "commit_id"]);
  const helper = await createWorkspace("helper", f.repo, { base });
  await writeFile(join(helper.workspacePath, "helper.txt"), "helper\n");
  jj(helper.workspacePath, ["describe", "-m", "Helper contribution"]);
  const revision = jj(helper.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
  jj(lead.workspacePath, ["describe", "-m", "Adopt helper"]);
  return { lead, helper, revision, base };
}

export async function publishSource(f: Awaited<ReturnType<typeof project>>, lead: Awaited<ReturnType<typeof createWorkspace>>, source: string, operationId: string) {
  jj(f.repo, ["new", "main"]);
  jj(f.repo, ["restore", "--from", source]);
  jj(f.repo, ["describe", "-m", "Published fixture"]);
  const published = await revisionFacts(f.repo, "@");
  jj(f.repo, ["bookmark", "set", "main", "-r", published.commitId]);
  jj(f.repo, ["new", "main"]);
  jj(f.repo, ["git", "push", "--bookmark", "main"]);
  return { version: 1, phase: "landed" as const, cleanupPending: false, workspaceName: lead.current.name,
    workspacePath: lead.workspacePath, integrationRoot: f.repo, integrationBranch: "main", operationId,
    artifactCommitId: published.commitId, artifactChangeId: published.changeId };
}
