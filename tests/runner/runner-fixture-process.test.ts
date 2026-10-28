import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vite-plus/test";
import { startTestRunnerProcess } from "../support/test-runner-process.ts";

const observed = vi.hoisted(() => ({ child: undefined as import("node:child_process").ChildProcess | undefined }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: (...args: Parameters<typeof actual.fork>) => {
    const child = actual.fork(...args);
    observed.child = child;
    return child;
  } };
});

async function fixture(body: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "runner-process-"));
  try {
    await writeFile(join(home, "config.json"), JSON.stringify({ name: "test-runner", repos: { "fixture/project": { url: "/unused" } },
      jj: { "user.name": "Fixture", "user.email": "fixture@example.com" } }));
    await body(home);
  } finally { await rm(home, { recursive: true, force: true }); }
}
const environment = () => ({ ...process.env, SLIPJAY_RUNNER_TOKEN: "test-token" });

test("fixture runner serves authenticated HTTP and joins its exit and output", () => fixture(async (home) => {
  const runner = await startTestRunnerProcess({ home, env: environment() });
  try {
    const response = await fetch(`${runner.url}/v1/health`, { headers: { authorization: "Bearer test-token" } });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  } finally { await runner.close(); }
  assert.throws(() => process.kill(runner.pid, 0), /ESRCH/);
}));

test("fixture runner propagates startup failures instead of waiting for readiness", () => fixture(async (home) => {
  await writeFile(join(home, "config.json"), "{}");
  // The child reports the failure this test expects on stderr. Every test in the run shares that stream, and a
  // landing's failure summary reads its first error from it, so it would name this expected error instead of the
  // failing test's. Keep it off the shared stream; the rejection below carries the runner's own message.
  const echo = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await assert.rejects(startTestRunnerProcess({ home, env: environment() }), /runner config sets no user.name/);
  } finally { echo.mockRestore(); }
}));

test("fixture runner fails its caller when the child terminates unexpectedly", () => fixture(async (home) => {
  const runner = await startTestRunnerProcess({ home, env: environment() });
  process.kill(runner.pid, "SIGKILL");
  await vi.waitFor(() => assert.throws(() => process.kill(runner.pid, 0), /ESRCH/));
  await assert.rejects(runner.close(), /Runner child exited: code=null, signal=SIGKILL/);
}));

test("fixture runner closes when its parent dies", () => fixture(async (home) => {
  const script = join(home, "parent.mjs");
  const helper = pathToFileURL(join(process.cwd(), "tests/support/test-runner-process.ts")).href;
  await writeFile(script, `import { startTestRunnerProcess } from ${JSON.stringify(helper)};
    const runner = await startTestRunnerProcess({home: process.argv[2], env: process.env});
    process.send({pid: runner.pid, url: runner.url});`);
  const parent = fork(script, [home], { env: environment(), execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = "";
  parent.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const exited = new Promise<void>((resolve) => parent.once("exit", () => resolve()));
  let pid: number | undefined;
  try {
    const ready = await new Promise<{ pid: number; url: string }>((resolve, reject) => {
      parent.once("message", (message) => resolve(message as { pid: number; url: string }));
      parent.once("exit", () => reject(new Error(`Fixture parent exited before readiness: ${stderr}`)));
      parent.once("error", reject);
    });
    pid = ready.pid;
    parent.kill("SIGKILL");
    await exited;
    await vi.waitFor(async () => {
      let status = "";
      try { status = execFileSync("ps", ["-p", String(ready.pid), "-o", "stat="], { encoding: "utf8" }).trim(); } catch { /* process gone */ }
      assert.ok(!status || status.startsWith("Z"), "runner is no longer executing after its parent died");
    }, { timeout: 10_000 });
    await assert.rejects(fetch(`${ready.url}/v1/health`));
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    await exited;
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  }
}));


test("an IPC send failure preserves its error and joins the still-live runner and output", () => fixture(async (home) => {
  const runner = await startTestRunnerProcess({ home, env: environment() });
  const child = observed.child!;
  try {
    // Stop the live child before closing IPC, so disconnect cannot make it exit first.
    process.kill(runner.pid, "SIGSTOP");
    child.disconnect();
    assert.doesNotThrow(() => process.kill(runner.pid, 0));
    await assert.rejects(runner.close(), /Channel closed/);
    assert.throws(() => process.kill(runner.pid, 0), /ESRCH/);
    assert.equal(child.stdout!.readableEnded, true);
    assert.equal(child.stderr!.readableEnded, true);
  } finally {
    try { process.kill(runner.pid, "SIGKILL"); } catch { /* already joined */ }
  }
}));
