import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { landThroughRunner } from "../../src/lib/runner/runner-client.ts";
import { startRunner } from "../../src/lib/runner/runner-service.ts";
import { poolRefillLogPath } from "../../src/lib/workspace/workspace-paths.ts";
import { directExecutor } from "./executor.ts";
import { configureLocalGithubTransport } from "./workspace-project.ts";
import { drainFixtureWorkers, waitForExit } from "./fixture-workers.ts";
export { waitForExit } from "./fixture-workers.ts";

// Kept apart from workspace-project.ts so a test that only needs a project does not import the runner.

/**
 * Run `body` against a runner started in-process with its own home under the
 * fixture's root, stopped afterwards. `env` names it (SLIPJAY_RUNNER) and carries
 * its token, so `body` can land through the library or the CLI.
 */
export async function withTestRunner<T>(f: { root: string; repo: string; remote: string }, body: (runner: { location: string; env: NodeJS.ProcessEnv }) => Promise<T>,
  options: { build?: { origin: string; token: string } } = {}): Promise<T> {
  const transport = await configureLocalGithubTransport(f);
  try {
    // A runner commits as the identity its config names for the commits it rewrites.
    const home = join(f.root, "runner");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({ name: "test-runner", repos: { "fixture/project": { url: transport.github } },
      jj: { "user.name": "Fixture", "user.email": "fixture@example.com" }, ...options.build ? { build: { origin: options.build.origin } } : {} }));
    const runner = await startRunner({ home, port: 0, executor: directExecutor("test-runner"),
      env: { ...process.env, SLIPJAY_RUNNER_TOKEN: "test-token", ...options.build ? { YARDSMITH_SLIPJAY_BUILD_TOKEN: options.build.token } : {} } });
    try {
      return await body({ location: runner.url, env: { ...process.env, SLIPJAY_RUNNER: runner.url, SLIPJAY_RUNNER_TOKEN: "test-token" } });
    } finally {
      // Housekeeping may still need this runner's Build API. Join it and all
      // workers it spawned before closing the service or removing the fixture.
      try { await drainFixtureWorkers(f.root); } finally { await runner.close(); }
    }
  } finally {
    transport.restore();
  }
}

/**
 * Land `cwd` the one way SlipJay lands: through a test runner (withTestRunner).
 * `keep` holds the workspace with another process while it lands, so the landing
 * keeps it as it would any workspace in use; `direct` lands the primary checkout.
 */
export function landThroughTestRunner(f: { root: string; repo: string; remote: string }, cwd: string, options: { direct?: boolean; keep?: boolean; build?: { origin: string; token: string };
  session?: string; before?: () => Promise<void> } = {}) {
  return withTestRunner(f, async ({ location, env }) => {
    // Its own process group: the landing ignores its caller's group as it would the CLI's.
    const holder = options.keep ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd, stdio: "ignore", detached: true }) : null;
    const lines: string[] = [];
    try {
      const logged = (await readFile(poolRefillLogPath(), "utf8").catch(() => "")).length;
      const result = await landThroughRunner(cwd, { location, env, direct: options.direct, session: options.session, onLine: (line) => { lines.push(line); } });
      // The landing's housekeeping runs detached after its verdict: wait for it, and report its lines as the landing's.
      if (result.housekeeping?.pid) {
        await waitForExit(result.housekeeping.pid);
        lines.push(...(await readFile(poolRefillLogPath(), "utf8")).slice(logged).split("\n").filter(Boolean));
      }
      // Anything the test waits for while the runner is still up, such as its Build receipts.
      await options.before?.();
      return { ...result, lines };
    } finally {
      if (holder && holder.exitCode === null && holder.signalCode === null) {
        const exited = new Promise<void>((resolve) => holder.once("close", () => resolve()));
        holder.kill();
        await exited;
      }
    }
  }, options.build ? { build: options.build } : {});
}

