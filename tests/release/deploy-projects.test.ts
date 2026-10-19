import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, vi } from "vite-plus/test";
import type { BoundedProcessRequest, BoundedProcessResult } from "../../src/lib/infra/bounded-process.ts";
import { runDeploy } from "../../src/lib/release/deploy.ts";
import type { DeploymentEnvironment } from "../../src/lib/policy/deployment-policy.ts";

const exited = (exitCode: number, stdout: string) => ({ exitCode, signal: null, timedOut: false, cancelled: false, stdout, stderr: "" }) as unknown as BoundedProcessResult;

type Running = { request: BoundedProcessRequest; resolve(result: BoundedProcessResult): void; reject(error: Error): void };

/** Deploy `names` from a one-commit repository; each command runs until the test settles it in `running`. */
async function deployHeld(names: string[], body: (running: Map<string, Running>, record: Promise<unknown>) => Promise<void>) {
  const repo = mkdtempSync(path.join(tmpdir(), "slipjay-deploy-projects-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "--quiet");
    writeFileSync(path.join(repo, "README.md"), "fixture\n");
    git("add", "README.md");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "Initial");
    const policy: DeploymentEnvironment = { minIntervalMs: 0, timeoutMs: 60_000, environmentKeys: [],
      projects: names.map((name) => ({ name, command: { executable: "deploy", args: [name], cwd: "." } })) };
    const running = new Map<string, Running>();
    const record = runDeploy({
      gitDirectory: path.join(repo, ".git"), environment: "staging", commitId: git("rev-parse", "HEAD"), previous: null, policy,
      readEnvironment: () => ({}), onProgress: () => {},
      run: (request) => new Promise((resolve, reject) => running.set(request.args[0]!, { request, resolve, reject })),
    });
    // All of them can be running at once only if none waits for another.
    await vi.waitFor(() => assert.deepEqual([...running.keys()].sort(), [...names].sort()), { timeout: 10_000, interval: 10 });
    await body(running, record);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test("an environment's projects deploy side by side, and the record keeps their declared order", async () => {
  await deployHeld(["app", "hq", "www"], async (running, record) => {
    running.get("www")!.resolve(exited(0, "https://www.example.test"));
    running.get("hq")!.resolve(exited(1, ""));
    running.get("app")!.resolve(exited(0, "https://app.example.test"));
    const { projects } = await record as Awaited<ReturnType<typeof runDeploy>>;
    assert.deepEqual(projects.map(({ name, ok, url }) => ({ name, ok, url })), [
      { name: "app", ok: true, url: "https://app.example.test" },
      { name: "hq", ok: false, url: undefined },
      { name: "www", ok: true, url: "https://www.example.test" },
    ]);
  });
});

test("a command that throws fails the deploy only after the other projects stop, keeping their source view", async () => {
  await deployHeld(["app", "hq"], async (running, record) => {
    let settled = false;
    record.then(() => { settled = true; }, () => { settled = true; });
    running.get("app")!.reject(new Error("could not stop app's processes"));
    // While hq still runs, the deploy stays open and hq's checkout stays in place.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(settled, false);
    assert.ok(existsSync(running.get("hq")!.request.cwd));
    running.get("hq")!.resolve(exited(0, "https://hq.example.test"));
    await assert.rejects(record, /could not stop app's processes/);
  });
});
