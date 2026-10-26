import { runWorkspaceCommand } from "../infra/workspace-command.ts";
import type { LandingIO } from "./landing-candidate.ts";

/** A semantic conflict the admission probe can report without hiding inspection failures. */
export class LandingRenameConflict extends Error {
  paths: string[];
  constructor(paths: string[], hazards: string[]) {
    super(`Landing rename conflict: integration changed a renamed path after the candidate's original base:\n${hazards.join("\n")}\nCarry those integration edits into the added paths, rebase the repaired candidate onto integration, review the result, and land again. Verification has not run`);
    this.paths = paths;
  }
}

/** Inspect the original submitted source, never the runner's already-rebased duplicate. */
export async function assertRenameSafety(cwd: string, source: string, tip: string, jj: LandingIO["jj"]): Promise<void> {
  const bases = (await jj(cwd, ["log", "-r", `heads(::${source} & ::${tip})`, "--no-graph", "-T", 'commit_id ++ "\\n"'])).trim().split(/\s+/).filter(Boolean);
  if (!bases.length) throw new Error("Cannot determine the original landing bases for rename safety; reconcile the candidate ancestry and land again");
  if (bases.includes(tip)) return;
  const root = await jj(cwd, ["git", "root"]);
  const git = async (args: string[]): Promise<string> => {
    const result = await runWorkspaceCommand("git", ["--git-dir", root, ...args], { cwd });
    if (result.code !== 0 || result.truncated)
      throw new Error(`Could not check landing rename safety: ${result.truncated ? "command output was truncated" : result.stderr || result.stdout}. Repair the check and land again`);
    return result.stdout;
  };
  const renames = new Map<string, Set<string>>();
  for (const base of bases) {
    // Explicit threshold and unlimited pairs avoid silently skipping detection due to user config.
    const entries = (await git(["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--find-renames=50%", "-l0", base, source, "--"])).split("\0");
    for (let i = 0; i < entries.length && entries[i];) {
      const status = entries[i++]!;
      const oldPath = entries[i++]!;
      if (!status.startsWith("R")) continue;
      const addedPath = entries[i++]!;
      const destinations = renames.get(oldPath) ?? new Set<string>();
      destinations.add(addedPath);
      renames.set(oldPath, destinations);
    }
  }
  if (!renames.size) return;
  // One history walk for all paths. Exclude every base's ancestry, including in criss-cross graphs.
  // Combined merge diffs omit inherited edits already present in a parent; the side commit
  // supplies their attribution when it is new. Raw -z records keep filenames literal.
  const entries = (await git(["log", "--full-history", "--diff-merges=combined", "--no-renames", "--no-ext-diff", "--no-textconv",
    "--format=%x00%H%x00%s%x00", "--raw", "--no-abbrev", "-z", tip, "--not", ...bases, "--", ...[...renames.keys()].map((path) => `:(literal)${path}`)])).split("\0");
  const changed = new Map<string, Set<string>>();
  let commit = "";
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (/^[a-f0-9]{40}$/.test(entry)) commit = `${entry} ${entries[++i] ?? ""}`;
    else if (/^\n?:/.test(entry)) {
      const path = entries[++i]!;
      if (!renames.has(path)) continue;
      const commits = changed.get(path) ?? new Set<string>();
      commits.add(commit);
      changed.set(path, commits);
    }
  }
  const hazards = [...changed].map(([path, commits]) => `${JSON.stringify(path)} -> ${[...renames.get(path)!].map((added) => JSON.stringify(added)).join(", ")}\n${[...commits].join("\n")}`);
  if (hazards.length) throw new LandingRenameConflict([...changed.keys()], hazards);
}
