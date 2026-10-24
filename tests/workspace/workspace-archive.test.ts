import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "vite-plus/test";
import { project } from "../support/workspace-project.ts";
import { createWorkspace } from "../../src/lib/workspace/workspace-create.ts";
import { archiveOutcomesPath, archiveRefusal, archiveRequestsHome, archiveWorkspace, latestArchiveFor, listArchives, processArchiveRequests, restoreArchive } from "../../src/lib/workspace/workspace-archive.ts";
import { mkdir as makeDir, writeFile as write } from "node:fs/promises";

async function request(entry: Record<string, unknown>) {
  await makeDir(archiveRequestsHome(), { recursive: true });
  await write(join(archiveRequestsHome(), `${entry.id as string}.json`), JSON.stringify({ requestedAt: new Date().toISOString(), ...entry }));
}
import { jj } from "../../src/lib/infra/workspace-jj.ts";

/**
 * What a person wrote has to survive the checkout: bytes, an executable bit, a
 * symlink and a file git was told to ignore. The archive is the only copy once the
 * checkout goes, so this proof is the reason it may go.
 */
async function checkoutWithMaterial(f: Awaited<ReturnType<typeof project>>, task: string) {
  const workspace = await createWorkspace(task, f.repo);
  const root = workspace.workspacePath;
  await writeFile(join(root, ".gitignore"), ".env\nbuild/\n");
  await writeFile(join(root, "notes.md"), "written by hand\n");
  await writeFile(join(root, ".env"), "TOKEN=keep-me\n");
  await writeFile(join(root, "blob.bin"), Buffer.from([0, 1, 2, 255, 254, 0, 7]));
  await writeFile(join(root, "run.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(root, "run.sh"), 0o755);
  await mkdir(join(root, "build"), { recursive: true });
  await writeFile(join(root, "build", "output.js"), "ignored build output\n");
  await writeFile(join(root, "target.txt"), "the symlink points here\n");
  await import("node:fs/promises").then(({ symlink }) => symlink("target.txt", join(root, "link.txt")));
  // jj snapshots the working copy as it goes, so the commit to expect is the one after the writes.
  const commit = (await jj(root, ["--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "commit_id"])).trim();
  return { name: workspace.current.name, root, commit };
}

test("an archive keeps commits, bytes, modes, links and ignored files, and restores them", async () => {
  const f = await project();
  const workspace = await checkoutWithMaterial(f, "archive-restores");

  assert.equal(await archiveRefusal(workspace.root, f.repo), null);
  const archived = await archiveWorkspace(workspace.root, { reason: "test" });
  assert.ok("archive" in archived, JSON.stringify(archived));
  const { archive } = archived;
  assert.ok(archive.inventory.includes(".env"), "an ignored file outside history is inventoried");
  assert.ok(!archive.inventory.some((path) => path.startsWith("build/")), "generated output is not archived");
  assert.ok(archive.payload, "the files outside history are packed");

  // The checkout goes, exactly as retirement would take it.
  await jj(f.repo, ["workspace", "forget", workspace.name]);
  await rm(workspace.root, { recursive: true, force: true });

  const restored = await restoreArchive(archive.id, { name: `${workspace.name}-restored` });
  assert.ok("workspacePath" in restored, JSON.stringify(restored));
  const root = restored.workspacePath;

  assert.equal((await readFile(join(root, "notes.md"), "utf8")), "written by hand\n");
  assert.deepEqual([...(await readFile(join(root, "blob.bin")))], [0, 1, 2, 255, 254, 0, 7]);
  assert.equal((await stat(join(root, "run.sh"))).mode & 0o777, 0o755, "the executable bit survives");
  assert.equal((await lstat(join(root, "link.txt"))).isSymbolicLink(), true, "the symlink survives as a link");
  assert.equal(await readlink(join(root, "link.txt")), "target.txt");
  assert.equal((await readFile(join(root, ".env"), "utf8")), "TOKEN=keep-me\n", "the ignored file survives");
  assert.equal(existsSync(join(root, "build", "output.js")), false, "generated output is not restored");
  assert.equal((await jj(root, ["--ignore-working-copy", "log", "-r", "@-", "--no-graph", "-T", "commit_id"])).trim(), archive.commitId, "the restored checkout sits on the archived commit");
  assert.ok((await listArchives()).some((entry) => entry.id === archive.id));
});

test("a nested repository is refused, leaving the checkout untouched", async () => {
  const f = await project();
  const workspace = await createWorkspace("archive-refuses", f.repo);
  await mkdir(join(workspace.workspacePath, "vendor", "inner", ".git"), { recursive: true });
  const refusal = await archiveRefusal(workspace.workspacePath, f.repo);
  assert.match(refusal?.refusal ?? "", /nested repository/);
  assert.equal(existsSync(join(workspace.workspacePath, "vendor", "inner", ".git")), true);
});

test("an archive over its size limit is refused, and says how big it is", async () => {
  const f = await project();
  const workspace = await createWorkspace("archive-too-big", f.repo);
  await writeFile(join(workspace.workspacePath, "big.bin"), Buffer.alloc(2 * 1024 * 1024));
  const refusal = await archiveRefusal(workspace.workspacePath, f.repo, { limitBytes: 1024 });
  assert.match(refusal?.refusal ?? "", /over the .* MB an archive keeps/);
});

test("restoring an archive that is not there refuses", async () => {
  const outcome = await restoreArchive("0000000000000000");
  assert.match(("refusal" in outcome && outcome.refusal) || "", /no archive/);
});

test("a release request archives its workspace and records the outcome", async () => {
  const f = await project();
  const workspace = await createWorkspace("release-request", f.repo);
  await writeFile(join(workspace.workspacePath, "notes.md"), "kept\n");
  await request({ id: "req-1", workspacePath: workspace.workspacePath, reason: "thread ended" });

  const outcomes = await processArchiveRequests();
  const archived = outcomes.find((entry) => entry.requestId === "req-1");

  assert.equal(archived?.outcome, "archived");
  assert.ok(archived?.archiveId, "the outcome names the archive it wrote");
  assert.equal(existsSync(workspace.workspacePath), true, "the checkout stays unless the request asks to retire it");
  const recorded = await readFile(archiveOutcomesPath(), "utf8");
  assert.match(recorded, /"req-1"/);
  assert.equal(existsSync(join(archiveRequestsHome(), "req-1.json")), false, "a honoured request is cleared");
});

test("a request asking to retire archives, then waits for an ownership claim rather than deleting", async () => {
  const f = await project();
  const workspace = await createWorkspace("release-retire", f.repo);
  await writeFile(join(workspace.workspacePath, "notes.md"), "kept\n");
  await request({ id: "req-3", workspacePath: workspace.workspacePath, retire: true, thread: "t-1", generation: 4 });

  const outcomes = await processArchiveRequests();
  const entry = outcomes.find((outcome) => outcome.requestId === "req-3");

  assert.equal(entry?.outcome, "archived");
  assert.match(entry?.reason ?? "", /ownership claim/);
  assert.equal(existsSync(workspace.workspacePath), true, "the checkout is never removed without a validated claim");
  assert.equal(existsSync(join(archiveRequestsHome(), "req-3.json")), true, "the request stays for the pass that can honour it");
});

test("a file named like an option is archived, and a payload missing an entry is refused", async () => {
  const f = await project();
  const created = await createWorkspace("option-named", f.repo);
  const workspace = { name: created.current.name, root: created.workspacePath };
  await writeFile(join(workspace.root, ".gitignore"), ".env\n--exclude=*\n");
  await writeFile(join(workspace.root, "--exclude=*"), "not an option\n");
  await writeFile(join(workspace.root, "notes.txt"), "kept\n");

  const archived = await archiveWorkspace(workspace.root, { reason: "test" });
  assert.ok("archive" in archived, JSON.stringify(archived));
  assert.ok(archived.archive.inventory.includes("--exclude=*"), "the option-shaped name is inventoried");
  assert.ok((archived.archive.payload?.bytes ?? 0) > 0);

  const restored = await restoreArchive(archived.archive.id, { name: `${workspace.name}-restored` });
  assert.ok("workspacePath" in restored, JSON.stringify(restored));
  assert.equal(await readFile(join(restored.workspacePath, "--exclude=*"), "utf8"), "not an option\n");
  assert.equal(await readFile(join(restored.workspacePath, "notes.txt"), "utf8"), "kept\n");
});

test("a request whose identity cannot be read is retried rather than dropped", async () => {
  const f = await project();
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const notAWorkspace = await mkdtemp(join(tmpdir(), "slipjay-not-a-repo-"));
  await writeFile(join(notAWorkspace, "loose.txt"), "no history here\n");
  await request({ id: "req-4", workspacePath: notAWorkspace });

  const outcomes = await processArchiveRequests();
  const entry = outcomes.find((outcome) => outcome.requestId === "req-4");
  assert.equal(entry?.outcome, "failed");
  assert.match(entry?.reason ?? "", /could not be read this pass/);
  assert.equal(existsSync(join(archiveRequestsHome(), "req-4.json")), true, "the request survives for the next pass");
});

test("a request that cannot be archived is kept for the next pass, with its attempt", async () => {
  const f = await project();
  const workspace = await createWorkspace("release-refused", f.repo);
  await mkdir(join(workspace.workspacePath, "vendor", ".git"), { recursive: true });
  await request({ id: "req-2", workspacePath: workspace.workspacePath });

  const outcomes = await processArchiveRequests();
  assert.equal(outcomes.find((entry) => entry.requestId === "req-2")?.outcome, "failed");
  const kept = JSON.parse(await readFile(join(archiveRequestsHome(), "req-2.json"), "utf8"));
  assert.equal(kept.attempts, 1);
  assert.match(kept.lastError, /nested repository/);
  assert.equal(existsSync(workspace.workspacePath), true);
});

test("an archive whose payload no longer matches is refused rather than restored incomplete", async () => {
  const f = await project();
  const workspace = await createWorkspace("tampered", f.repo);
  await writeFile(join(workspace.workspacePath, ".gitignore"), ".env\n");
  await writeFile(join(workspace.workspacePath, ".env"), "TOKEN=one\n");
  const archived = await archiveWorkspace(workspace.workspacePath, { reason: "test" });
  assert.ok("archive" in archived, JSON.stringify(archived));
  await writeFile(archived.archive.payload!.file, "not the same bytes");

  const restored = await restoreArchive(archived.archive.id);
  assert.match(("refusal" in restored && restored.refusal) || "", /no longer matches its manifest/);
});

test("restoring at a chosen name and path puts the checkout where a resume expects it", async () => {
  const f = await project();
  const workspace = await createWorkspace("restore-in-place", f.repo);
  await writeFile(join(workspace.workspacePath, "notes.md"), "in place\n");
  const archived = await archiveWorkspace(workspace.workspacePath, { reason: "test" });
  assert.ok("archive" in archived, JSON.stringify(archived));

  const target = join(tmpdir(), `slipjay-restored-${Date.now()}`);
  const restored = await restoreArchive(archived.archive.id, { name: "t3-resume-check", path: target });
  assert.ok("workspacePath" in restored, JSON.stringify(restored));
  assert.equal(restored.workspacePath, target);
  assert.equal(await readFile(join(target, "notes.md"), "utf8"), "in place\n");
  await rm(target, { recursive: true, force: true });
});

test("the newest archive of a path is the one a resume restores", async () => {
  const f = await project();
  const workspace = await createWorkspace("resume-latest", f.repo);
  await writeFile(join(workspace.workspacePath, "notes.md"), "first\n");
  const first = await archiveWorkspace(workspace.workspacePath, { reason: "first" });
  assert.ok("archive" in first);
  await writeFile(join(workspace.workspacePath, "notes.md"), "second\n");
  const second = await archiveWorkspace(workspace.workspacePath, { reason: "second" });
  assert.ok("archive" in second);

  const newest = await latestArchiveFor(workspace.workspacePath);
  assert.equal(newest?.id, second.archive.id, "the newest archive of that path wins");
  assert.equal(await latestArchiveFor("/nowhere/at/all"), null);
});

test("a group-writable ignored file keeps its mode through archive and restore", async () => {
  const f = await project();
  const workspace = await createWorkspace("mode-preserved", f.repo);
  await writeFile(join(workspace.workspacePath, ".gitignore"), ".env\n");
  await writeFile(join(workspace.workspacePath, ".env"), "TOKEN=one\n");
  await chmod(join(workspace.workspacePath, ".env"), 0o664);
  const archived = await archiveWorkspace(workspace.workspacePath, { reason: "modes" });
  assert.ok("archive" in archived, JSON.stringify(archived));

  const target = join(tmpdir(), `slipjay-modes-${Date.now()}`);
  const restored = await restoreArchive(archived.archive.id, { name: "mode-preserved-restored", path: target });
  assert.ok("workspacePath" in restored, JSON.stringify(restored));
  const mode = (await stat(join(target, ".env"))).mode & 0o777;
  assert.equal(mode, 0o664, "the restored file carries the mode it had, not the umask's");
  await rm(target, { recursive: true, force: true });
});
