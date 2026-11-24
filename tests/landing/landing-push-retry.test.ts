import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test, vi } from "vite-plus/test";
import { run } from "../../src/lib/infra/workspace-jj.ts";
import { publishIntegration } from "../../src/lib/landing/landing-steps.ts";
import { jj, project } from "../support/workspace-project.ts";

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

afterEach(() => vi.mocked(run).mockReset());

test.each(["exact", "non-exact", "exact with remote movement", "exact with hook rejection"])(
  "%s integration publication retries only transient push failures without changing its predecessor", async (scenario) => {
    const f = await project();
    try {
      const commit = (revision: string) => jj(f.repo, ["log", "-r", revision, "--no-graph", "-T", "commit_id"]);
      const base = commit("main@origin");
      await writeFile(join(f.repo, "A"), "A\n"); jj(f.repo, ["describe", "-m", "A"]);
      const a = commit("@");
      jj(f.repo, ["new", a, "-m", "B"]); await writeFile(join(f.repo, "B"), "B\n");
      const b = commit("@");
      jj(f.repo, ["bookmark", "set", "main", "-r", b]);

      let attempts = 0;
      vi.mocked(run).mockImplementation(async (...args) => {
        if (args[0] !== "jj" || !args[1].includes("push") || ++attempts !== 1) return realRun(...args);
        if (scenario === "exact with remote movement")
          execFileSync("git", ["--git-dir", jj(f.repo, ["git", "root"]), "push", f.remote, `${a}:refs/heads/main`], { stdio: "pipe" });
        return { code: 1, signal: null, timedOut: false, stdout: "", truncated: false,
          stderr: scenario === "exact with hook rejection" ? "pre-receive hook declined" : "remote: fatal: unable to rename temporary 'tmp.pack' file" };
      });

      const result = await publishIntegration(f.repo, "origin", "main", b, scenario === "non-exact" ? undefined : base);
      const remote = execFileSync("git", ["--git-dir", f.remote, "rev-parse", "main"], { encoding: "utf8" }).trim();
      assert.equal(attempts, scenario === "exact with hook rejection" ? 1 : 2);
      assert.ok(vi.mocked(run).mock.calls.every(([, args]) => !args.includes("fetch")), "no fetch refreshed tracking for a retry");
      if (scenario === "exact with remote movement" || scenario === "exact with hook rejection") {
        assert.equal(result.ok, false, JSON.stringify(result));
        assert.equal(remote, scenario === "exact with remote movement" ? a : base);
        assert.equal(commit("main@origin"), base, "a failed exact-parent push must not adopt the moved remote");
      } else {
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(remote, b);
      }
    } finally { await f.dispose(); }
  },
);
