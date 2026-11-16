import { withIssueTrailer } from "../build/issue-references.ts";
import { trackerIsBuild, trackerOf } from "../build/tracker.ts";
import { jj, type WorkspaceContext } from "../infra/workspace-jj.ts";

const KEY = "templates.commit_trailers";
// The no-op label lets repeated attachment reuse the original template without nesting wrappers.
const MANAGED = /^label\("slipjay-item", separate\("\\n", stringify\(\(([\s\S]*)\)\)\.trim_end\(\), "(?:[^"\\]|\\.)*"\)\)$/;

/** Best effort: old jj or unwritable config keeps the landing-time trailer fallback. */
export async function setWorkspaceIssueTrailer(context: WorkspaceContext, issueNumber: number): Promise<void> {
  const tracker = trackerOf(context.configuration);
  if (!trackerIsBuild(tracker)) return;
  const cwd = context.current.root;
  try {
    const effective = await jj(cwd, ["config", "get", KEY]);
    const base = MANAGED.exec(effective)?.[1] ?? (effective || '""');
    const trailer = withIssueTrailer("", issueNumber, null, tracker).trim();
    const composed = `label("slipjay-item", separate("\\n", stringify((${base})).trim_end(), ${JSON.stringify(trailer)}))`;
    if (composed === effective) return;
    // Config accepts arbitrary strings; validate before installing a template that describe will use.
    await jj(cwd, ["--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", composed]);
    await jj(cwd, ["config", "set", "--workspace", KEY, JSON.stringify(composed)]);
  } catch (error) {
    // Neither attachment nor allocation depends on jj's optional workspace config support.
    console.error(`[trailer] jj did not take the item trailer for this workspace, so \`land\` will add it: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  }
}
