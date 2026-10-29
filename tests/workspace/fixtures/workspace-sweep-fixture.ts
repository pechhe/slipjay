import { landOnTestRunner, landThroughTestRunner, type TestRunner } from "../../support/test-runner.ts";
import assert from "node:assert/strict";
import { holdWorkspace } from "../../support/workspace-holder.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EMPTY_IDLE_MS } from "../../../src/lib/workspace/workspace-sweep.ts";

export const later = () => Date.now() + EMPTY_IDLE_MS + 60_000;

/** A process working inside `cwd` until disposed, as a live session would be. */
export function occupy(cwd: string) {
  const child = holdWorkspace(cwd);
  return () => child.kill();
}

export async function land(f: { root: string; repo: string; remote: string }, cwd: string, file: string, options: { keep?: boolean } = {}, runner?: TestRunner) {
  await writeFile(join(cwd, file), `${file}\n`);
  const result = runner ? await landOnTestRunner(runner, cwd, options) : await landThroughTestRunner(f, cwd, options);
  assert.equal(result.ok, true, result.lines.join("\n"));
  return result;
}
