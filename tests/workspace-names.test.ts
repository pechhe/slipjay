import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { parseExecutionPolicy } from "../src/lib/execution-policy.ts";
import { legacyIssueWorkspaceName, projectCode, repositoryProjectCode, taskWorkspaceName } from "../src/lib/workspace-jj.ts";

test("project codes are two letters from the folder name", () => {
  assert.equal(projectCode("peach-pi"), "pp");
  assert.equal(projectCode("YardSmith"), "ys");
  assert.equal(projectCode("slipjay"), "sl");
  assert.equal(projectCode("my_cool.app"), "mc");
});

test("Issue workspaces are named by project code and Issue number", () => {
  assert.equal(taskWorkspaceName("pp", 412, "Fix toast"), "pp-412");
  assert.equal(legacyIssueWorkspaceName("peach-pi", 412), "peach-pi-i412");
});

test("task workspaces are named by project code and a short task slug", () => {
  assert.equal(taskWorkspaceName("pp", null, "Fix toast"), "pp-fix-toast");
  assert.equal(taskWorkspaceName("ys", null, "Rework the invoice export pipeline"), "ys-rework-the-invoice");
  assert.equal(taskWorkspaceName("ys", null, "Supercalifragilisticexpialidocious"), "ys-supercalifragilisticexpi");
  assert.match(taskWorkspaceName("pp", null, "  "), /^pp-[0-9a-f]{6}$/);
  assert.match(taskWorkspaceName("pp", null), /^pp-[0-9a-f]{6}$/);
});

test("a declared projectCode names workspaces regardless of the folder", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "slipjay-code-")));
  try {
    const root = join(parent, "yardsmith");
    await mkdir(root);
    assert.equal(await repositoryProjectCode(root), "ya");
    await writeFile(join(root, "slipjay.json"), JSON.stringify({ version: 1, projectCode: "ys" }));
    assert.equal(await repositoryProjectCode(root), "ys");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("projectCode must be 2-8 lowercase letters or digits", () => {
  for (const projectCode of ["Y", "YS", "ys-", "toolongcode", 7]) {
    assert.throws(() => parseExecutionPolicy(JSON.stringify({ version: 1, projectCode })), /projectCode/);
  }
  assert.equal(parseExecutionPolicy(JSON.stringify({ version: 1, projectCode: "ys" })).projectCode, "ys");
});
