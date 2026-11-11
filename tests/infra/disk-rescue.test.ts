import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "vite-plus/test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rescue = join(repoRoot, "scripts", "disk-rescue.sh");

let home: string;
let cache: string;
let ballast: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "disk-rescue-"));
  cache = join(home, "node-compile-cache");
  ballast = join(home, "ballast");
  mkdirSync(cache);
  writeFileSync(join(cache, "entry"), "x");
  writeFileSync(ballast, "y");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Run the rescue with a stated usage, so the result never depends on this machine's disk. */
function run(usage: number, extra: Record<string, string> = {}) {
  return spawnSync("sh", [rescue], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      SLIPJAY_RESCUE_USAGE_PERCENT: String(usage),
      SLIPJAY_RESCUE_REGENERABLE: cache,
      SLIPJAY_RESCUE_BALLAST: ballast,
      ...extra,
    },
  });
}

test("below the shed line the rescue removes nothing", () => {
  const result = run(60);
  assert.equal(result.status, 0);
  assert.ok(existsSync(cache));
  assert.ok(existsSync(ballast));
});

test("at the shed line it frees the regenerable paths and keeps the ballast", () => {
  const result = run(90);
  assert.equal(result.status, 0);
  assert.equal(existsSync(cache), false);
  assert.ok(existsSync(ballast));
});

test("when the disk is nearly full it also releases the ballast", () => {
  const result = run(97);
  assert.equal(result.status, 0);
  assert.equal(existsSync(cache), false);
  assert.equal(existsSync(ballast), false);
});

test("it needs no SlipJay, Node or jj and never blocks a start", () => {
  // An empty PATH apart from the shell's own basics: the script may call only POSIX tools.
  const result = run(97, { PATH: "/usr/bin:/bin" });
  assert.equal(result.status, 0);
  const unreadable = run(0, { SLIPJAY_RESCUE_USAGE_PERCENT: "not-a-number" });
  assert.equal(unreadable.status, 0);
});

test("it measures the filesystem holding the home it manages, not the sealed system volume", () => {
  // A `df` that records which path it was asked about and answers as macOS's Data volume does.
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "df"), [
    "#!/bin/sh",
    "for last; do :; done",
    `printf '%s\\n' "$last" > ${JSON.stringify(join(home, "df-asked-about"))}`,
    "printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/disk3s1 482443008 431584716 20462480 96% /System/Volumes/Data\\n'",
  ].join("\n"), { mode: 0o755 });
  const result = spawnSync("sh", [rescue], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, SLIPJAY_RESCUE_REGENERABLE: cache, SLIPJAY_RESCUE_BALLAST: ballast },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(home, "df-asked-about"), "utf8").trim(), home, "never /");
  assert.equal(existsSync(cache), false, "96% sheds");
  assert.equal(existsSync(ballast), false, "96% also releases the ballast");
});

test("settings can come from ~/.slipjay/disk-rescue.env", () => {
  mkdirSync(join(home, ".slipjay"));
  writeFileSync(join(home, ".slipjay", "disk-rescue.env"), "SLIPJAY_RESCUE_SHED_PERCENT=50\n");
  const result = run(60, {});
  assert.equal(result.status, 0);
  assert.equal(existsSync(cache), false);
});

test("an empty configured list removes nothing, and glob characters are not expanded", () => {
  const result = run(90, { SLIPJAY_RESCUE_REGENERABLE: "" });
  assert.equal(result.status, 0);
  assert.ok(existsSync(cache), "an empty list is not the default list");
  const literal = join(home, "star*");
  mkdirSync(literal);
  const sibling = join(home, "starfish");
  mkdirSync(sibling);
  run(90, { SLIPJAY_RESCUE_REGENERABLE: literal });
  assert.equal(existsSync(literal), false);
  assert.ok(existsSync(sibling), "the glob did not expand to its neighbours");
});

test("the runner unit retries for ever and runs the rescue before each start", () => {
  const setup = readFileSync(join(repoRoot, "scripts", "setup-runner.sh"), "utf8");
  assert.match(setup, /^StartLimitIntervalSec=0$/m);
  assert.match(setup, /^ExecStartPre=-\$HOME\/\.local\/bin\/slipjay-disk-rescue$/m);
});

test("the pressure timer's unit can find the interpreter slipjay needs", () => {
  // A stand-in `slipjay` that, like the real one, needs `bun` on PATH, and no-op systemd tools.
  const bin = join(home, "bin");
  mkdirSync(bin);
  for (const tool of ["systemctl", "loginctl"]) writeFileSync(join(bin, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "slipjay"), "#!/bin/sh\n", { mode: 0o755 });
  const installed = spawnSync("bash", [join(repoRoot, "scripts", "install-disk-guard.sh")], {
    encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
  });
  assert.equal(installed.status, 0, installed.stderr);
  const unit = readFileSync(join(home, ".config/systemd/user/slipjay-disk.service"), "utf8");
  // The unit's PATH is the installing shell's, so it includes the directory slipjay (and so bun) was found in.
  assert.match(unit, new RegExp(`^Environment=PATH=.*${bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
  assert.ok(existsSync(join(home, ".local/bin/slipjay-disk-rescue")));
});
