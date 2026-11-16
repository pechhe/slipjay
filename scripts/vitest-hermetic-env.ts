// Every Vitest file gets its own disposable HOME. slipjay, Peach and Pi derive
// durable workspace, lock and session state from `homedir()`, so a suite running
// with the developer's real HOME both pollutes ~/.slipjay and ~/.slipway and contends
// with the live sessions that own them (observed as 120-180s conformance hangs).
// This runs before the test file's imports, so module-level `homedir()`
// constants and spawned fixture processes both see the isolated value.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vite-plus/test";
import { createFixtureScratch } from "./fixture-scratch.ts";
import { assertHermeticHome } from "./hermetic-home-guard.ts";
import { FIXTURE_GIT_IDENTITY } from "./fixture-git-config.ts";

// The file's fixtures share one scratch directory, which its disposable HOME lives inside: the RAM-backed /dev/shm
// where this process may write there and the temp directory otherwise (scripts/fixture-scratch.ts).
const scratch = createFixtureScratch();
process.env.TMPDIR = scratch;

const home = realpathSync(mkdtempSync(join(tmpdir(), "peach-test-home-")));
process.env.HOME = home;
// A runner a test starts must not wait on the real host's load, which is this suite's own.
process.env.SLIPJAY_HOST_BUDGET = "off";
// JJ otherwise spawns `tput cols` and `tput lines` on every raw fixture call.
// Match jjEnvironment's noninteractive fallback without changing an explicit width.
process.env.COLUMNS ||= "80";
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
writeFileSync(join(home, ".gitconfig"), FIXTURE_GIT_IDENTITY + "[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n", { mode: 0o600 });

// A fixture allocating a workspace must not race its own sweeps with a background one.
process.env.SLIPJAY_AUTO_HOUSEKEEPING = "0";

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
});
