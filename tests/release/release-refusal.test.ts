import { jj } from "../support/workspace-project.ts";
import { landFile, releaseProject, remoteRef } from "../support/release-project.ts";
import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { confirmRelease, releaseIntegration } from "../../src/lib/release/release.ts";

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

test("a candidate that is not published on the integration branch is refused", async () => {
  const f = await releaseProject();
  try {
    await landFile(f, "feature.txt");
    jj(f.repo, ["new", "main", "-m", "unpublished"]);
    const unpublished = jj(f.repo, ["log", "--no-graph", "-r", "@", "-T", "commit_id"]);
    const result = await confirmRelease(f.repo, { candidate: unpublished });
    assert.equal(result.status, "refused");
    assert.ok(!result.ok && /is not published/.test(result.reason));
  } finally {
    await f.dispose();
  }
});

test("an audited release that promotes nothing still plans against the runner's audits, and is refused while one failed unexplained", async () => {
  const f = await releaseProject();
  try {
    const policy = JSON.parse(await readFile(join(f.repo, "slipjay.json"), "utf8"));
    await landFile(f, "slipjay.json", JSON.stringify({ ...policy, audit: { commands: [{ executable: "node", args: ["-e", ""] }] } }));
    const noRunner = await releaseIntegration(f.repo);
    assert.ok(!noRunner.ok && /audited on the runner/.test(noRunner.reason), JSON.stringify(noRunner));
    const state = (auditRefusal: string | null) => async () => ({ stagingGreen: null, approved: [], verifications: [], auditRefusal });
    const refused = await releaseIntegration(f.repo, { readPromotion: state("The latest audit failed and no cause is recorded") });
    assert.ok(!refused.ok && /no cause is recorded/.test(refused.reason), JSON.stringify(refused));
    assert.equal((await releaseIntegration(f.repo, { readPromotion: state(null) })).status, "planned");
  } finally {
    await f.dispose();
  }
});

test("a reason given at publication refuses a verified release and publishes nothing", async () => {
  const f = await releaseProject();
  try {
    const base = remoteRef(f, "release");
    const candidate = await landFile(f, "feature.txt");
    const result = await confirmRelease(f.repo, { candidate, publicationRefusal: () => "An audit failed while this release verified" });
    assert.ok(!result.ok && result.status === "refused" && /audit failed while/.test(result.reason), JSON.stringify(result));
    assert.equal(remoteRef(f, "release"), base);
  } finally {
    await f.dispose();
  }
});
