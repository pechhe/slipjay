import { releaseProject } from "../support/release-project.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { releaseIntegration } from "../../src/lib/release/release.ts";
import type { PromotionState } from "../../src/lib/release/release.ts";
import { promotingProject } from "./fixtures/release-fixture.ts";

test("a promotion plans the newest commit staging is green on, with its paths, and re-asks only the delta past an approval that did not ship", async () => {
  const f = await releaseProject({ promotes: true });
  try {
    const a = await f.commit({ "a.txt": "a.txt\n" }, "Add a.txt");
    const b = await f.commit({ "b.txt": "b.txt\n" }, "Add b.txt");
    const c = await f.commit({ "c.txt": "c.txt\n" }, "Add c.txt");
    const plan = (state: PromotionState) => releaseIntegration(f.repo, { readPromotion: async () => state });
    const offline = await releaseIntegration(f.repo);
    assert.ok(!offline.ok && /reads staging from the runner/.test(offline.reason), JSON.stringify(offline));
    const red = await plan({ stagingGreen: null, approved: [], verifications: [] });
    assert.ok(!red.ok && /green on no commit/.test(red.reason), JSON.stringify(red));

    const first = await plan({ stagingGreen: b, approved: [a], verifications: [] });
    assert.ok(first.ok && first.status === "planned", JSON.stringify(first));
    assert.equal(first.candidate, b, "the candidate is what staging verified, not the integration tip");
    assert.deepEqual(first.paths.filter((path) => path.endsWith(".txt")), ["a.txt", "b.txt"]);
    assert.equal(first.delta?.since, a);
    assert.match(first.next, new RegExp(`slipjay promote --confirm ${b.slice(0, 12)}`));

    // b was approved, its release failed and c landed: the next ask shows only c.
    const moved = await plan({ stagingGreen: c, approved: [b, a], verifications: [] });
    assert.ok(moved.ok && moved.status === "planned", JSON.stringify(moved));
    assert.equal(moved.candidate, c);
    assert.deepEqual(moved.delta, { since: b, commits: [{ commitId: c, subject: moved.subjects[0] }], paths: ["c.txt"], migrationArtifacts: [] });
    assert.equal(moved.subjects.length, 1);
    assert.ok(moved.commits > 1, "the summary still counts the whole release");

    const again = await plan({ stagingGreen: c, approved: [c, b], verifications: [] });
    assert.ok(again.ok && again.status === "planned" && !again.delta, "a re-ask of the same candidate shows the whole release");
  } finally {
    await f.dispose();
  }
});

test("an earlier approval covers a candidate whose changes since add no migration and name only work items the approved range names", async () => {
  const f = await promotingProject();
  try {
    const approved = await f.commit({ "feature.txt": "a\n" }, "Add the feature\n\nBuild: #5");
    await f.commit({ "format.txt": "b\n" }, "Fix formatting");
    const sameItem = await f.commit({ "feature.txt": "a2\n" }, "Finish the feature\n\nBuild: #5");
    const covered = await f.plan(sameItem, [approved]);
    assert.ok(covered.ok && covered.status === "planned", JSON.stringify(covered));
    assert.deepEqual(covered.approval, { approvedCandidate: approved, covered: true, reasons: [] });
    assert.match(covered.next, /covers this candidate/);

    const again = await f.plan(approved, [approved]);
    assert.ok(again.ok && again.status === "planned");
    assert.deepEqual(again.approval, { approvedCandidate: approved, covered: true, reasons: [] }, "a re-ask of exactly the approved candidate");

    const first = await f.plan(sameItem, []);
    assert.ok(first.ok && first.status === "planned");
    assert.deepEqual(first.approval, { approvedCandidate: null, covered: false, reasons: ["No earlier approval that has not shipped"] });
    assert.match(first.next, /^After explicit human approval/);

    const stranger = "0123456789abcdef0123456789abcdef01234567";
    const unrelated = await f.plan(sameItem, [stranger]);
    assert.ok(unrelated.ok && unrelated.status === "planned");
    assert.equal(unrelated.approval?.covered, false);
    assert.match(unrelated.approval!.reasons.join(), /does not descend from the approved 0123456789ab/);

    const newItem = await f.commit({ "other.txt": "c\n" }, "Start another feature\n\nIssue: pechhe/slipjay#9");
    const migration = await f.commit({ "migrations/0001.sql": "create table t (a int);\n" }, "Add a table");
    const uncovered = await f.plan(migration, [approved]);
    assert.ok(uncovered.ok && uncovered.status === "planned", JSON.stringify(uncovered));
    assert.equal(uncovered.approval?.covered, false);
    assert.deepEqual(uncovered.approval?.reasons, [
      `${migration.slice(0, 12)} (Add a table) adds or changes migration artifacts: migrations/0001.sql`,
      `${newItem.slice(0, 12)} (Start another feature) names Issue: pechhe/slipjay#9, which the approved range does not`,
    ]);
  } finally { await f.dispose(); }
});
