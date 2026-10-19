import { jj } from "../support/workspace-project.ts";
import { landFile, releaseProject, remoteRef } from "../support/release-project.ts";
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { confirmRelease } from "../../src/lib/release/release.ts";

test("a failed release check publishes nothing", async () => {
  const f = await releaseProject({ checks: () => [{ executable: "node", args: ["-e", "process.exit(3)"] }] });
  try {
    const base = remoteRef(f, "release");
    const candidate = await landFile(f, "feature.txt");
    const result = await confirmRelease(f.repo, { candidate });
    assert.equal(result.status, "verification_failed", JSON.stringify(result));
    assert.equal(remoteRef(f, "release"), base);
  } finally {
    await f.dispose();
  }
});

test("a release check that edits tracked source publishes nothing and restores the candidate", async () => {
  const f = await releaseProject({ checks: () => [{ executable: "node", args: ["-e", "require('node:fs').writeFileSync('feature.txt', 'edited by a check\\n')"] }] });
  try {
    const base = remoteRef(f, "release");
    const candidate = await landFile(f, "feature.txt");
    const result = await confirmRelease(f.repo, { candidate });
    assert.equal(result.status, "refused", JSON.stringify(result));
    assert.ok(!result.ok && /release verification changed the candidate's source[\s\S]*feature\.txt/.test(result.reason), JSON.stringify(result));
    assert.equal(remoteRef(f, "release"), base);
    assert.equal(jj(f.repo, ["diff", "--from", candidate, "--to", "@", "--summary"]), "");
  } finally {
    await f.dispose();
  }
});
