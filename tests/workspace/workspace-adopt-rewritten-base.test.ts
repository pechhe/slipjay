import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { adoptWorkspace } from "../../src/lib/workspace/workspace-adopt.ts";
import { workspaceMetadata } from "../../src/lib/workspace/workspace-state.ts";
import { jj, project } from "../support/workspace-project.ts";
import { isolateAdoptionFixtures, runCli, contribution } from "./fixtures/workspace-adopt-fixture.ts";

isolateAdoptionFixtures();

const commit = (cwd: string, revision: string) => jj(cwd, ["log", "-r", revision, "--no-graph", "-T", "commit_id"]);

test("a helper whose stacked parent was rewritten is refused naming its fixed base, and the recovery the refusal gives adopts it", async () => {
  const f = await project({ policy: { spares: 0 } });
  try {
    const { lead, helper, base } = await contribution(f);
    // The lead's unpublished parent is rewritten, as when a stacked parent lands under another commit id.
    jj(lead.workspacePath, ["describe", "-r", base, "-m", "Lead base, as published"]);
    assert.notEqual(commit(lead.workspacePath, "@-"), base);
    // Rebasing the helper onto the lead's new parent does not move its recorded base.
    jj(helper.workspacePath, ["rebase", "-r", "@", "--onto", commit(lead.workspacePath, "@-")]);
    let message = "";
    await assert.rejects(adoptWorkspace(lead.workspacePath, helper.workspacePath), (error: Error) => { message = error.message; return true; });
    assert.match(message, new RegExp(`Helper base ${base} is not an ancestor of the lead working copy`));
    assert.match(message, /rebasing the helper does not change it/);
    assert.match(message, /slipjay start --base @- --json/);
    assert.match(message, /quoting each of the paths/);
    assert.match(message, /match apart from their index lines/);
    assert.match(message, /Keep this helper until the lead's landing publishes/);

    // The recovery, step by step as the refusal gives it.
    const fresh = JSON.parse((await runCli(lead.workspacePath, "start", "--base", "@-", "--json", "fresh helper")).stdout) as { workspacePath: string };
    const helperTip = commit(helper.workspacePath, "@");
    const paths = jj(helper.workspacePath, ["diff", "--from", base, "--to", "@", "--name-only"]).split("\n").filter(Boolean);
    assert.deepEqual(paths, ["helper.txt"]);
    jj(fresh.workspacePath, ["restore", "--from", helperTip, "--into", "@", ...paths]);
    const strip = (diff: string) => diff.split("\n").filter((line) => !line.startsWith("index ")).join("\n");
    assert.equal(strip(jj(fresh.workspacePath, ["diff", "--git", "-r", "@"])), strip(jj(helper.workspacePath, ["diff", "--from", base, "--to", "@", "--git"])));
    jj(fresh.workspacePath, ["describe", "-m", "Helper contribution, moved"]);
    const adopted = await adoptWorkspace(lead.workspacePath, fresh.workspacePath);
    assert.equal(adopted.revisions.length, 1);
    assert.equal(await readFile(join(lead.workspacePath, "helper.txt"), "utf8"), "helper\n");
    // The original helper is untouched and still recorded, for its normal retirement after publication.
    assert.ok(await workspaceMetadata(helper.current.name));
  } finally { await f.dispose(); }
}, 120_000);
