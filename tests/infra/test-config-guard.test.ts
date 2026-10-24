import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";

// A test that writes the developer's own jj or git configuration replaces their identity with the
// fixture's. Fixtures set identity per repository (`--repo`), through JJ_CONFIG / JJ_USER / JJ_EMAIL,
// or in the disposable HOME's Git config (see scripts/fixture-git-config.ts).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const self = fileURLToPath(import.meta.url);

// Patterns are assembled from parts so this file does not contain what it forbids. A write is matched
// across line breaks within one call or command (up to its closing parenthesis or `;`), with the flag
// before or after the key.
const sep = "[\"'`,\\s]+";
const jjUser = new RegExp(`config${sep}(?:set|unset|edit)\\b[^;)]*?--${"user"}\\b`);
const gitGlobal = new RegExp(`\\bconfig\\b[^;)]*?--(?:${"global"}|system)\\b`);
const forbidden = [{ rule: "jj user config", pattern: jjUser }, { rule: "git global config", pattern: gitGlobal }];

// Test sources and the test-only scripts (which `bun test` runs outside Vitest's disposable HOME).
function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "node_modules") yield* sources(path); }
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) yield path;
  }
}
const scanned = () => [...sources(join(repoRoot, "tests")), ...sources(join(repoRoot, "scripts"))].filter((path) => path !== self);

test("test sources never write the developer's jj or git configuration", () => {
  const offences = scanned().flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return forbidden.flatMap(({ rule, pattern }) => {
      const global = new RegExp(pattern.source, "g");
      return [...text.matchAll(global)].map((match) => `${relative(repoRoot, path)}:${text.slice(0, match.index).split("\n").length} (${rule})`);
    });
  });
  assert.deepEqual(offences, []);
});

test("the guard recognises the writes it forbids", () => {
  const flag = "--" + "user";
  assert.ok(jjUser.test(`jj(root, ["config", "set", "${flag}", "user.name", "x"])`));
  assert.ok(jjUser.test(`jj(root, ["config", "set",\n  "${flag}", "user.name", "x"])`));
  assert.ok(jjUser.test(`jj config set ${flag} user.name x`));
  assert.ok(jjUser.test(`jj config set user.name x ${flag}`));
  assert.ok(jjUser.test(`jj config edit ${flag}`));
  assert.ok(gitGlobal.test(`git(["config", "--${"global"}", "user.name", "x"])`));
  assert.ok(gitGlobal.test(`git config --${"global"} user.name x`));
  assert.ok(gitGlobal.test(`execFileSync("git", ["-C", dir, "config",\n  "--${"system"}", "a", "b"])`));
  assert.ok(!jjUser.test(`jj(root, ["config", "set", "--repo", "user.name", "x"])`));
  assert.ok(!jjUser.test(`jj(root, ["config", "set", "--repo", "a", "b"]); other(["--${"user"}"])`));
  assert.ok(!gitGlobal.test(`git(["config", "user.name", "x"])`));
});

test("the hermetic test setup drops an inherited JJ_CONFIG and GIT_CONFIG_GLOBAL", () => {
  // scripts/vitest-hermetic-env.ts runs before this file; nothing here sets them.
  assert.equal(process.env.JJ_CONFIG, undefined);
  assert.equal(process.env.GIT_CONFIG_GLOBAL, undefined);
});
