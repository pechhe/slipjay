import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import { runWorkspaceCommand as run } from "./workspace-command.ts";

/**
 * The install-input fingerprint of a workspace: a digest of what a frozen
 * package-manager install reads to produce `node_modules`. Equal fingerprints
 * mean a prepared `node_modules` is still that install's exact output, so a
 * claimed spare need not reinstall.
 *
 * From the JJ tree at `@`: every lockfile, `package.json` and package-manager
 * configuration file; the root `patches/` tree and every `patchedDependencies`
 * path; every `file:` dependency target (copied, not linked); and the tracked
 * files install-time lifecycle scripts name, following nested `run` scripts and
 * the relative paths those script sources mention. A script that cannot be read
 * that way contributes its whole directory. From the host: platform, package
 * manager and Node versions, user-level package-manager configuration and the
 * environment variables that change what gets installed.
 *
 * Not covered, by design: what lifecycle scripts generate into the source tree
 * from the rest of the repository (paraglide messages, `.svelte-kit`). Such
 * output derives from more than install inputs; the repositories' own dev and
 * check commands regenerate it, and the spare produced it once at provisioning.
 */
const INPUT_NAMES = new Set([
  "package.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock",
  "bunfig.toml", ".npmrc", "pnpm-workspace.yaml", ".pnpmfile.cjs", ".yarnrc.yml",
]);
const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare", "pnpm:devPreinstall"];
const SCRIPT_SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const OPAQUE_SCRIPT = /\.(?:sh|bash|zsh|py|rb|pl)$/;
const RELATIVE_LITERAL = /["'`](\.{1,2}\/[^"'`\s]+)["'`]/g;
// A lifecycle script that runs other packages' scripts or moves its working directory is not followed.
const UNFOLLOWED_FLAG = /^(?:--(?:filter|cwd|prefix|workspaces?|recursive)\b|-[FC]$)/;
const INSTALL_ENVIRONMENT = /^(?:NODE_ENV|npm_config_(?:production|omit|include|only|optional|ignore_scripts|legacy_peer_deps|registry)|BUN_CONFIG_\w+)$/i;
const MAX_REFERENCED_FILES = 256;

/** One path of a tree as `git ls-tree` reports it. */
interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
}

/** Every entry of the tree at `@` (snapshotting the working copy first unless `snapshot` is false), by path. */
async function treeAtWorkingCopy(workspacePath: string, snapshot = true): Promise<Map<string, TreeEntry> | null> {
  const commit = await run("jj", ["--color=never", ...(snapshot ? [] : ["--ignore-working-copy"]), "log", "-r", "@", "--no-graph", "-T", "commit_id"], { cwd: workspacePath });
  const gitRoot = await run("jj", ["--color=never", "--ignore-working-copy", "git", "root"], { cwd: workspacePath });
  const commitId = commit.stdout.trim();
  if (commit.code !== 0 || gitRoot.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commitId)) return null;
  const listed = await run("git", ["--git-dir", gitRoot.stdout.trim(), "ls-tree", "-r", "-t", "-z", "--full-tree", commitId],
    { cwd: workspacePath });
  if (listed.code !== 0 || listed.truncated) return null;
  const entries = new Map<string, TreeEntry>();
  for (const record of listed.stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    entries.set(record.slice(tab + 1), { mode: mode!, type: type!, oid: oid! });
  }
  return entries;
}

/** Every string in a manifest value that starts with `prefix`. */
function stringsWithPrefix(value: unknown, prefix: string, found: string[] = []): string[] {
  if (typeof value === "string") { if (value.startsWith(prefix)) found.push(value.slice(prefix.length)); }
  else if (value && typeof value === "object") for (const item of Object.values(value)) stringsWithPrefix(item, prefix, found);
  return found;
}

/** The fields of a package.json that the install inputs read. */
interface PackageManifest {
  scripts?: Record<string, string>;
  patchedDependencies?: Record<string, string>;
  dependenciesMeta?: Record<string, { injected?: boolean }>;
  pnpm?: { patchedDependencies?: Record<string, string> };
  [field: string]: unknown;
}

/** The tracked inputs a set of manifests and their install lifecycle reach, beyond the manifests themselves. */
async function referencedInputs(workspacePath: string, entries: Map<string, TreeEntry>, manifests: string[]): Promise<Set<string>> {
  const selected = new Set<string>();
  const tracked = (path: string): boolean => entries.has(path);
  /** A tracked path an install reads; untracked or outside the repository is unknown, so fail. */
  const requireInput = (directory: string, target: string): Promise<void> => {
    const path = posix.normalize(posix.join(directory, target));
    if (isAbsolute(target) || path.startsWith("../") || !tracked(path)) throw new Error(`untracked install input ${target}`);
    return visit(path, directory);
  };
  const visit = async (path: string, packageDirectory: string): Promise<void> => {
    if (selected.has(path)) return;
    if (selected.size >= MAX_REFERENCED_FILES) throw new Error("too many install inputs");
    selected.add(path);
    const entry = entries.get(path);
    if (entry?.type !== "blob") return;
    if (SCRIPT_SOURCE.test(path) || posix.basename(path) === ".pnpmfile.cjs") {
      // Imports, `new URL(..., import.meta.url)` and fs reads alike: any relative path the source mentions,
      // relative to the file or to the package directory it runs in.
      const source = await readFile(join(workspacePath, path), "utf8");
      for (const [, literal] of source.matchAll(RELATIVE_LITERAL)) {
        for (const base of [posix.dirname(path), packageDirectory]) {
          const target = posix.normalize(posix.join(base, literal!));
          const resolved = ["", ".mjs", ".js", ".ts", ".cjs", ".mts", ".cts", "/index.mjs", "/index.js", "/index.ts"]
            .map((suffix) => target + suffix).find(tracked);
          if (resolved) await visit(resolved, packageDirectory);
        }
      }
    } else if (entry.mode === "100755" || OPAQUE_SCRIPT.test(path)) {
      const parent = posix.dirname(path);
      if (parent === ".") throw new Error(`opaque root lifecycle script ${path}`);
      await visit(parent, packageDirectory);
    }
  };
  for (const [path, entry] of entries) {
    if (entry.type === "blob" && posix.basename(path) === ".pnpmfile.cjs") await visit(path, posix.dirname(path));
  }
  for (const manifest of manifests) {
    const directory = posix.dirname(manifest);
    const parsed: PackageManifest = JSON.parse(await readFile(join(workspacePath, manifest), "utf8"));
    const { scripts = {}, patchedDependencies = {}, dependenciesMeta = {}, ...declarations } = parsed;
    if (Object.values(dependenciesMeta).some((meta) => meta?.injected)) throw new Error("injected workspace dependencies");
    for (const target of stringsWithPrefix(declarations, "file:")) await requireInput(directory, target);
    for (const target of Object.values({ ...patchedDependencies, ...parsed.pnpm?.patchedDependencies })) await requireInput(directory, String(target));
    const pending = LIFECYCLE_SCRIPTS.filter((name) => typeof scripts[name] === "string");
    const seen = new Set(pending);
    while (pending.length) {
      for (const word of String(scripts[pending.pop()!]).split(/[\s;&|()'"`<>]+/)) {
        if (UNFOLLOWED_FLAG.test(word)) throw new Error(`unfollowed lifecycle script flag ${word}`);
        // `--import=./register.ts`: the value is the reference.
        const token = word.startsWith("-") ? word.slice(word.indexOf("=") + 1 || word.length) : word;
        if (!token || isAbsolute(token)) continue;
        // `bun run prepare:generated` and similar: follow the package's own nested scripts.
        if (typeof scripts[token] === "string" && !seen.has(token)) { seen.add(token); pending.push(token); }
        const candidate = posix.normalize(posix.join(directory, token));
        if (candidate === directory || candidate === "." || candidate.startsWith("../") || !tracked(candidate)) continue;
        await visit(candidate, directory);
      }
    }
  }
  return selected;
}

