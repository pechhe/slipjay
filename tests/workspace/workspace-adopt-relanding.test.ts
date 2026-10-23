import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { adoptWorkspace } from "../../src/lib/workspace/workspace-adopt.ts";
import { metadataPath, workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { revisionFacts, workspaceContext } from "../../src/lib/infra/workspace-jj.ts";
import { workspaceCoverage } from "../../src/lib/workspace/workspace-coverage.ts";
import { project } from "../support/workspace-project.ts";
import { bindLandingOperation, writtenLandingHandoff } from "../../src/lib/landing/submission-adoptions.ts";
import type { Operation } from "../../src/lib/runner/runner-types.ts";
import { isolateAdoptionFixtures, handoffFor, contribution } from "./fixtures/workspace-adopt-fixture.ts";

isolateAdoptionFixtures();

for (const outcome of ["running", "integrating", "finalizing", "publishing", "unknown-response"] as const) {
  test(`${outcome} adoption stays with its first submission when the lead relands`, async () => {
    const f = await project({ policy: { spares: 0 } });
    try {
      const { lead, helper, revision } = await contribution(f);
      await adoptWorkspace(lead.workspacePath, helper.workspacePath);
      const source = (await revisionFacts(lead.workspacePath, "@")).commitId;
      const context = (await workspaceContext(lead.workspacePath))!;
      await writtenLandingHandoff(context, "first", source, false, async () => handoffFor(source));
      if (outcome !== "unknown-response") await bindLandingOperation(context, "first", "first");
      if (outcome === "running") {
        // The runner acknowledged the first request, but has not published it.
        // Later acknowledged submissions must not evict its live provenance.
        const metadata = (await workspaceMetadata(lead.current.name))!;
        const filler = Array.from({ length: 35 }, (_, index) => `acknowledged-${index}`);
        await writeFile(metadataPath(lead.current.name), JSON.stringify({ ...metadata, pendingLandingRequests: {},
          landingAdoptions: { ...metadata.landingAdoptions as object, ...Object.fromEntries(filler.map((key) => [key, { source, adoptions: [] }])) },
          landingHandoffs: { ...metadata.landingHandoffs as object, ...Object.fromEntries(filler.map((key) => [key, handoffFor(source)])) },
        }));
      }
      await writeFile(join(lead.workspacePath, "later.txt"), "reland while the first outcome is unresolved\n");
      const later = (await revisionFacts(lead.workspacePath, "@")).commitId;
      const next = await writtenLandingHandoff(context, "next", later, false, async (hasAdoptions) => {
        assert.equal(hasAdoptions, false);
        return handoffFor(later);
      }, undefined, async (): Promise<Operation["result"]> =>
        outcome === "integrating" || outcome === "finalizing" || outcome === "publishing" ? { type: "failed", stage: outcome, reason: "unresolved publication" } : undefined);
      assert.deepEqual(next!.helpers, [], "unresolved helper evidence is not sent twice");
      const frozen = (await workspaceMetadata(lead.current.name))!.landingAdoptions as Record<string, { adoptions: Array<{ revisions: string[] }> }>;
      assert.deepEqual(frozen.first!.adoptions.flatMap((record) => record.revisions), [revision]);
      assert.deepEqual(frozen.next!.adoptions, []);
      assert.equal(await workspaceCoverage((await workspaceContext(helper.workspacePath))!, helper.current.name), "pending");
    } finally { await f.dispose(); }
  });
}

for (const outcome of ["declined", "cancelled", "superseded", "never-submitted"] as const) {
  test(`${outcome} adoption can move to a replacement submission`, async () => {
    const f = await project({ policy: { spares: 0 } });
    try {
      const { lead, helper, revision } = await contribution(f);
      await adoptWorkspace(lead.workspacePath, helper.workspacePath);
      const source = (await revisionFacts(lead.workspacePath, "@")).commitId;
      const context = (await workspaceContext(lead.workspacePath))!;
      await writtenLandingHandoff(context, "first", source, false, async () => handoffFor(source));
      if (outcome === "never-submitted") {
        const metadata = await workspaceMetadata(lead.current.name);
        await writeFile(metadataPath(lead.current.name), JSON.stringify({ ...metadata, pendingLandingRequests: {} }));
      } else await bindLandingOperation(context, "first", "first");
      await writeFile(join(lead.workspacePath, "fix.txt"), "replacement\n");
      const later = (await revisionFacts(lead.workspacePath, "@")).commitId;
      const next = await writtenLandingHandoff(context, "next", later, false, async () => handoffFor(later), undefined,
        async (): Promise<Operation["result"]> => outcome === "declined" ? { type: "declined", reason: "declined", paths: [] }
          : outcome === "cancelled" ? { type: "cancelled", reason: "cancelled" }
            : outcome === "superseded" ? { type: "superseded", by: "another-submission" } : undefined);
      assert.deepEqual(next!.helpers.map((entry) => entry.revision), [revision]);
      assert.deepEqual(((await workspaceMetadata(lead.current.name))!.landingAdoptions as Record<string, { adoptions: unknown[] }>).first!.adoptions, []);
      assert.equal(((await workspaceMetadata(lead.current.name))!.pendingLandingRequests as Record<string, string>).first, undefined);
    } finally { await f.dispose(); }
  });
}
