import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixtures must never write the developer's own `~/.config/jj/config.toml`, which a user-scope config write
// would. Their user-level settings live in a private file named by JJ_CONFIG instead, which jj and the
// child processes it starts (and the runner, which passes JJ_CONFIG on) read in place of the real one.
const settings = new Map<string, string>([["user.name", "Fixture"], ["user.email", "fixture@example.com"]]);
let file: string | undefined;

const write = () => writeFileSync(file!, [...settings].map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n") + "\n");

/** Point JJ_CONFIG at the private fixture config, creating it with the `Fixture` identity on first use; returns its path. */
export function fixtureJjConfig(): string {
  if (!file) {
    const dir = mkdtempSync(join(tmpdir(), "slipjay-test-jj-config-"));
    file = join(dir, "config.toml");
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    write();
  }
  process.env.JJ_CONFIG = file;
  return file;
}

/** Set a user-level jj setting for this process's fixtures only, in the private fixture config. */
export function setFixtureJjSetting(key: string, value: string): void {
  fixtureJjConfig();
  settings.set(key, value);
  write();
}
