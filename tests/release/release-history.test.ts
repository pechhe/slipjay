import { landFile, releaseProject, remoteRef } from "../support/release-project.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { confirmRelease, returnRelease } from "../../src/lib/release/release.ts";

test("a release branch with changes the integration branch lacks is refused", async () => {
  const f = await releaseProject();
  try {
    const candidate = await landFile(f, "feature.txt");
    // A hotfix straight on the release branch that never reached main.
    const scratch = join(f.root, "hotfix");
    execFileSync("git", ["clone", "-q", "-b", "release", f.remote, scratch]);
    const git = (args: string[]) => execFileSync("git", args, { cwd: scratch, stdio: "pipe" });
    git(["config", "user.name", "Fixture"]);
    git(["config", "user.email", "fixture@example.com"]);
    await writeFile(join(scratch, "hotfix.txt"), "hotfix\n");
    git(["add", "."]);
    git(["commit", "-qm", "Hotfix"]);
    git(["push", "-q", "origin", "release"]);
    const hotfix = remoteRef(f, "release");
    const result = await confirmRelease(f.repo, { candidate });
    assert.ok(!result.ok && /not the verified tree/.test(result.reason), JSON.stringify(result));
    assert.equal(remoteRef(f, "release"), hotfix);
  } finally {
    await f.dispose();
  }
});

test("a returned release moves the release branch back to before its merge, only while it still holds that merge", async () => {
  const f = await releaseProject();
  try {
    const candidate = await landFile(f, "a.txt");
    const base = remoteRef(f, "release");
    const released = await confirmRelease(f.repo, { candidate });
    assert.ok(released.status === "released", JSON.stringify(released));
    assert.deepEqual(await returnRelease(f.repo, { merge: released.merge, candidate }), { returned: true, releaseBranch: base });
    assert.equal(remoteRef(f, "release"), base);
    const again = await returnRelease(f.repo, { merge: released.merge, candidate });
    assert.ok(!again.returned && /has moved on/.test(again.reason), JSON.stringify(again));
    assert.equal(remoteRef(f, "release"), base);
  } finally {
    await f.dispose();
  }
});
