import { jj, project } from "../../support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readySpares, refillPool, spareAllowance } from "../../../src/lib/workspace/workspace-pool.ts";
import { machineConfigPath } from "../../../src/lib/workspace/workspace-paths.ts";

export const BUN_VERSION = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();

export async function write(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** Commit the primary checkout's changes and advance the integration branch to them. */
export function advance(repo: string, message: string) {
  jj(repo, ["commit", "-m", message]);
  jj(repo, ["bookmark", "set", "main", "-r", "@-"]);
}

/**
 * A Bun workspace project whose root `postinstall` runs a tracked script that
 * imports a sibling: each install appends a line to `installs.log`. `FIXTURE_INSTALL_HOLD` names a file
 * each install waits for, so a test can keep an install running until it creates it.
 */
export async function bunProject(policy?: Record<string, unknown>) {
  const f = await project({ ignore: "node_modules\n", policy });
  const installs = join(f.root, "installs.log");
  process.env.FIXTURE_INSTALL_LOG = installs;
  await write(f.repo, {
    "package.json": JSON.stringify({
      name: "fixture", private: true, packageManager: `bun@${BUN_VERSION}`, workspaces: ["packages/*"],
      scripts: { postinstall: "node scripts/count-install.mjs" },
    }, null, 2),
    "packages/x/package.json": JSON.stringify({ name: "x", version: "1.0.0" }),
    "scripts/count-install.mjs": 'import { record } from "./install-log.mjs";\nrecord();\n',
    "scripts/install-log.mjs": [
      'import { appendFileSync, existsSync } from "node:fs";',
      "export function record() {",
      "  const delay = Number(process.env.FIXTURE_INSTALL_DELAY_MS) || 0;",
      "  const hold = process.env.FIXTURE_INSTALL_HOLD;",
      "  const start = Date.now();",
      '  if (process.env.FIXTURE_INSTALL_STARTED) appendFileSync(process.env.FIXTURE_INSTALL_STARTED, process.cwd() + "\\n");',
      "  if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);",
      "  while (hold && !existsSync(hold)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);",
      '  appendFileSync(process.env.FIXTURE_INSTALL_LOG, process.cwd() + "\\n");',
      '  if (process.env.FIXTURE_INSTALL_SPANS) appendFileSync(process.env.FIXTURE_INSTALL_SPANS, JSON.stringify([start, Date.now()]) + "\\n");',
      "}",
      "",
    ].join("\n"),
    "scripts/unrelated.mjs": "export const unrelated = 1;\n",
  });
  execFileSync("bun", ["install"], { cwd: f.repo, stdio: "pipe" });
  advance(f.repo, "Add dependencies");
  await rm(installs, { force: true });
  const count = async () => (await readFile(installs, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  return { ...f, count };
}

export async function spareName(repo: string) {
  const [spare] = await readySpares(repo);
  assert.ok(spare, "a prepared spare exists");
  return spare.name;
}

/** Set this machine's spare limits (~/.slipjay/config.json) for the duration of `body`. */
export async function withMachineSpares<T>(spares: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  await mkdir(dirname(machineConfigPath()), { recursive: true });
  await writeFile(machineConfigPath(), JSON.stringify({ spares }));
  try { return await body(); } finally { await rm(machineConfigPath(), { force: true }); }
}

/** An allowance without its source, for tests about counts. */
export const counts = ({ source: _source, ...allowance }: Awaited<ReturnType<typeof spareAllowance>>) => allowance;

export const refill = async (repo: string) => {
  const outcomes: object[] = [];
  await refillPool(repo, (outcome) => outcomes.push(outcome));
  return outcomes;
};
