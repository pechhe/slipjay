import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, vi } from "vite-plus/test";
import { runDeploy } from "../../src/lib/release/deploy.ts";
import type { BoundedProcessResult } from "../../src/lib/infra/bounded-process.ts";

for (const failed of [undefined, "build", "migrate", "health", "activate", "rollback"] as const) {
  test(`step timings survive ${failed ?? "successful deployment"}`, async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "deploy-timing-"));
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
      git("init", "--quiet"); writeFileSync(path.join(repo, "fixture"), "fixture"); git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "fixture");
      const command = (executable: string) => ({ executable, args: [], cwd: "." });
      const record = await runDeploy({ gitDirectory: path.join(repo, ".git"), environment: "production", commitId: git("rev-parse", "HEAD"), previous: null,
        migrationArtifacts: ["migrations/0001.sql"], previousUrls: { app: "https://before.example" },
        policy: { minIntervalMs: 0, timeoutMs: 1000, environmentKeys: [],
          projects: [{ name: "app", command: command("build"), healthCheck: command("health"), activate: command("activate") }],
          migrations: { verify: command("migrate"), apply: command("apply") } },
        readEnvironment: () => ({}), onProgress: () => {},
        run: async ({ executable, env }) => {
          now += 10;
          const step = env?.SLIPJAY_DEPLOY_RESTORE === "1" ? "rollback" : executable;
          const fails = step === failed || failed === "rollback" && step === "activate";
          return { exitCode: fails ? 1 : 0, stdout: executable === "build" ? "https://new.example" : "", stderr: "", signal: null, timedOut: false } as BoundedProcessResult;
        } });
      const project = record.projects[0]!;
      assert.ok(project);
      for (const [name, timing] of Object.entries(project.timings!)) {
        assert.equal(timing.durationMs, 10, name);
        assert.ok(Number.isFinite(Date.parse(timing.startedAt)), name);
        assert.equal(timing.outcome, name === failed || failed === "rollback" && name === "activate" ? "failed" : "passed", name);
      }
      if (failed) assert.equal(project.timings?.[failed]?.outcome, "failed");
      else assert.deepEqual(Object.keys(project.timings!).sort(), ["activate", "build", "health", "migrate"]);
      if (failed === "activate") assert.equal(project.timings?.rollback?.outcome, "passed");
      if (failed === "migrate") assert.equal(project.timings?.build, undefined);
    } finally { clock.mockRestore(); rmSync(repo, { recursive: true, force: true }); }
  });
}

for (const skipped of ["health", "activate", "rollback"] as const) {
  test(`missing input for ${skipped} keeps the failure reason without a command interval`, async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "deploy-missing-input-"));
    try {
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
      git("init", "--quiet"); writeFileSync(path.join(repo, "fixture"), "fixture"); git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "fixture");
      const command = (executable: string) => ({ executable, args: [], cwd: "." });
      const calls: string[] = [];
      const record = await runDeploy({ gitDirectory: path.join(repo, ".git"), environment: "production", commitId: git("rev-parse", "HEAD"), previous: null,
        policy: { minIntervalMs: 0, timeoutMs: 1000, environmentKeys: [], projects: [{ name: "app", command: command("build"),
          ...skipped === "health" ? { healthCheck: command("health") } : { activate: command("activate") } }] },
        readEnvironment: () => ({}), onProgress: () => {},
        run: async ({ executable }) => {
          calls.push(executable);
          return { exitCode: executable === "activate" ? 1 : 0, stdout: skipped === "rollback" ? "https://new.example" : "", stderr: "", signal: null, timedOut: false } as BoundedProcessResult;
        } });
      const project = record.projects[0]!;
      assert.equal(project.ok, false);
      assert.match(project.reason!, skipped === "rollback" ? /no earlier deployment is recorded/ : /printed no deployment URL/);
      assert.equal(project.timings?.[skipped], undefined);
      assert.deepEqual(calls, skipped === "rollback" ? ["build", "activate"] : ["build"]);
      assert.equal(project.timings?.build?.outcome, "passed");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
}
