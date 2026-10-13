import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { migrationCommandFailure } from "./migration-command-evidence.ts";
import { installInputFingerprint } from "./install-inputs.ts";
import { runWorkspaceCommand as run } from "./workspace-command.ts";

/** Package-manager installation is the standalone Pi readiness authority. It is
 *  intentionally workspace-local and lockfile-frozen: package managers may reuse
 *  their immutable caches, but JJ workspaces never share mutable node_modules. */
async function workspaceDependencyCommand(workspacePath: string): Promise<{ command: string; args: string[] } | null> {
  const raw = await readFile(join(workspacePath, "package.json"), "utf8").catch(() => null);
  if (!raw) return null;
  const packageManager: unknown = JSON.parse(raw).packageManager;
  if (typeof packageManager !== "string") {
    throw new Error(`Workspace dependency provisioning requires a declared packageManager in ${workspacePath}.`);
  }
  if (packageManager === "bun" || packageManager.startsWith("bun@")) {
    return {
      command: "bun",
      args: ["install", "--frozen-lockfile", "--prefer-offline", "--backend=clonefile"],
    };
  }
  if (packageManager === "pnpm" || packageManager.startsWith("pnpm@")) {
    return {
      command: "pnpm",
      args: ["install", "--frozen-lockfile", "--prefer-offline", "--package-import-method=clone"],
    };
  }
  if (packageManager === "npm" || packageManager.startsWith("npm@")) {
    return { command: "npm", args: ["ci", "--prefer-offline"] };
  }
  throw new Error(`Workspace dependency provisioning does not support package manager '${packageManager}'.`);
}

/**
 * Copy every `node_modules` tree of `source` into the same places in `workspacePath` with
 * copy-on-write file clones (APFS `clonefile`; reflinks on Linux), so the copy costs no
 * disk and little time. Bun's isolated and hoisted layouts link with relative symlinks,
 * which `cp -P` keeps verbatim, so a copied tree resolves inside its new checkout. Returns the
 * trees created, or null (having removed any partial copy) when cloning is unavailable or fails.
 */
async function cloneNodeModules(source: string, workspacePath: string): Promise<string[] | null> {
  const clone = process.platform === "darwin" ? ["cp", "-cRP"] : process.platform === "linux" ? ["cp", "-RP", "--reflink=auto"] : null;
  if (!clone) return null;
  const listed = await run("jj", ["--color=never", "--ignore-working-copy", "file", "list", 'root-glob:"**/package.json"'], { cwd: workspacePath });
  if (listed.code !== 0) return null;
  const created: string[] = [];
  for (const manifest of listed.stdout.split("\n").filter(Boolean)) {
    const from = join(source, dirname(manifest), "node_modules");
    const to = join(workspacePath, dirname(manifest), "node_modules");
    if (!existsSync(from) || existsSync(to)) continue;
    const copied = await run(clone[0]!, [...clone.slice(1), from, to], { cwd: workspacePath, timeoutMs: 10 * 60_000 });
    created.push(to);
    if (copied.code !== 0) {
      await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
      return null;
    }
  }
  return created.length ? created : null;
}

/**
 * Install the workspace's dependencies. With `recordInputs`, the result also
 * carries the install-input fingerprint (see install-inputs.ts) of the tree it
 * installed, or null when that tree is unknown or the install changed it.
 *
 * With `seedFrom`, a workspace with no `node_modules` first clones them from a
 * checkout that `seedFrom(inputs)` proves has the same install inputs (an
 * array of roots, tried in order), so the install below only has to verify and
 * repair instead of fetching and linking everything. The install always runs:
 * it is the verification, and if it fails on a seeded tree the clone is discarded
 * and the install repeated from scratch.
 */
export async function prepareWorkspaceDependencies(workspacePath: string, options: {
  quiet?: boolean; recordInputs?: boolean; env?: NodeJS.ProcessEnv;
  /** Roots whose `node_modules` may seed this install, given the workspace's install-input fingerprint. */
  seedFrom?: (installInputs: string) => Promise<string[]> | string[];
} = {}): Promise<{
  state: "ready" | "not_required"; packageManager: string | null; installInputs: string | null; seeded?: true;
}> {
  const inputs = options.recordInputs || options.seedFrom ? await installInputFingerprint(workspacePath) : null;
  const dependencyCommand = await workspaceDependencyCommand(workspacePath);
  if (!dependencyCommand) return { state: "not_required", packageManager: null, installInputs: options.recordInputs ? inputs : null };
  if (!options.quiet) console.log(`[deps] ${dependencyCommand.command} install in ${basename(workspacePath)}...`);
  let seeded: string[] | null = null;
  if (inputs && options.seedFrom && !existsSync(join(workspacePath, "node_modules"))) {
    for (const source of await Promise.resolve(options.seedFrom(inputs)).catch(() => [])) {
      seeded = await cloneNodeModules(source, workspacePath).catch(() => null);
      if (seeded) { console.error(`[deps] ${basename(workspacePath)}: seeded node_modules from ${source}`); break; }
    }
  }
  // Installation is not a landing command: it keeps the user's environment and a longer deadline.
  const install = () => run(dependencyCommand.command, dependencyCommand.args,
    { cwd: workspacePath, inherit: !options.quiet, env: options.env ?? process.env, timeoutMs: 30 * 60_000 });
  let result = await install();
  if (result.code !== 0 && seeded) {
    await Promise.all(seeded.map((path) => rm(path, { recursive: true, force: true })));
    result = await install();
  }
  if (result.code !== 0) {
    throw migrationCommandFailure([dependencyCommand.command, ...dependencyCommand.args].join(" "), result, workspacePath, options.env ?? process.env, "Dependency");
  }
  const installed = options.recordInputs && inputs && await installInputFingerprint(workspacePath);
  return { state: "ready", packageManager: dependencyCommand.command, installInputs: installed && installed === inputs ? inputs : null, ...(seeded ? { seeded: true } : {}) };
}
