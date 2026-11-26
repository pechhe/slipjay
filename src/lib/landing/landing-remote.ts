import type { RevisionFacts, WorkspaceContext } from "../infra/workspace-jj.ts";
import { jj, jjGitExecutable, revisionExists, revisionFacts, run, workspaceContext } from "../infra/workspace-jj.ts";
import { remotePushRetryDelaysMs, retryRemoteFetch } from "../infra/remote-push.ts";

/**
 * Lightweight landing remote, preview and conflict queries shared by workspace,
 * policy, repair and runner-client code without importing candidate preparation
 * or post-integration finalization.
 */

export async function landingPreview(cwd: string = process.cwd(), options: { allowDefaultWorkspace?: boolean } = {}): Promise<{ context: WorkspaceContext; targetRevision: string; target: RevisionFacts; stat: string }> {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Not inside a Jujutsu repository");
  if (context.current.name === "default" && !options.allowDefaultWorkspace)
    throw new Error("Landing requires an isolated jj workspace");
  const current = await revisionFacts(cwd, "@");
  const targetRevision = current.empty ? "@-" : "@";
  const target = await revisionFacts(cwd, targetRevision);
  if (target.conflict) throw new Error("The landing artifact has conflicts");
  await assertSingleVisibleCopy(cwd, target);
  const stat = await jj(cwd, ["diff", "--from", context.integrationBranch, "--to", targetRevision, "--stat"]);
  return { context, targetRevision, target, stat };
}

/**
 * Refuses a target whose change has more than one visible commit, before landing describes, rebases or queues it.
 * jj cannot resolve a divergent change id, so a later step would otherwise fail with jj's bare "is divergent".
 * The refusal names each copy, the workspaces and bookmarks that keep it visible, and how to retire the others.
 */
export async function assertSingleVisibleCopy(cwd: string, target: RevisionFacts): Promise<void> {
  const names = async (revset: string, template: string) =>
    (await jj(cwd, ["--ignore-working-copy", "log", "-r", revset, "--no-graph", "-T", `${template} ++ " "`])).split(/\s+/).filter(Boolean);
  const copies = await names(`change_id(${target.changeId})`, "commit_id");
  if (copies.length < 2) return;
  const lines = await Promise.all(copies.map(async (commitId) => {
    const workspaces = [...new Set(await names(`${commitId}:: & working_copies()`, 'working_copies.map(|w| w.name()).join(" ")'))].sort();
    const bookmarks = [...new Set(await names(`${commitId}:: & bookmarks()`, 'local_bookmarks.map(|b| b.name()).join(" ")'))].sort();
    const held = [...workspaces.map((name) => `workspace ${name}`), ...bookmarks.map((name) => `bookmark ${name}`)];
    const which = commitId === target.commitId ? " (this workspace's candidate)" : "";
    return `  ${commitId}${which}: kept visible by ${held.length ? held.join(", ") : "no workspace or bookmark (an earlier operation)"}`;
  }));
  const others = copies.filter((commitId) => commitId !== target.commitId);
  throw new Error([
    `Change ${target.changeId} is divergent: ${copies.length} visible commits share it, and landing needs exactly one.`,
    ...lines,
    `Keep ${target.commitId.slice(0, 12)} and retire the other copy: \`jj abandon ${others.join(" ")}\` if it is stale, or \`jj metaedit --update-change-id -r ${others.join(" -r ")}\` to keep it as a separate change. Then land again.`,
  ].join("\n"));
}

/** The paths `revision` leaves conflicted, as `jj resolve --list` names them; none when it has no conflict. */
export async function conflictedPaths(cwd: string, revision: string): Promise<string[]> {
  return (await jj(cwd, ["resolve", "--list", "-r", revision]).catch(() => "")).split("\n").filter(Boolean).map((line) => line.split(/\s+/)[0]!);
}

/** The remote this landing publishes to, or null when the repository declares none. */
export function publicationRemote(context: { configuration: { remote?: string | null } }): string | null {
  return context.configuration.remote ?? null;
}

export const fetchIntegration = (cwd: string, remote: string, branch: string, { ignoreWorkingCopy = false, ...options }: { timeoutMs?: number; ignoreWorkingCopy?: boolean } = {}): ReturnType<typeof import("../infra/workspace-command.ts").runWorkspaceCommand> =>
  retryRemoteFetch(() => run("jj", ["--color=never", ...(ignoreWorkingCopy ? ["--ignore-working-copy"] : []), "git", "fetch", "--remote", remote, "--branch", branch], { ...options, cwd }), remotePushRetryDelaysMs);

/** A checkout's own Git repository never moves, so it is read once per checkout (about 0.4 s a read, SJ-223). */
const gitRoots = new Map<string, Promise<string>>();
const gitRoot = (cwd: string): Promise<string> => {
  let root = gitRoots.get(cwd);
  if (!root) {
    gitRoots.set(cwd, root = jj(cwd, ["--ignore-working-copy", "git", "root"]));
    root.catch(() => gitRoots.delete(cwd));
  }
  return root;
};

/**
 * Fetch `branch` only when the remote's tip differs from the one `cwd` tracks, and say whether it fetched. `git ls-remote`
 * reads the remote as freshly as a fetch would, without jj importing every ref and recording an operation (SJ-200).
 */
export async function fetchIntegrationIfMoved(cwd: string, remote: string, branch: string, git?: string): Promise<boolean> {
  // jj's own Git repository and Git: a checkout need not be colocated, and jj may run Git through a wrapper.
  const gitDirectory = await gitRoot(cwd);
  const executable = git ?? await jjGitExecutable(cwd);
  const listed = await retryRemoteFetch(() => run(executable, ["--git-dir", gitDirectory, "ls-remote", remote, `refs/heads/${branch}`], { cwd }), remotePushRetryDelaysMs);
  const remoteTip = listed.code === 0 ? listed.stdout.trim().split(/\s+/)[0] : undefined;
  const tracked = remoteTip ? await revisionFacts(cwd, `${branch}@${remote}`, { ignoreWorkingCopy: true }).then((facts) => facts.commitId, () => undefined) : undefined;
  if (remoteTip && remoteTip === tracked) return false;
  const fetched = await fetchIntegration(cwd, remote, branch);
  if (fetched.code !== 0) throw new Error(`jj git fetch failed: ${(fetched.stderr || fetched.stdout).trim()}`);
  return true;
}

/** True when the landed artifact is on the declared remote, or when no publication applies. */
export async function artifactPublished(cwd: string, context: { integrationBranch: string; configuration: { remote?: string | null } }, state: { artifactCommitId: string }, { fetch = true }: { fetch?: boolean } = {}): Promise<boolean> {
  const remote = publicationRemote(context);
  if (!remote) return true;
  // Without the fetch, the answer is as of the last fetch: published then is published now.
  if (fetch) await fetchIntegration(cwd, remote, context.integrationBranch);
  return revisionExists(cwd, `${state.artifactCommitId} & ::${context.integrationBranch}@${remote}`);
}
