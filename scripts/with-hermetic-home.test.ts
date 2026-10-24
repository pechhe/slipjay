import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const wrapper = fileURLToPath(new URL("./with-hermetic-home.ts", import.meta.url));
const probe = "console.log(JSON.stringify({ home: require('node:os').homedir(), timeout: process.env.SLIPJAY_COMMAND_TIMEOUT_MS ?? null, agent: process.env.PI_CODING_AGENT_DIR ?? null, jjConfig: process.env.JJ_CONFIG ?? null, gitConfig: process.env.GIT_CONFIG_GLOBAL ?? null }))";

test("runs the command with a disposable HOME and without host session or config-path variables", () => {
  const result = spawnSync(process.execPath, [wrapper, process.execPath, "-e", probe], {
    encoding: "utf8",
    env: { ...process.env, SLIPJAY_COMMAND_TIMEOUT_MS: "1000", PI_CODING_AGENT_DIR: "/host/agent", JJ_CONFIG: "/host/jj.toml", GIT_CONFIG_GLOBAL: "/host/gitconfig" },
  });
  expect(result.status).toBe(0);
  const seen = JSON.parse(result.stdout.trim());
  expect(seen.home).not.toBe(homedir());
  expect(seen.home).toContain("peach-test-home-");
  expect(seen.timeout).toBeNull();
  expect(seen.agent).toBeNull();
  expect(seen.jjConfig).toBeNull();
  expect(seen.gitConfig).toBeNull();
  expect(existsSync(seen.home)).toBe(false);
});

test("propagates the command's failure", () => {
  const result = spawnSync(process.execPath, [wrapper, process.execPath, "-e", "process.exit(3)"]);
  expect(result.status).toBe(3);
});

test("bare and cloned repositories commit with the disposable HOME's Git identity", () => {
  const script = `
    import { execFileSync } from 'node:child_process';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { homedir } from 'node:os';
    import { join } from 'node:path';
    const remote = join(homedir(), 'remote.git');
    const seed = join(homedir(), 'seed');
    const repo = join(homedir(), 'primary');
    mkdirSync(seed);
    writeFileSync(join(seed, 'seed.txt'), 'identity probe');
    const git = (args, cwd = seed) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
    git(['init', '--bare', '--initial-branch=main', remote]);
    git(['--git-dir', remote, '--work-tree', seed, 'add', '.']);
    git(['--git-dir', remote, '--work-tree', seed, 'commit', '--quiet', '-m', 'Seed identity']);
    git(['clone', '--quiet', remote, repo]);
    git(['commit', '--quiet', '--allow-empty', '-m', 'Primary identity'], repo);
    const author = (args) => git([...args, 'log', '-1', '--format=%an <%ae>']);
    console.log(JSON.stringify([author(['--git-dir', remote]), author(['-C', repo])]));
  `;
  const result = spawnSync(process.execPath, [wrapper, "node", "--input-type=module", "--eval", script], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(JSON.stringify(["Fixture <fixture@example.com>", "Fixture <fixture@example.com>"]));
});
