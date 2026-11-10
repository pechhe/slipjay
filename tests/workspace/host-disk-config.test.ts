import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { readDiskConfig } from "../../src/lib/host-disk/disk-config.ts";
import { diskLevel } from "../../src/lib/host-disk/disk-plan.ts";

const GIB = 1024 ** 3;

test("an absent disk key reads as the documented defaults", () => {
  const config = readDiskConfig({});
  assert.deepEqual(config.thresholds, { warnPercent: 80, shedPercent: 88, refillPercent: 93, criticalPercent: 96, ballastRecreatePercent: 85 });
  assert.deepEqual(config.ballast, { path: join(homedir(), ".slipjay", "disk-ballast"), bytes: 8 * GIB });
  assert.equal(config.runRoot, join(homedir(), "runs"));
  assert.deepEqual(config.scratchRoots, [{ path: "/tmp", match: ["*-scratch", "ys-attack-build-*"], ttlHours: 72 }]);
  assert.deepEqual(config.regenerable, ["/tmp/node-compile-cache"]);
  assert.equal(config.issueCapBytes, 20 * GIB);
});

test("given fields override and expand ~, the rest keep their defaults", () => {
  const config = readDiskConfig({ disk: { thresholds: { shedPercent: 90 }, ballast: { path: "~/b" }, runRoot: "~/r" }, other: 1 });
  assert.equal(config.thresholds.shedPercent, 90);
  assert.equal(config.thresholds.refillPercent, 93);
  assert.deepEqual(config.ballast, { path: join(homedir(), "b"), bytes: 8 * GIB });
  assert.equal(config.runRoot, join(homedir(), "r"));
});

test("a malformed disk key fails loudly", () => {
  for (const disk of [
    "x", [], { unknown: 1 }, { thresholds: { shedPercent: "high" } }, { thresholds: { shedPercent: 120 } },
    { thresholds: { warnPercent: 95 } }, { ballast: { bytes: -1 } }, { runRoot: "relative" }, { runRoot: "/" },
    { scratchRoots: [{ path: "/tmp", match: [], ttlHours: 1 }] }, { scratchRoots: [{ path: "/tmp", match: ["a/b"], ttlHours: 1 }] },
    { scratchRoots: [{ path: "/tmp", match: ["a"] }] }, { scratchRoots: {} }, { regenerable: ["rel"] }, { issueCapBytes: 0 },
    // Nothing but the evidence rules may remove evidence: no root, cache or ballast may overlap the run root.
    { runRoot: "/data/runs", scratchRoots: [{ path: "/data", match: ["*"], ttlHours: 1 }] },
    { runRoot: "/data/runs", scratchRoots: [{ path: "/data/runs/x", match: ["*"], ttlHours: 1 }] },
    { runRoot: "/data/runs", regenerable: ["/data/runs/y"] }, { runRoot: "/data/runs", ballast: { path: "/data/runs/ballast" } },
  ]) {
    assert.throws(() => readDiskConfig({ disk }), /disk in .*config\.json/, JSON.stringify(disk));
  }
});

test("levels follow the thresholds", () => {
  const { thresholds } = readDiskConfig({});
  const levels = [50, 79, 80, 87, 88, 92, 93, 95, 96, 100].map((percent) => diskLevel(percent, thresholds));
  assert.deepEqual(levels, ["ok", "ok", "warn", "warn", "shed", "shed", "refill-stop", "refill-stop", "critical", "critical"]);
});
