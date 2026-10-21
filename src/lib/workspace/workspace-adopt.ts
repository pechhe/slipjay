import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { jj, revisionExists, revisionFacts, workspaceContext, workingCopyCommit } from "../infra/workspace-jj.ts";
import { withWorkspaceTransaction, writeWorkspaceJson } from "../infra/workspace-transaction.ts";
import { listWorkspaces, metadataPath, recordedWorkspaceBase, workspaceMetadata } from "./workspace-state.ts";
import { unsnapshottedEdits } from "./workspace-lifecycle.ts";
import { adoptions } from "./workspace-coverage.ts";
import type { Adoption } from "./workspace-coverage.ts";

/** Adopt a pinned helper contribution, retaining the original revisions as provenance. */
export async function adoptWorkspace(cwd: string, path: string): Promise<Adoption> {
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default") throw new Error("Adoption requires an isolated lead workspace");
  const root = await realpath(path);
  const helper = (await listWorkspaces(cwd, { readOnly: true })).find((entry) => entry.root === root);
  if (!helper || helper.name === context.current.name || helper.name === "default") throw new Error("Expected another workspace in this repository");
  return withWorkspaceTransaction(`writer:${context.current.name}`, () => withWorkspaceTransaction(`writer:${helper.name}`, async () => {
    const metadata = await workspaceMetadata(context.current.name);
    const helperMetadata = await workspaceMetadata(helper.name);
    if (!metadata) throw new Error("Lead workspace metadata is required for adoption");
    const base = await recordedWorkspaceBase(root, helperMetadata);
    if (typeof base !== "string" || !/^[a-f0-9]{40}$/.test(base)) throw new Error("Helper has no recorded start base; cannot safely select its contribution");
    const edited = await unsnapshottedEdits(root, context.integration.root);
    if (edited.length) throw new Error(`Helper edited since its last snapshot: ${edited.join(", ")}`);
    const before = await workingCopyCommit(cwd);
    if (!await revisionExists(cwd, `${base} & ::${before}`)) throw new Error("Helper base is not an ancestor of the lead working copy");
    const select = async () => {
      const tip = await revisionFacts(root, "@", { ignoreWorkingCopy: true });
      const end = tip.empty ? "@-" : "@";
      if (!await revisionExists(root, `${base} & ::${end}`)) throw new Error("Helper base is not an ancestor of its tip");
      if (await revisionExists(root, `(${base}..${end}) & merges()`)) throw new Error("Cannot adopt a range containing a merge commit");
      return (await jj(root, ["--ignore-working-copy", "log", "-r", `(${base}..${end}) & ~empty()`, "--reversed", "--no-graph", "-T", 'commit_id ++ "\\n"'])).split("\n").filter(Boolean);
    };
    const revisions = await select();
    if (!revisions.length) throw new Error("Helper has no non-empty contribution after its base");
    const previous = adoptions(metadata?.adoptions);
    const recorded = new Set(previous.flatMap((item) => item.revisions));
    if (new Set([...recorded, ...revisions]).size > 32) throw new Error("A landing supports at most 32 adopted revisions");
    const added = revisions.filter((commit) => !recorded.has(commit));
    const marker = `slipjay-adopt-${randomUUID()}`;
    let duplicates: string[] = [];
    try {
      if (added.length) {
        // Identify only this run's duplicates, even if another workspace adds
        // descendants concurrently. Their descriptions disappear on squash.
        await jj(cwd, ["--config", `templates.duplicate_description=${JSON.stringify(JSON.stringify(marker))}`,
          "duplicate", ...added, "--onto", "@"]);
        duplicates = (await jj(cwd, ["--ignore-working-copy", "log", "-r", `description(substring:${JSON.stringify(marker)})`,
          "--no-graph", "-T", 'commit_id ++ "\\n"'])).split("\n").filter(Boolean);
        if (duplicates.length !== added.length) throw new Error("Could not identify the adopted duplicates");
        const conflicts: string[] = [];
        for (const duplicate of duplicates) {
          if ((await revisionFacts(cwd, duplicate, { ignoreWorkingCopy: true })).conflict)
            conflicts.push(await jj(cwd, ["resolve", "--list", "-r", duplicate]));
        }
        if (conflicts.length) throw new Error(`Adoption conflicts: ${conflicts.join("\n")}`);
      }
      if (JSON.stringify(await select()) !== JSON.stringify(revisions) || (await unsnapshottedEdits(root, context.integration.root)).length) throw new Error("Helper revisions changed during adoption");
      if (duplicates.length) await jj(cwd, ["squash", "--from", duplicates.join(" | "), "--into", "@", "--use-destination-message"]);
      duplicates = [];
      const adoption = { workspaceName: helper.name, base, revisions };
      const adoptedCommit = await workingCopyCommit(cwd);
      // Each run retains its own evolution anchor, so undoing a later adopt
      // does not invalidate the earlier contribution from the same helper.
      await writeWorkspaceJson(metadataPath(context.current.name), { ...metadata, adoptions: [...previous,
        ...(added.length ? [{ workspaceName: helper.name, base, revisions: added, adoptedCommit }] : []),
      ] });
      return adoption;
    } catch (error) {
      if (duplicates.length) await jj(cwd, ["abandon", ...duplicates]);
      await writeWorkspaceJson(metadataPath(context.current.name), metadata);
      throw error;
    }
  }));
}
