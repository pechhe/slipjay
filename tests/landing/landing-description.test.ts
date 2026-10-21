import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { landingIO } from "../../src/lib/landing/landing-steps.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { jj, project } from "../support/workspace-project.ts";

const BODY = "Make landing keep the commit body\n\nFirst paragraph of the body.\n\nSecond paragraph, with detail.\n\nCo-Authored-By: Pair <pair@example.com>";

async function buildWorkspace(f: Awaited<ReturnType<typeof project>>, issueNumber: number, description: string) {
  const workspace = await createWorkspace(`desc-${issueNumber}`, f.repo, { issueNumber });
  await writeFile(join(workspace.workspacePath, "file.txt"), "x\n");
  jj(workspace.workspacePath, ["describe", "-m", description]);
  return workspace;
}

async function ensure(cwd: string) {
  const preview = await landingIO.landingPreview(cwd);
  return landingIO.ensureLandingDescription(cwd, preview.context, preview.target);
}

const full = (cwd: string) => jj(cwd, ["log", "-r", "@", "--no-graph", "-T", "description"]);

test("landing appends Build to the trailer block and keeps the body and Co-Authored-By", async () => {
  const f = await project({ policy: { tracker: "build" } });
  try {
    const workspace = await buildWorkspace(f, 4431, BODY);
    await ensure(workspace.workspacePath);
    assert.equal(full(workspace.workspacePath), `${BODY}\nBuild: #4431`);
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a commit already carrying its Build trailer is not re-described", async () => {
  const f = await project({ policy: { tracker: "build" } });
  try {
    const workspace = await buildWorkspace(f, 4432, `${BODY}\nBuild: #4432`);
    const before = jj(workspace.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    const target = await ensure(workspace.workspacePath);
    assert.equal(target.commitId, before);
    assert.equal(jj(workspace.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]), before);
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a body written under the generated subject is kept; only the placeholder subject is replaced", async () => {
  const f = await project({ policy: { tracker: "build" } });
  try {
    const workspace = await createWorkspace("desc-4433", f.repo, { issueNumber: 4433 });
    const placeholder = full(workspace.workspacePath).trim();
    assert.match(placeholder, /^wip: /);
    const body = "First paragraph of the body.\n\nCo-Authored-By: Pair <pair@example.com>";
    await writeFile(join(workspace.workspacePath, "file.txt"), "x\n");
    jj(workspace.workspacePath, ["describe", "-m", `${placeholder}\n\n${body}`]);
    await ensure(workspace.workspacePath);
    const [subject = "", ...rest] = full(workspace.workspacePath).split("\n");
    assert.notEqual(subject, placeholder);
    assert.ok(subject.trim());
    assert.equal(rest.join("\n"), `\n${body}\nBuild: #4433`);
  } finally {
    await f.dispose();
  }
}, 120_000);
