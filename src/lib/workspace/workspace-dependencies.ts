import { existsSync } from "node:fs";
import { lstat, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { migrationCommandFailure } from "../landing/migration-command-evidence.ts";
import { installInputFingerprint } from "./install-inputs.ts";
import { timed } from "./start-steps.ts";
import type { StartSteps } from "./start-steps.ts";
import { runWorkspaceCommand as run } from "../infra/workspace-command.ts";
import type { BoundedProcessRequest, BoundedProcessResult } from "../infra/bounded-process.ts";

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
    // pnpm 12 refuses plain `clone` where the filesystem has no reflinks (ext4 runners).
    return {
      command: "pnpm",
      args: ["install", "--frozen-lockfile", "--prefer-offline", "--package-import-method=clone-or-copy"],
    };
  }
  if (packageManager === "npm" || packageManager.startsWith("npm@")) {
    return { command: "npm", args: ["ci", "--prefer-offline"] };
  }
  throw new Error(`Workspace dependency provisioning does not support package manager '${packageManager}'.`);
}

/** The workspace's tracked `package.json` paths, relative to its root, or null when JJ cannot list them. */
export async function trackedManifests(workspacePath: string): Promise<string[] | null> {
  const listed = await run("jj", ["--color=never", "--ignore-working-copy", "file", "list", 'root-glob:"**/package.json"'], { cwd: workspacePath });
  return listed.code === 0 ? listed.stdout.split("\n").filter(Boolean) : null;
}

/**
 * Damage to Bun's global store that a frozen install can leave behind, as a repair hint, or
 * null. With `globalStore = true` every checkout's packages are symlinks into
 * `<cache>/links`, so emptying that cache (for example with `bun pm cache rm`) leaves them
 * dangling. The walk follows only what this checkout uses, from each manifest's declared
 * packages through their dependencies' links: entries Bun never prunes for packages no
 * manifest declares any more are stale, not damage. Half-linked `links/*.tmp-*` entries,
 * which a cold cache can leave, are named as a likely cause but are never damage alone,
 * since they may belong to another project or a running install.
 */
