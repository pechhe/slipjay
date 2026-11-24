import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { afterEach, test, vi } from "vite-plus/test";
import { run } from "../../src/lib/infra/workspace-jj.ts";
import { confirmRelease, returnRelease } from "../../src/lib/release/release.ts";
import { releaseProject, remoteRef } from "../support/release-project.ts";
import { jj } from "../support/workspace-project.ts";

const { run: realRun } = await vi.importActual<typeof import("../../src/lib/infra/workspace-jj.ts")>(
  "../../src/lib/infra/workspace-jj.ts",
);

vi.mock("../../src/lib/infra/workspace-jj.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/infra/workspace-jj.ts")>();
  return { ...actual, run: vi.fn(actual.run) };
});
vi.mock("../../src/lib/infra/remote-push.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/lib/infra/remote-push.ts")>(),
  remotePushRetryDelaysMs: [0, 0],
}));

const quarantine = "remote: error: unable to write file /data/repositories/demo/objects/ghq_Dn4Y0bInQmZ/pack/pack-123.pack: No such file or directory";
const failed = (stderr: string) => ({ code: 1, signal: null, timedOut: false, stdout: "", stderr, truncated: false });

function interceptReleasePush(intercept: (attempt: number, push: typeof realRun, args: Parameters<typeof realRun>) => ReturnType<typeof realRun>) {
  let attempts = 0;
  vi.mocked(run).mockImplementation((...args) => args[0] === "jj" && args[1].includes("push") && args[1].includes("release")
    ? intercept(++attempts, realRun, args)
    : realRun(...args));
  return () => attempts;
}

afterEach(() => vi.mocked(run).mockReset());

test.each(["quarantine", "already updated", "remote moved", "non-fast-forward", "Permission denied", "persistent quarantine", "fetch failed"])(
  "release push handles %s", async (scenario) => {
    const f = await releaseProject();
    try {
      const base = remoteRef(f, "release");
      const candidate = await f.commit({ feature: "new\n" }, "Add feature");
      const attempts = interceptReleasePush(async (attempt, push, args) => {
        if (scenario === "persistent quarantine") return failed(quarantine);
        if (attempt !== 1) return push(...args);
        if (scenario === "already updated") {
          const merge = jj(f.repo, ["log", "--no-graph", "-r", "release", "-T", "commit_id"]);
          const gitRoot = jj(f.repo, ["git", "root"]);
          // Send the merge independently so the failed jj push never updates its tracking bookmark.
          execFileSync("git", ["--git-dir", gitRoot, "push", f.remote, `${merge}:refs/heads/release`], { stdio: "pipe" });
          assert.equal(jj(f.repo, ["log", "--no-graph", "-r", "release@origin", "-T", "commit_id"]), base);
        }
        if (scenario === "remote moved")
          execFileSync("git", ["push", "origin", `${candidate}:refs/heads/release`], { cwd: f.repo, stdio: "pipe" });
        if (scenario === "non-fast-forward" || scenario === "Permission denied") return failed(scenario);
        return failed(quarantine);
      });
      if (scenario === "fetch failed") {
        const intercepted = vi.mocked(run).getMockImplementation()!;
        vi.mocked(run).mockImplementation(async (...args) =>
          attempts() && args[1].includes("fetch") && args[1].includes("release")
            ? failed("Connection reset") : intercepted(...args));
      }

      const result = await confirmRelease(f.repo, { candidate });
      if (scenario === "quarantine" || scenario === "already updated") {
        assert.ok(result.ok && result.status === "released", JSON.stringify(result));
        assert.equal(remoteRef(f, "release"), result.merge);
        assert.equal(attempts(), scenario === "quarantine" ? 2 : 1);
        const commands = vi.mocked(run).mock.calls.map(([, args]) => args);
        const firstPush = commands.findIndex((args) => args.includes("push"));
        assert.ok(commands[firstPush + 1]?.includes("fetch"), "fetch confirms an ambiguous push");
      } else {
        assert.ok(!result.ok && result.status === "refused", JSON.stringify(result));
        assert.equal(attempts(), scenario === "persistent quarantine" ? 3 : 1);
        assert.equal(remoteRef(f, "release"), scenario === "remote moved" ? candidate : base);
      }
    } finally { await f.dispose(); }
  },
);

test.each([false, true])("returning a release after a quarantine error (remote moved: %s)", async (moved) => {
  const f = await releaseProject();
  try {
    const base = remoteRef(f, "release");
    const candidate = await f.commit({ feature: "new\n" }, "Add feature");
    const result = await confirmRelease(f.repo, { candidate });
    assert.ok(result.ok && result.status === "released", JSON.stringify(result));
    const attempts = interceptReleasePush(async (attempt, push, args) => {
      if (attempt !== 1) return push(...args);
      if (moved)
        execFileSync("git", ["--git-dir", f.remote, "update-ref", "refs/heads/release", candidate, result.merge]);
      return failed(quarantine);
    });
    const returned = await returnRelease(f.repo, { merge: result.merge, candidate });
    if (moved) assert.equal(returned.returned, false, JSON.stringify(returned));
    else assert.deepEqual(returned, { returned: true, releaseBranch: base });
    assert.equal(attempts(), moved ? 1 : 2);
    assert.equal(remoteRef(f, "release"), moved ? candidate : base);
  } finally { await f.dispose(); }
});
