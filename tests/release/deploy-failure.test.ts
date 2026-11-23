import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { runBoundedProcess } from "../../src/lib/infra/bounded-process.ts";
import type { BoundedProcessResult } from "../../src/lib/infra/bounded-process.ts";
import { failure, runDeploy } from "../../src/lib/release/deploy.ts";

const exited = (stderr: string, stdout = "") => ({ exitCode: 1, signal: null, timedOut: false, stdout, stderr }) as unknown as BoundedProcessResult;

test("an uncaught error's reason is its message, not the stack and banner after it", () => {
  const bun = [
    "125 |   const drill = drillFailure(homedir(), process.env, step, name);",
    "126 |   if (drill) throw new Error(drill);",
    "                         ^",
    "error: release drill: www health fails on purpose",
    "      at /tmp/source/scripts/deploy.ts:126:23",
    "",
    "Bun v1.4.3 (Linux x64)",
  ].join("\n");
  assert.equal(failure(exited(bun), 1000), "exited 1: error: release drill: www health fails on purpose");
});

test("an error block counts on either stream and through colour codes", () => {
  assert.equal(failure(exited("warning: using fallback config", "Error: health endpoint unavailable"), 1000), "exited 1: Error: health endpoint unavailable\nwarning: using fallback config");
  assert.equal(failure(exited("\u001b[31merror\u001b[0m: www health failed\n    at /tmp/deploy.ts:1:1\n\nBun v1.4.3 (Linux x64)"), 1000), "exited 1: error: www health failed");
});

test("output with no error block keeps its last lines", () => {
  assert.equal(failure(exited("one\ntwo\nthree\nhq health failed"), 1000), "exited 1: two\nthree\nhq health failed");
  assert.equal(failure({ ...exited(""), exitCode: 0 }, 1000), null);
});

