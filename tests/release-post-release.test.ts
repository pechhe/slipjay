import { jj } from "./support/workspace-project.ts";
import { landFile, releaseProject, remoteRef, until } from "./support/release-project.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { targetKeyOf } from "../src/lib/post-integration-coverage.ts";
import { withTargetLease } from "../src/lib/post-integration-finalization.ts";
import { readExactExecutionPolicy } from "../src/lib/post-integration-source.ts";
import { confirmRelease } from "../src/lib/release.ts";
import { postIntegrationHome } from "../src/lib/workspace-paths.ts";

const TARGET = "fixture-db:development";

/**
 * A post-release step that records the release it ran for and what the remote
 * release branch held at that moment. It holds while `<root>/hold` exists, after
 * writing `<root>/started`, and fails while `<root>/fail` exists, handing SlipJay
 * a reason line with a control character and a trailing second line.
 */
const recordingStep = (root: string, remote: string) => {
  const at = (name: string) => JSON.stringify(join(root, name));
  return {
    version: 1,
    target: TARGET,
    timeoutMs: 60_000,
    targetProbe: { executable: "node", args: ["-e", `console.log(JSON.stringify({ target: ${JSON.stringify(TARGET)} }))`] },
    command: { executable: "node", args: ["-e", [
      `const fs = require("fs"); const { execFileSync } = require("child_process");`,
      `fs.writeFileSync(${at("started")}, "");`,
      `while (fs.existsSync(${at("hold")})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);`,
      `const published = execFileSync("git", ["--git-dir", ${JSON.stringify(remote)}, "rev-parse", "refs/heads/release"], { encoding: "utf8" }).trim();`,
      `const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();`,
      `fs.appendFileSync(${at("post-release.log")}, JSON.stringify({ merge: process.env.SLIPJAY_RELEASE_MERGE, published, source }) + "\\n");`,
      `if (fs.existsSync(${at("fail")})) {`,
      `  fs.writeFileSync(process.env.SLIPJAY_RELEASE_REASON_FILE, "Scrub refused:\\u0007 a real-customer tenant\\nsecond line");`,
      `  console.error("reset failed"); process.exit(3);`,
      `}`,
    ].join("\n")] },
  };
};

const runs = async (root: string) => (await readFile(join(root, "post-release.log"), "utf8").catch(() => ""))
  .split("\n").filter(Boolean).map((line) => JSON.parse(line) as { merge: string; published: string; source: string });

test("a release runs its post-release step once it has published", async () => {
  const f = await releaseProject({ postRelease: recordingStep });
  try {
    const candidate = await landFile(f, "feature.txt");
    const released = await confirmRelease(f.repo, { candidate });
    assert.ok(released.ok && released.status === "released", JSON.stringify(released));
    assert.equal(released.postRelease?.ok, true, JSON.stringify(released.postRelease));
    assert.deepEqual(await runs(f.root), [{ merge: released.merge, published: released.merge, source: candidate }],
      "the step ran after the release merge was on the remote");
    // A completed step is not rerun by a later confirm of the same candidate.
    const again = await confirmRelease(f.repo, { candidate });
    assert.ok(again.ok && again.status === "released_by", JSON.stringify(again));
    assert.equal(again.postRelease, undefined);
    assert.equal((await runs(f.root)).length, 1);
  } finally {
    await f.dispose();
  }
});

