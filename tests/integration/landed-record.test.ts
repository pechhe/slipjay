import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { readLandedRecord } from "../../src/lib/slipjay.ts";
import { landedHome, stateHome } from "../../src/lib/workspace/workspace-paths.ts";

const cli = fileURLToPath(new URL("../../src/launcher/workspace.ts", import.meta.url));

const record = (workspaceName: string, workspacePath: string, artifactCommitId: string, extra: Record<string, unknown> = {}) => ({
  version: 1, phase: "landed", workspaceName, workspacePath, integrationRoot: "/repo", integrationBranch: "main",
  artifactCommitId, artifactChangeId: "change", ...extra,
});

async function write(directory: string, file: string, value: unknown) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, file), JSON.stringify(value));
}

test("finds a removed workspace's landing in the archive by its exact path", async () => {
  const path = "/workspaces/sl-spare-aaa111";
  await write(landedHome(), "artifact-1.json", record("sl-72", path, "a".repeat(40), {
    operationId: "op_old", issueNumber: 72, landedAt: "2026-10-15T10:00:00.000Z",
  }));
  await write(landedHome(), "artifact-2.json", record("sl-72", path, "b".repeat(40), {
    operationId: "op_new", issueNumber: 72, landedAt: "2026-10-15T11:00:00.000Z",
  }));
  // The same workspace name, reused at another path, is another workspace.
  await write(landedHome(), "artifact-3.json", record("sl-72", "/workspaces/sl-spare-bbb222", "c".repeat(40), {
    landedAt: "2026-10-15T12:00:00.000Z",
  }));

  assert.deepEqual(await readLandedRecord(path), {
    workspaceName: "sl-72", workspacePath: path, artifactCommitId: "b".repeat(40),
    operationId: "op_new", issueNumber: 72, landedAt: "2026-10-15T11:00:00.000Z",
  });
});

test("reads a live workspace's sidecar, and skips a landing that never finished", async () => {
  await write(stateHome(), "sl-80.json", record("sl-80", "/workspaces/sl-80", "d".repeat(40), { landedAt: "2026-10-15T09:00:00.000Z" }));
  await write(stateHome(), "sl-81.json", record("sl-81", "/workspaces/sl-81", "e".repeat(40), { phase: "prepared" }));

  assert.equal((await readLandedRecord("/workspaces/sl-80"))?.artifactCommitId, "d".repeat(40));
  assert.equal(await readLandedRecord("/workspaces/sl-81"), null);
  assert.equal(await readLandedRecord("/workspaces/never-landed"), null);
});

test("landed prints one JSON line, null when nothing is recorded, and refuses bad arguments", async () => {
  const run = (args: string[]) => new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile("bun", [cli, ...args], { env: process.env, timeout: 60_000 }, (error, stdout) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout }));
  });
  await write(stateHome(), "sl-90.json", record("sl-90", "/workspaces/sl-90", "f".repeat(40)));

  const found = await run(["landed", "/workspaces/sl-90"]);
  assert.equal(found.code, 0);
  assert.deepEqual(JSON.parse(found.stdout), { workspaceName: "sl-90", workspacePath: "/workspaces/sl-90", artifactCommitId: "f".repeat(40) });
  assert.deepEqual(await run(["landed", "/workspaces/missing"]), { code: 0, stdout: "null\n" });
  assert.notEqual((await run(["landed"])).code, 0);
  assert.notEqual((await run(["landed", "--json"])).code, 0);
});