/** Host facts a frozen install depends on beyond the repository tree. */
async function installEnvironment(workspacePath: string): Promise<string[]> {
  const declared: unknown = JSON.parse(await readFile(join(workspacePath, "package.json"), "utf8").catch(() => "{}")).packageManager;
  const manager = typeof declared === "string" ? declared.split("@")[0] : "";
  const version = async (command: string): Promise<string> => {
    const result = await run(command, ["--version"], { cwd: workspacePath, env: process.env, timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error(`${command} --version failed`);
    return result.stdout.trim();
  };
  const userConfig = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path).catch(() => "absent")).digest("hex");
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return [
    `platform ${process.platform} ${process.arch}`,
    // The governed repository's install scripts may run under Node; a Bun-only host has none.
    `node ${await version("node").catch(() => "absent")}`,
    ...(manager ? [`manager ${manager} ${await version(manager)}`] : []),
    `user .npmrc ${await userConfig(join(homedir(), ".npmrc"))}`,
    `user .bunfig.toml ${await userConfig(join(homedir(), ".bunfig.toml"))} ${await userConfig(join(configHome, ".bunfig.toml"))}`,
    ...Object.keys(process.env).filter((key) => INSTALL_ENVIRONMENT.test(key)).sort().map((key) => `env ${key}=${process.env[key]}`),
  ];
}

/**
 * The workspace's install-input fingerprint (`sha256:<hex>`), or null when it
 * cannot be computed exactly (not JJ, unreadable tree or manifest, an input the
 * fingerprint cannot follow). Callers treat null as "inputs unknown" and install.
 * `snapshot: false` reads the last snapshot without touching the checkout, for
 * one (the primary) whose working copy a live session may own.
 */
export async function installInputFingerprint(workspacePath: string, { snapshot = true }: { snapshot?: boolean } = {}): Promise<string | null> {
  try {
    const entries = await treeAtWorkingCopy(workspacePath, snapshot);
    if (!entries) return null;
    const selected = new Set<string>();
    for (const [path, entry] of entries) {
      if (entry.type === "blob" && INPUT_NAMES.has(posix.basename(path))) selected.add(path);
      if (path === "patches") selected.add(path);
    }
    const manifests = [...selected].filter((path) => posix.basename(path) === "package.json");
    for (const path of await referencedInputs(workspacePath, entries, manifests)) selected.add(path);
    const hash = createHash("sha256").update("peach-install-inputs/v1\n");
    for (const line of await installEnvironment(workspacePath)) hash.update(`${line}\n`);
    for (const path of [...selected].sort()) {
      const { mode, type, oid } = entries.get(path)!;
      hash.update(`${mode} ${type} ${oid}\t${path}\n`);
    }
    return `sha256:${hash.digest("hex")}`;
  } catch {
    return null;
  }
}