export async function bunStoreDamage(workspacePath: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const dangling: string[] = [];
  const visited = new Set<string>();
  const follow = async (link: string): Promise<void> => {
    if (!(await lstat(link).catch(() => null))?.isSymbolicLink()) return;
    const target = await realpath(link).catch(() => null);
    if (!target) { dangling.push(link); return; }
    // An isolated package sits at <entry>/node_modules/<name>; its dependencies are the other links there.
    const modules = target.slice(0, target.lastIndexOf("/node_modules/") + "/node_modules".length);
    if (!target.includes("/node_modules/") || visited.has(modules)) return;
    visited.add(modules);
    for (const name of await readdir(modules).catch(() => [])) {
      const path = join(modules, name);
      if (name.startsWith("@")) for (const scoped of await readdir(path).catch(() => [])) await follow(join(path, scoped));
      else await follow(path);
    }
  };
  for (const manifest of await trackedManifests(workspacePath) ?? []) {
    const modules = join(workspacePath, dirname(manifest), "node_modules");
    if (!existsSync(modules)) continue;
    const declared = JSON.parse(await readFile(join(workspacePath, manifest), "utf8").catch(() => "{}"));
    for (const name of Object.keys({ ...declared.dependencies, ...declared.devDependencies })) await follow(join(modules, name));
  }
  if (!dangling.length) return null;
  const links = join(env.BUN_INSTALL_CACHE_DIR ?? join(env.BUN_INSTALL ?? join(homedir(), ".bun"), "install", "cache"), "links");
  const partial = (await readdir(links).catch(() => [])).filter((entry) => entry.includes(".tmp-")).map((entry) => join(links, entry));
  const list = (paths: string[]) => paths.slice(0, 10).map((path) => `  ${path}`).join("\n") + (paths.length > 10 ? `\n  … and ${paths.length - 10} more` : "");
  const lines = ["Bun's global package store is damaged, so this checkout's dependencies do not resolve.",
    `Package links that dangle:\n${list(dangling)}`,
    `Repair: \`rm -rf node_modules\` (and each workspace package's) in ${workspacePath}, then \`bun install --frozen-lockfile\`.`];
  if (partial.length) lines.push(`Half-linked store entries, a likely cause:\n${list(partial)}`,
    "Delete them before reinstalling. If a package with platform-specific optional dependencies stays unlinked, `bun add <package>@<version>` in a scratch directory first, to fetch its binary into the cache.");
  lines.push("Upgrading SlipJay never needs `bun pm cache rm`: see its README.");
  return lines.join("\n");
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
  const manifests = await trackedManifests(workspacePath);
  if (!manifests) return null;
  const created: string[] = [];
  for (const manifest of manifests) {
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
 * Move the `node_modules` tree beside each of `manifests` (repository-relative `package.json`
 * paths) from `source` to the same place in `target`, where it has none yet. Each move is a rename,
 * instant on one volume, and like a clone keeps relative links resolving in the new checkout. A
 * tree that cannot be renamed stays where it is. Returns the manifests whose trees moved.
 */
export async function moveNodeModules(source: string, target: string, manifests: string[]): Promise<string[]> {
  const moved: string[] = [];
  for (const manifest of manifests) {
    const from = join(source, dirname(manifest), "node_modules");
    const to = join(target, dirname(manifest), "node_modules");
    if (!existsSync(from) || existsSync(to)) continue;
    if (await rename(from, to).then(() => true, () => false)) moved.push(manifest);
  }
  return moved;
}

/**
 * Install the workspace's dependencies. With `recordInputs`, the result also
 * carries the install-input fingerprint (see install-inputs.ts) of the tree it
 * installed, or null when that tree is unknown or the install changed it.
 *
 * With `seedFrom`, a workspace with no `node_modules` first clones them from a
 * checkout that `seedFrom(inputs)` proves has the same install inputs (roots, tried
 * in order and found lazily, so later candidates are only proved when earlier ones
 * fail), so the install below only has to verify and repair instead of fetching and
 * linking everything. Existing `node_modules`, however stale, are never replaced by
 * a clone: an install over them changes only what changed, while deleting and
 * cloning a whole tree costs minutes in a large repository. The install always runs: it is the
 * verification, and if it fails on a seeded tree the clone is discarded and the
 * install repeated from scratch. `installInputs` is the workspace's fingerprint when
 * the caller has already computed it for this tree.
 */
export async function prepareWorkspaceDependencies(workspacePath: string, options: {
  quiet?: boolean; recordInputs?: boolean; env?: NodeJS.ProcessEnv;
  /** Runner-owned installs share the executor's combined host budget. */
  runCommand?: (request: BoundedProcessRequest) => Promise<BoundedProcessResult>;
  /** Roots whose `node_modules` may seed this install, given the workspace's install-input fingerprint. */
  seedFrom?: (installInputs: string) => AsyncIterable<string> | Iterable<string>;
  installInputs?: string | null;
  /** A start's step timing, which records the fingerprints this takes (see start-steps.ts). */
  steps?: StartSteps;
} = {}): Promise<{
  state: "ready" | "not_required"; packageManager: string | null; installInputs: string | null; seeded?: true; cloneMs?: number;
}> {
  const inputs = options.installInputs !== undefined ? options.installInputs
    : options.recordInputs || options.seedFrom ? await timed(options.steps, "fingerprint", () => installInputFingerprint(workspacePath)) : null;
  const dependencyCommand = await workspaceDependencyCommand(workspacePath);
  if (!dependencyCommand) return { state: "not_required", packageManager: null, installInputs: options.recordInputs ? inputs : null };
  if (!options.quiet) console.log(`[deps] ${dependencyCommand.command} install in ${basename(workspacePath)}...`);
  let seeded: string[] | null = null;
  let cloneMs: number | undefined;
  if (inputs && options.seedFrom && !existsSync(join(workspacePath, "node_modules"))) {
    try {
      for await (const source of options.seedFrom(inputs)) {
        const cloneStarted = performance.now();
        seeded = await cloneNodeModules(source, workspacePath).catch(() => null);
        if (seeded) cloneMs = Math.round(performance.now() - cloneStarted);
        if (seeded) { console.error(`[deps] ${basename(workspacePath)}: seeded node_modules from ${source}`); break; }
      }
    } catch {
      // A candidate that cannot be read leaves the install to run unseeded.
    }
  }
  // Installation is not a landing command: it has a longer deadline, and outside the runner it keeps the
  // user's environment. The runner passes `runCommand`, which shares its budget and withholds its secrets.
  const install = async () => {
    if (!options.runCommand) return run(dependencyCommand.command, dependencyCommand.args,
      { cwd: workspacePath, inherit: !options.quiet, env: options.env ?? process.env, timeoutMs: 30 * 60_000 });
    const result = await options.runCommand({ executable: dependencyCommand.command, args: dependencyCommand.args,
      cwd: workspacePath, env: options.env ?? process.env, timeoutMs: 30 * 60_000, maxOutputBytes: 16 * 1024 * 1024 });
    return { ...result, code: result.error || result.timedOut ? 1 : result.exitCode ?? 1,
      stderr: result.error ? `${result.stderr}\n${result.error}` : result.stderr, truncated: Boolean(result.stdoutTruncated || result.stderrTruncated) };
  };
  let result = await install();
  if (result.code !== 0 && seeded) {
    await Promise.all(seeded.map((path) => rm(path, { recursive: true, force: true })));
    result = await install();
  }
  const damage = dependencyCommand.command === "bun" ? await bunStoreDamage(workspacePath, options.env ?? process.env) : null;
  if (result.code !== 0) {
    const failure = migrationCommandFailure([dependencyCommand.command, ...dependencyCommand.args].join(" "), result, workspacePath, options.env ?? process.env, "Dependency");
    if (damage) failure.message += `\n${damage}`;
    throw failure;
  }
  // A frozen install can report success over a store it did not repair.
  if (damage) throw new Error(damage);
  const installed = options.recordInputs && inputs && await timed(options.steps, "fingerprint", () => installInputFingerprint(workspacePath));
  return { state: "ready", packageManager: dependencyCommand.command, installInputs: installed && installed === inputs ? inputs : null, ...(seeded ? { seeded: true, cloneMs: cloneMs! } : {}) };
}