test("a failed post-release step keeps the release, is reported and is retried once by the next confirm", async () => {
  const f = await releaseProject({ postRelease: recordingStep });
  try {
    await writeFile(join(f.root, "fail"), "");
    const candidate = await landFile(f, "feature.txt");
    const released = await confirmRelease(f.repo, { candidate });
    assert.ok(released.ok && released.status === "released", JSON.stringify(released));
    assert.equal(remoteRef(f, "release"), released.merge, "the failure does not undo the release");
    assert.equal(released.postRelease?.ok, false);
    assert.match(released.postRelease?.reason ?? "", /^Post-release command failed: Scrub refused: {2}a real-customer tenant; its output is in /,
      "the step's reason line, one line and without control characters, names why it failed");
    assert.doesNotMatch(released.postRelease?.reason ?? "", /reset failed|second line/, "the step's output stays out of the result");
    assert.equal(released.postRelease?.retry, `slipjay release --confirm ${candidate.slice(0, 12)}`);

    await rm(join(f.root, "fail"));
    // The retry runs in the integration branch as it is now, not the released candidate.
    const later = await landFile(f, "later.txt");
    const retried = await confirmRelease(f.repo, { candidate });
    assert.ok(retried.ok && retried.status === "released_by", JSON.stringify(retried));
    assert.equal(retried.releasedBy, candidate);
    assert.equal(retried.postRelease?.ok, true, JSON.stringify(retried.postRelease));
    assert.equal(retried.postRelease?.attempt, 2);
    assert.equal(retried.postRelease?.merge, released.merge, "the retry names the merge that shipped the candidate");
    assert.equal(retried.postRelease?.source, later);
    assert.equal((await runs(f.root)).at(-1)?.source, later);
    assert.equal(remoteRef(f, "release"), released.merge);
    // A completed retry is not repeated.
    const settled = await confirmRelease(f.repo, { candidate });
    assert.ok(settled.ok && settled.status === "released_by" && settled.postRelease === undefined, JSON.stringify(settled));
  } finally {
    await f.dispose();
  }
});

test("a failed post-release step is still retried after the runner's checkout moves to another path", async () => {
  const f = await releaseProject({ postRelease: recordingStep });
  try {
    await writeFile(join(f.root, "fail"), "");
    const candidate = await landFile(f, "feature.txt");
    const released = await confirmRelease(f.repo, { candidate });
    assert.ok(released.ok && released.status === "released" && released.postRelease?.ok === false, JSON.stringify(released));
    await rm(join(f.root, "fail"));
    // A new host, or a new home: the same repository checked out somewhere else.
    const moved = join(f.root, "moved");
    await rename(f.repo, moved);
    const retried = await confirmRelease(moved, { candidate });
    assert.ok(retried.ok && retried.status === "released_by", JSON.stringify(retried));
    assert.equal(retried.postRelease?.ok, true, JSON.stringify(retried.postRelease));
    assert.equal(retried.postRelease?.attempt, 2);
  } finally {
    await f.dispose();
  }
});

test("an outcome SlipJay 3.6 wrote under another host's checkout key is adopted and still retried", async () => {
  const f = await releaseProject({ postRelease: recordingStep });
  try {
    await writeFile(join(f.root, "fail"), "");
    const candidate = await landFile(f, "feature.txt");
    assert.equal((await confirmRelease(f.repo, { candidate })).ok, true);
    await rm(join(f.root, "fail"));
    // Put the failed outcome where 3.6 kept it on the old host, then move the checkout too.
    const directory = join(postIntegrationHome(), "..", "post-release");
    const [current] = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    await rename(join(directory, current!), join(directory, `${targetKeyOf("/old-host/repos/fixture/.git", TARGET)}.json`));
    const moved = join(f.root, "moved");
    await rename(f.repo, moved);
    const retried = await confirmRelease(moved, { candidate });
    assert.ok(retried.ok && retried.status === "released_by", JSON.stringify(retried));
    assert.equal(retried.postRelease?.ok, true, JSON.stringify(retried.postRelease));
    assert.equal(retried.postRelease?.attempt, 2);
  } finally {
    await f.dispose();
  }
});

test("a post-release step holds the target lease landing's post-integration step takes", async () => {
  const f = await releaseProject({ postRelease: recordingStep });
  try {
    await writeFile(join(f.root, "hold"), "");
    const candidate = await landFile(f, "feature.txt");
    const release = confirmRelease(f.repo, { candidate });
    await until(() => existsSync(join(f.root, "started")), "the post-release step to start");
    const { gitDirectory } = await readExactExecutionPolicy(jj(f.repo, ["git", "root"]), candidate);
    let stepDoneWhenLeased: number | null = null;
    const landing = withTargetLease(postIntegrationHome(), targetKeyOf(gitDirectory, TARGET), async () => {
      stepDoneWhenLeased = (await runs(f.root)).length;
    });
    // Nothing can signal a lease that is correctly not taken, so give it a moment to be wrongly taken.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(stepDoneWhenLeased, null, "the lease was taken while the step ran");
    await rm(join(f.root, "hold"));
    await landing;
    assert.equal(stepDoneWhenLeased, 1, "the lease waited for the step to finish");
    assert.equal((await release).status, "released");
  } finally {
    await rm(join(f.root, "hold"), { force: true });
    await f.dispose();
  }
});
