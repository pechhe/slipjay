// Every Vitest file gets its own disposable HOME. slipjay, Peach and Pi derive
// durable workspace, lock and session state from `homedir()`, so a suite running
// with the developer's real HOME both pollutes ~/.slipjay and ~/.slipway and contends
// with the live sessions that own them (observed as 120-180s conformance hangs).
// This runs before the test file's imports, so module-level `homedir()`
// constants and spawned fixture processes both see the isolated value.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vite-plus/test";
import { assertHermeticHome } from "./hermetic-home-guard.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "peach-test-home-")));
process.env.HOME = home;
delete process.env.XDG_CONFIG_HOME;
delete process.env.XDG_STATE_HOME;
delete process.env.XDG_DATA_HOME;
// A runtime that resolves homedir() once at startup (Bun) ignores the new HOME;
// fail the file rather than let it write the real ~/.slipway.
assertHermeticHome();

// Host session variables describe the coding agent running the tests, not the
// fixture. Leaving them set lets fixtures open real terminal tabs or inherit
// the live workspace mode.
for (const key of Object.keys(process.env)) {
  if (/^(CMUX_|SLIPJAY_COMMAND_)/.test(key) || key === "PI_CODING_AGENT_DIR") delete process.env[key];
}

// A fixture allocating a workspace must not race its own sweeps with a background one.
process.env.SLIPJAY_AUTO_HOUSEKEEPING = "0";

afterAll(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});
