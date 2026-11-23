import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "vite-plus/test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const setupScript = join(repoRoot, "scripts", "setup-runner.sh");
const realBun = (() => {
  if ((process.versions as Record<string, string | undefined>).bun) return process.execPath;
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "bun");
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error("bun not found on PATH");
})();

let home: string;
let bin: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "setup-runner-"));
  bin = join(home, "bin");
  mkdirSync(bin);
  mkdirSync(join(home, ".slipjay", "runner-install", "src", "launcher"), { recursive: true });
  writeFileSync(join(home, ".slipjay", "runner-install", "src", "launcher", "workspace.ts"), "#!/usr/bin/env bun\n", { mode: 0o755 });
  writeFileSync(join(bin, "bun"), `#!/bin/sh\nexec ${JSON.stringify(realBun)} "$@"\n`, { mode: 0o755 });
  for (const tool of ["jj", "bws", "loginctl", "systemctl"]) {
    writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  writeFileSync(join(bin, "corepack"), [
    "#!/bin/sh",
    "dir=''",
    "while [ $# -gt 0 ]; do",
    "  case \"$1\" in",
    "    --install-directory) dir=$2; shift 2 ;;",
    "    *) shift ;;",
    "  esac",
    "done",
    "mkdir -p \"$dir\"",
    "printf '#!/bin/sh\\necho corepack-pnpm\\n' > \"$dir/pnpm\"",
    "chmod 755 \"$dir/pnpm\"",
  ].join("\n"), { mode: 0o755 });
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function runSetup(pathValue: string) {
  return spawnSync("bash", [setupScript, "pechhe/t3code=git@github.com:pechhe/t3code.git"], {
    encoding: "utf8",
    env: {
      HOME: home,
      USER: "ubuntu",
      PATH: pathValue,
      SLIPJAY_RUNNER_USER_NAME: "SlipJay Runner",
      SLIPJAY_RUNNER_USER_EMAIL: "runner@example.com",
    },
  });
}

function unitPath(): string {
  const unit = readFileSync(join(home, ".config", "systemd", "user", "slipjay-runner.service"), "utf8");
  const match = /^Environment=PATH=(.+)$/m.exec(unit);
  assert.ok(match?.[1], "slipjay-runner.service declares Environment=PATH");
  return match[1];
}

test("the runner unit finds global vp when Vite+ is installed outside the invoking PATH while keeping corepack pnpm first", () => {
  const vpBin = join(home, ".local", "share", "vite-plus", "bin");
  mkdirSync(vpBin, { recursive: true });
  writeFileSync(join(vpBin, "vp"), "#!/bin/sh\necho vite-plus-vp\n", { mode: 0o755 });
  writeFileSync(join(vpBin, "pnpm"), "#!/bin/sh\necho vite-plus-pnpm\n", { mode: 0o755 });

  // Non-login shell PATH: omits ~/.local/share/vite-plus/bin, just like a shell that never sourced ~/.config/vite-plus/env.
  const installed = runSetup(`${bin}:/usr/bin:/bin`);
  assert.equal(installed.status, 0, installed.stderr);

  const path = unitPath();
  const vpRun = spawnSync("vp", [], { encoding: "utf8", env: { PATH: path } });
  assert.equal(vpRun.error, undefined, `vp failed to spawn with unit PATH=${path}`);
  assert.equal(vpRun.status, 0);
  assert.equal(vpRun.stdout.trim(), "vite-plus-vp");

  const pnpmRun = spawnSync("pnpm", [], { encoding: "utf8", env: { PATH: path } });
  assert.equal(pnpmRun.status, 0);
  assert.equal(pnpmRun.stdout.trim(), "corepack-pnpm");
});

test("the runner unit does not duplicate an existing Vite+ bin on PATH or add a missing one", () => {
  const withoutVp = runSetup(`${bin}:/usr/bin:/bin`);
  assert.equal(withoutVp.status, 0, withoutVp.stderr);
  const vpBin = join(home, ".local", "share", "vite-plus", "bin");
  assert.equal(unitPath().split(":").includes(vpBin), false);

  mkdirSync(vpBin, { recursive: true });
  writeFileSync(join(vpBin, "vp"), "#!/bin/sh\necho vite-plus-vp\n", { mode: 0o755 });
  const withVp = runSetup(`${bin}:${vpBin}:/usr/bin:/bin`);
  assert.equal(withVp.status, 0, withVp.stderr);
  assert.equal(unitPath().split(":").filter((entry) => entry === vpBin).length, 1);
});

function runWith(args: string[]) {
  return spawnSync("bash", [setupScript, ...args], {
    encoding: "utf8",
    env: { HOME: home, USER: "ubuntu", PATH: `${bin}:/usr/bin:/bin`, SLIPJAY_RUNNER_USER_NAME: "SlipJay Runner", SLIPJAY_RUNNER_USER_EMAIL: "runner@example.com" },
  });
}

test("a re-run keeps top-level and per-repository settings, matches names case-insensitively and drops unlisted repositories", () => {
  const configPath = join(home, ".slipjay", "runner", "config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  const yardsmith = { url: "old-url", verifier: "boat", verificationDepth: 1, screeningLanes: 2, gateMachine: "peach-box", lane: "ys", hostPlaces: ["a"] };
  writeFileSync(configPath, JSON.stringify({ build: { x: 1 }, machines: { m: 1 }, repos: { "pechhe/yardsmith": yardsmith, "pechhe/gone": { url: "g", lane: "g" }, "pechhe/odd": "nope" } }));

  const run = runWith(["pechhe/YardSmith=new-url", "pechhe/odd=odd-url", "pechhe/fresh=fresh-url"]);
  assert.equal(run.status, 0, run.stderr);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert.deepEqual(config.build, { x: 1 });
  assert.deepEqual(config.machines, { m: 1 });
  assert.deepEqual(config.repos, {
    "pechhe/YardSmith": { ...yardsmith, url: "new-url" },
    "pechhe/odd": { url: "odd-url" },
    "pechhe/fresh": { url: "fresh-url" },
  });
});

test("a re-run copes with a config whose repos is not an object", () => {
  const configPath = join(home, ".slipjay", "runner", "config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ repos: [1] }));
  assert.equal(runWith(["a/b=u"]).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).repos, { "a/b": { url: "u" } });
});
