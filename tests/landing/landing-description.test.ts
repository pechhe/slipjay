import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { landThroughTestRunner } from "../support/test-runner.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { landingIO } from "../../src/lib/landing/landing-steps.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { jj, project } from "../support/workspace-project.ts";
import { buildServer, item, SESSION } from "../build/fixtures/build-tracker-fixture.ts";

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

test("Build workspace descriptions keep body, Co-Authored-By, existing trailers, and replace only placeholder subjects", async () => {
  const f = await project({ policy: { tracker: "build" } });
  try {
    const appended = await buildWorkspace(f, 4431, BODY);
    await ensure(appended.workspacePath);
    assert.equal(full(appended.workspacePath), `${BODY}\nBuild: #4431`);

    const reviewed = await buildWorkspace(f, 4430, "Reviewed description");
    assert.ok(full(reviewed.workspacePath).endsWith("Build: #4430"), full(reviewed.workspacePath));
    const reviewedBefore = jj(reviewed.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    assert.equal((await ensure(reviewed.workspacePath)).commitId, reviewedBefore);

    const existing = await buildWorkspace(f, 4432, `${BODY}\nBuild: #4432`);
    const existingBefore = jj(existing.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    assert.equal((await ensure(existing.workspacePath)).commitId, existingBefore);
    assert.equal(jj(existing.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]), existingBefore);

    const placeholderWs = await createWorkspace("desc-4433", f.repo, { issueNumber: 4433 });
    const placeholder = full(placeholderWs.workspacePath).trim().split("\n")[0]!;
    assert.match(placeholder, /^wip: /);
    const body = "First paragraph of the body.\n\nCo-Authored-By: Pair <pair@example.com>";
    await writeFile(join(placeholderWs.workspacePath, "file.txt"), "x\n");
    jj(placeholderWs.workspacePath, ["describe", "-m", `${placeholder}\n\n${body}`]);
    await ensure(placeholderWs.workspacePath);
    const [subject = "", ...rest] = full(placeholderWs.workspacePath).split("\n");
    assert.notEqual(subject, placeholder);
    assert.ok(subject.trim());
    assert.equal(rest.join("\n"), `\n${body}\nBuild: #4433`);

    const editorWs = await createWorkspace("editor-deleted-trailer", f.repo, { issueNumber: 4436 });
    const editor = join(f.root, "delete-trailer.cjs");
    await writeFile(editor, 'require("node:fs").writeFileSync(process.argv[2], "Editor deleted the trailer\\n");');
    await writeFile(join(editorWs.workspacePath, "file.txt"), "work\n");
    jj(editorWs.workspacePath, ["--config", `ui.editor=${JSON.stringify(["bun", editor])}`, "describe"]);
    assert.equal(full(editorWs.workspacePath), "Editor deleted the trailer");
    const preview = await landingIO.landingPreview(editorWs.workspacePath);
    const lines: string[] = [];
    const target = await landingIO.ensureLandingDescription(editorWs.workspacePath, preview.context, preview.target, undefined, (line) => lines.push(line));
    assert.notEqual(target.commitId, preview.target.commitId);
    assert.equal(full(editorWs.workspacePath), "Editor deleted the trailer\n\nBuild: #4436");
    assert.ok(lines.some((line) => line.includes(preview.target.commitId) && line.includes(target.commitId)), lines.join("\n"));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("Forge workspace descriptions keep reviewed commits, recover trailer-only descriptions, and add missing trailers", async () => {
  const f = await project({ policy: { tracker: "forge" } });
  try {
    const reviewed = await buildWorkspace(f, 4434, "Reviewed description");
    assert.ok(full(reviewed.workspacePath).endsWith("Forge: #4434"), full(reviewed.workspacePath));
    const before = jj(reviewed.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    assert.equal((await ensure(reviewed.workspacePath)).commitId, before);

    const trailerOnly = await createWorkspace("Explain the actual work", f.repo, { issueNumber: 4438 });
    await writeFile(join(trailerOnly.workspacePath, "file.txt"), "work\n");
    jj(trailerOnly.workspacePath, ["--config", 'templates.commit_trailers=\'""\'', "describe", "-m", "Forge: #4438"]);
    assert.equal(full(trailerOnly.workspacePath), "Forge: #4438");
    await ensure(trailerOnly.workspacePath);
    assert.equal(full(trailerOnly.workspacePath), "Explain the actual work\n\nForge: #4438");

    const missingConfig = await createWorkspace("old-jj-trailer", f.repo, { issueNumber: 4437 });
    jj(missingConfig.workspacePath, ["config", "unset", "--workspace", "templates.commit_trailers"]);
    await writeFile(join(missingConfig.workspacePath, "file.txt"), "work\n");
    jj(missingConfig.workspacePath, ["describe", "-m", "Old jj"]);
    await ensure(missingConfig.workspacePath);
    assert.equal(full(missingConfig.workspacePath), "Old jj\n\nForge: #4437");
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a GitHub item workspace has no workspace trailer and describe leaves the message unchanged", async () => {
  const f = await project();
  try {
    const workspace = await buildWorkspace(f, 4435, "x");
    assert.equal(jj(workspace.workspacePath, ["config", "list", "--workspace", "templates.commit_trailers", "-T", "name"]), "");
    assert.equal(full(workspace.workspacePath), "x");
  } finally { await f.dispose(); }
}, 120_000);

test("the runner receives the exact reviewed Forge source and publishes its description unchanged", async () => {
  const f = await project({ policy: { tracker: "forge" } });
  const spec = item({ number: 4439, kind: "spec", status: "in_progress", title: "The Spec", bodyRevision: 1 });
  const fake = await buildServer("build-secret", [spec], { [spec.id]: [{ generation: 1, endedAt: null }] });
  try {
    const workspace = await buildWorkspace(f, 4439, "Reviewed and ready");
    const reviewed = jj(workspace.workspacePath, ["log", "-r", "@", "--no-graph", "-T", "commit_id"]);
    const reviewedDescription = full(workspace.workspacePath);
    assert.equal(reviewedDescription, "Reviewed and ready\n\nForge: #4439");
    const result = await landThroughTestRunner(f, workspace.workspacePath, { build: { origin: fake.origin, token: "build-secret" }, session: SESSION });
    assert.equal(result.ok, true, result.lines.join("\n"));
    assert.equal(result.operation.commitId, reviewed);
    const publishedDescription = execFileSync("git", ["--git-dir", f.remote, "show", "-s", "--format=%B", "main"], { encoding: "utf8" }).trim();
    assert.equal(publishedDescription, reviewedDescription);
    assert.equal(result.lines.some((line) => line.startsWith("[description]")), false);
  } finally { await fake.close(); await f.dispose(); }
}, 120_000);