for (const baseline of ["exact policy", "missing activation", "missing commit"] as const) {
  test(`activation failure restores both moved projects with ${baseline}`, async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "slipjay-deploy-restore-"));
    try {
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
      const commit = (subject: string) => {
        git("add", ".");
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", subject);
        return git("rev-parse", "HEAD");
      };
      const names = ["app", "admin"];
      const command = { executable: "sh", args: ["-c", "echo https://candidate.example.test"], cwd: "." };
      const projects = names.map((name) => ({ name, command, activate: { executable: "sh", args: ["activate.sh", name], cwd: "scripts" } }));
      git("init", "--quiet");
      mkdirSync(path.join(repo, "scripts"));
      writeFileSync(path.join(repo, "slipjay.json"), JSON.stringify({ version: 1, deployments: { version: 1, environments: {
        staging: { timeoutMs: 1000, environmentKeys: ["SERVING_ONLY"], projects: projects.map(({ name, command }) => ({
          name, command, ...baseline === "missing activation" ? {} : { activate: { executable: "sh", args: ["activate.sh", "serving", name], cwd: "scripts" } },
        })) },
      } } }));
      writeFileSync(path.join(repo, "scripts/activate.sh"), [
        'test "$1" = serving || exit 10',
        'test "$SERVING_ONLY" = old && test -z "$CANDIDATE_ONLY" || exit 11',
        'test "$SLIPJAY_DEPLOY_RESTORE" = 1 && test "$SLIPJAY_DEPLOY_ROLLBACK_ALLOWED" = 1 || exit 12',
        'test "$SLIPJAY_DEPLOY_ENVIRONMENT" = staging && test "$SLIPJAY_DEPLOY_URL" = "https://$2.before.example.test" || exit 13',
        'test "$SLIPJAY_MACHINE_SSH" = /fixture/ssh || exit 14',
      ].join("\n"));
      const serving = commit("Serving release");
      writeFileSync(path.join(repo, "slipjay.json"), "{}");
      writeFileSync(path.join(repo, "scripts/activate.sh"), [
        'if test "$SLIPJAY_DEPLOY_RESTORE" = 1; then',
        baseline === "exact policy" ? "  echo 'candidate refuses restore' >&2; exit 19" : '  test "$CANDIDATE_ONLY" = new && test -z "$SERVING_ONLY"; exit "$?"',
        'fi',
        'test "$1" = app',
      ].join("\n"));
      const commitId = commit("Candidate");
      const previous = baseline === "missing commit" ? "0".repeat(40) : serving;
      const restores: { cwd: string; head: string; commit: string | undefined }[] = [];
      const record = await runDeploy({
        gitDirectory: path.join(repo, ".git"), environment: "staging", commitId, previous, policy: {
          minIntervalMs: 0, timeoutMs: 1000, machine: "images", environmentKeys: ["CANDIDATE_ONLY"], projects,
        },
        previousUrls: Object.fromEntries(names.map((name) => [name, `https://${name}.before.example.test`])),
        readEnvironment: () => ({ SERVING_ONLY: "old", CANDIDATE_ONLY: "new" }), onProgress: () => {},
        lease: async () => ({ machine: { verifier: "boat", id: "fixture", name: "fixture", size: "large", image: "fixture" },
          env: { SLIPJAY_MACHINE_SSH: "/fixture/ssh" }, close: async () => null }),
        run: async (request) => {
          if (request.env?.SLIPJAY_DEPLOY_RESTORE === "1") restores.push({ cwd: request.cwd,
            head: execFileSync("git", ["-C", request.cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            commit: request.env.SLIPJAY_DEPLOY_COMMIT });
          return runBoundedProcess(request);
        },
      });
      const expected = baseline === "exact policy" ? serving : commitId;
      assert.deepEqual(restores.map(({ head, commit }) => [head, commit]), [[expected, expected], [expected, expected]]);
      assert.equal(restores[0]!.cwd, restores[1]!.cwd, "the restores share one source view");
      assert.equal(existsSync(restores[0]!.cwd), false, "the temporary view is removed");
      assert.equal(git("rev-parse", "HEAD"), commitId, "the runner's checkout is unchanged");
      assert.deepEqual(record.projects.map(({ ok, activated, restored, timings }) => [ok, activated, restored, timings?.rollback?.outcome]), [
        [true, false, true, "passed"], [false, false, true, "passed"],
      ]);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
}

test("image build failures keep their real errors and retained log pointer, not wrappers", () => {
  const summary = "the api image build failed (exit 1):";
  const causes = ["#29 2.231 error: prune-modules: unresolved imports", "#29 2.231 apps/server/chunks/elk-QONTBCTQ.js -> ./elk-api.js", "#29 2.232 RolldownError: bundle budget exceeded: 426 kB"];
  const stack = "#29 2.232     at /app/build.ts:1:1";
  const wrapper = "#29 ERROR: process failed\nERROR: failed to build: failed to solve";
  const log = "the build's plain-progress output is kept at /tmp/build.log";
  assert.equal(failure(exited([summary, ...causes, stack, wrapper, log].join("\n")), 1000), ["exited 1: " + summary, ...causes, log].join("\n"));
  assert.equal(failure(exited([...causes, stack, wrapper].join("\n")), 1000), "exited 1: " + causes.join("\n"));
  const long = failure(exited([summary, ...causes, "#29 2.233 TypeError: " + "unavailable ".repeat(300), wrapper, log].join("\n")), 1000)!;
  assert.ok(long.length <= 2010);
  assert.match(long, / unavailable…\nthe build's plain-progress output/);
});

test("image failure details come from the final summary block, not earlier parallel BuildKit output", () => {
  const earlier = "#12 0.5 error: unrelated image failure";
  const summary = "the app image build failed (exit 1):";
  const cause = "#29 2.231 error: prune-modules: unresolved app imports";
  const expected = `exited 1: ${summary}\n${cause}`;
  assert.equal(failure(exited([earlier, summary, cause].join("\n")), 1000), expected);
  assert.equal(failure(exited(`${summary}\n${cause}`, [earlier, summary, "#22 2.0 Error: stale streamed detail"].join("\n")), 1000), expected);
});
