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

test("successful and failed builds record exact elapsed intervals", async () => {
  let now = 0;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    await deployHeld(["app", "hq"], async (running, pending) => {
      now = 250;
      running.get("app")!.resolve(exited(0, "https://app.example.test"));
      running.get("hq")!.resolve(exited(1, "build failed"));
      const record = await pending as Awaited<ReturnType<typeof runDeploy>>;
      for (const [index, project] of record.projects.entries()) {
        assert.equal(project.timings?.build?.durationMs, 250);
        assert.equal(project.timings?.build?.outcome, index === 0 ? "passed" : "failed");
        assert.ok(Number.isFinite(Date.parse(project.timings!.build!.startedAt)));
        assert.equal(project.timings?.activate, undefined, "unreached steps have no invented interval");
      }
    });
  } finally { clock.mockRestore(); }
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

test("migrations go before the projects deploy only when the promotion's known files are all additive", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "slipjay-deploy-order-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "--quiet");
    writeFileSync(path.join(repo, "README.md"), "fixture\n");
    git("add", "README.md");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "Initial");
    const command = (name: string) => ({ executable: name, args: [], cwd: "." });
    const policy: DeploymentEnvironment = { minIntervalMs: 0, timeoutMs: 60_000, environmentKeys: [],
      projects: [{ name: "app", command: command("deploy"), healthCheck: command("health"), activate: command("activate") }],
      migrations: { verify: command("verify"), apply: command("apply") } };
    const order = async (migrationArtifacts: string[] | undefined, nonAdditive = false) => {
      const steps: string[] = [];
      let applied = false;
      const record = await runDeploy({
        gitDirectory: path.join(repo, ".git"), environment: "production", commitId: git("rev-parse", "HEAD"), previous: null, policy,
        nonAdditive, ...migrationArtifacts ? { migrationArtifacts } : {}, readEnvironment: () => ({}), onProgress: () => {},
        run: async ({ executable }) => {
          steps.push(executable);
          if (executable === "apply") applied = true;
          return exited(executable === "verify" && !applied ? 2 : 0, executable === "deploy" ? "https://app.example.test" : "");
        },
      });
      for (const name of ["build", "migrate", "health", "activate"] as const) {
        const timing = record.projects[0]!.timings?.[name];
        assert.equal(timing?.outcome, "passed", name);
        assert.ok(timing!.durationMs >= 0, name);
        assert.ok(Number.isFinite(Date.parse(timing!.startedAt)), name);
      }
      return steps.join(" ");
    };
    const early = "verify apply verify deploy health activate";
    const late = "deploy health verify apply verify activate";
    assert.equal(await order(["migrations/0001.sql"]), early);
    assert.equal(await order(["migrations/0001.sql"], true), late, "non-additive");
    assert.equal(await order(["drizzle/0001.sql", "drizzle/meta/0001_snapshot.json", "drizzle/meta/_journal.json"]), early, "Drizzle metadata beside the SQL");
    assert.equal(await order([]), late, "a rerun whose plan saw no commits does not know its files");
    assert.equal(await order(undefined), late, "a record from before the files were carried");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("an environment that names a machine leases it for the whole deploy, records it, and fails without one", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "slipjay-deploy-machine-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "--quiet");
    writeFileSync(path.join(repo, "README.md"), "fixture\n");
    git("add", "README.md");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "Initial");
    const policy: DeploymentEnvironment = { minIntervalMs: 0, timeoutMs: 60_000, environmentKeys: [], machine: "images", projects: [
      { name: "images", command: { executable: "build", args: [], cwd: "." } },
      { name: "services", command: { executable: "services", args: [], cwd: "." } }] };
    const machine = { verifier: "boat" as const, id: "bx_images", name: "slipjay-pechhe-yardsmith-images", size: "large", image: "bx_image" };
    const commands: BoundedProcessRequest[] = [];
    const leased: string[] = [];
    let closed = 0;
    const deploy = (lease?: Parameters<typeof runDeploy>[0]["lease"]) => runDeploy({
      gitDirectory: path.join(repo, ".git"), environment: "images", commitId: git("rev-parse", "HEAD"), previous: null, policy,
      readEnvironment: () => ({}), onProgress: () => {}, ...lease ? { lease } : {},
      run: async (request) => { commands.push(request); return exited(0, ""); },
    });
    const record = await deploy(async (pool) => {
      leased.push(pool);
      return { machine, env: { SLIPJAY_MACHINE_SSH: "/scratch/ssh", SLIPJAY_MACHINE_GIT_DIR: "/home/user/m.git" }, close: async () => { closed++; return { seconds: 312, dollars: 0.0062 }; } };
    });
    assert.deepEqual(leased, ["images"], "one lease for the deploy");
    assert.equal(closed, 1);
    assert.deepEqual(commands.map((request) => request.env?.SLIPJAY_MACHINE_SSH), ["/scratch/ssh", "/scratch/ssh"]);
    assert.deepEqual(record.machine, { ...machine, billed: { seconds: 312, dollars: 0.0062 } });

    commands.length = 0;
    await assert.rejects(deploy(async () => { throw new Error("Remote executor unavailable (boat): boat fork: out of starts"); }), /Remote executor unavailable \(boat\): boat fork: out of starts/);
    assert.deepEqual(commands, [], "a deploy whose machine is unavailable runs nothing, anywhere");
    await assert.rejects(deploy(), /deployments images names machine images, but this runner has no remote verifier/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
