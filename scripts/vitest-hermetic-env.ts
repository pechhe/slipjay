// Every Vitest file gets its own disposable HOME. slipjay, Peach and Pi derive
// durable workspace, lock and session state from `homedir()`, so a suite running
// with the developer's real HOME both pollutes ~/.slipjay and ~/.slipway and contends
// with the live sessions that own them (observed as 120-180s conformance hangs).
// This runs before the test file's imports, so module-level `homedir()`
// constants and spawned fixture processes both see the isolated value.
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vite-plus/test";
import { assertHermeticHome } from "./hermetic-home-guard.ts";

// Fixture repositories are written, synced and deleted within one test, and on a disk JJ's
// syncs take most of their time (nearly half of a landing test on the runner). Where Linux
// offers a RAM-backed /dev/shm, each file's temporary directory lives there and is removed with
// it; one a killed run left behind is removed by a later file once its process has gone. Fixtures
// run scripts from their temporary directory, so a noexec /dev/shm is passed over.
const SHM = "/dev/shm";
// The last mount at a path is the one in effect.
const executable = (mount: string) => {
  const options = readFileSync("/proc/self/mounts", "utf8").split("\n").map((line) => line.split(" ")).filter(([, target]) => target === mount).at(-1)?.[3];
  return options !== undefined && !options.split(",").includes("noexec");
};
let scratch: string | undefined;
if (process.platform === "linux" && existsSync(SHM) && executable(SHM)) {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
  for (const name of readdirSync(SHM)) {
    const owner = /^slipjay-test-(\d+)-/.exec(name)?.[1];
    if (owner && !alive(Number(owner))) rmSync(join(SHM, name), { recursive: true, force: true });
  }
  scratch = mkdtempSync(join(SHM, `slipjay-test-${process.pid}-`));
  process.env.TMPDIR = scratch;
}

const home = realpathSync(mkdtempSync(join(tmpdir(), "peach-test-home-")));
process.env.HOME = home;
// Every detached worker (including workers spawned by a worker) can be joined
// before a fixture closes its runner or deletes a repository it still uses.
process.env.SLIPJAY_BACKGROUND_WORKERS = join(home, "background-workers");
delete process.env.XDG_CONFIG_HOME;
delete process.env.XDG_STATE_HOME;
delete process.env.XDG_DATA_HOME;
// A config path set by the developer's shell would still reach their real jj or git
// configuration under the disposable HOME.
for (const key of ["JJ_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]) delete process.env[key];
// A runtime that resolves homedir() once at startup (Bun) ignores the new HOME;
// fail the file rather than let it write the real ~/.slipway.
assertHermeticHome();

// Host session variables describe the coding agent running the tests, not the
// fixture. Leaving them set lets fixtures open real terminal tabs or inherit
// the live workspace mode.
for (const key of Object.keys(process.env)) {
  if (/^(CMUX_|SLIPJAY_COMMAND_)/.test(key) || key === "PI_CODING_AGENT_DIR") delete process.env[key];
}

// Fixture repositories live for one test: Git's automatic gc and maintenance after
// commits, fetches and pushes only cost time there. Real checkouts keep them.
writeFileSync(join(home, ".gitconfig"), "[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n");

// A fixture allocating a workspace must not race its own sweeps with a background one.
process.env.SLIPJAY_AUTO_HOUSEKEEPING = "0";

afterAll(() => {
  rmSync(scratch ?? home, { recursive: true, force: true, maxRetries: 3 });
});
