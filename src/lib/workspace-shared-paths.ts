import { lstat, mkdir, readdir, readlink, rmdir, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readExecutionPolicy } from "./execution-policy.ts";
import { run } from "./workspace-jj.ts";

/**
 * `sharedPaths`: each declared directory of a workspace is a symlink to the same
 * path in the primary (integration) checkout, so git-ignored output that cannot
 * be regenerated (a build's `artifacts/`) survives the workspace and never makes
 * cleanup keep it. Idempotent; an existing real directory with content is never
 * replaced.
 */

const warn = (message: string) => console.error(`[shared-paths] ${message}`);

/** Link the declared shared paths into `workspaceRoot`; returns what each did. Never throws. */
export async function linkSharedPaths(integrationRoot: string, workspaceRoot: string): Promise<Array<{ path: string; status: "linked" | "kept" | "failed" }>> {
  const results: Array<{ path: string; status: "linked" | "kept" | "failed" }> = [];
  if (resolve(integrationRoot) === resolve(workspaceRoot)) return results;
  let paths: string[];
  try { paths = (await readExecutionPolicy(integrationRoot))?.sharedPaths ?? []; } catch (error) {
    warn(`not linked: ${error instanceof Error ? error.message : String(error)}`);
    return results;
  }
  for (const path of paths) {
    try { results.push({ path, ...await linkOne(integrationRoot, workspaceRoot, path) }); } catch (error) {
      warn(`${path} not linked: ${error instanceof Error ? error.message : String(error)}`);
      results.push({ path, status: "failed" });
    }
  }
  return results;
}

async function linkOne(integrationRoot: string, workspaceRoot: string, path: string): Promise<{ status: "linked" | "kept" }> {
  const target = join(integrationRoot, path);
  const link = join(workspaceRoot, path);
  await mkdir(target, { recursive: true });
  const existing = await lstat(link).catch(() => null);
  if (existing?.isSymbolicLink()) {
    if (resolve(dirname(link), await readlink(link)) === resolve(target)) return { status: "linked" };
    warn(`${path} is a link to somewhere else; left alone`);
    return { status: "kept" };
  }
  if (existing?.isDirectory() && (await readdir(link)).length === 0) await rmdir(link);
  else if (existing) {
    warn(`${path} already exists in ${workspaceRoot} with content; left alone, not linked`);
    return { status: "kept" };
  }
  await mkdir(dirname(link), { recursive: true });
  await symlink(target, link, "dir");
  // jj would snapshot an unignored link as source and land it.
  const ignored = await run("git", ["check-ignore", "-q", "--", `${path}/`], { cwd: integrationRoot, timeoutMs: 10_000 }).catch(() => null);
  if (ignored?.code === 1) warn(`${path} is not git-ignored: add it to .gitignore, or jj will track the link as source`);
  return { status: "linked" };
}
