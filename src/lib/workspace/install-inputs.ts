import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix } from "node:path";
import { runWorkspaceCommand as run } from "../infra/workspace-command.ts";

/**
 * The install-input fingerprint of a workspace: a digest of what a frozen
 * package-manager install reads to produce `node_modules`. Equal fingerprints
 * mean a prepared `node_modules` is still that install's exact output, so a
 * claimed spare need not reinstall.
 *
 * From the JJ tree at `@`: every lockfile, `package.json` (less the fields an
 * install never reads, see `installManifest`) and package-manager
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
// Package metadata and publishing fields: an install neither resolves nor links by them, and a
// release bump or a new export changes them on almost every landing.
const UNINSTALLED_FIELDS = new Set([
  "version", "description", "keywords", "homepage", "bugs", "license", "author", "contributors", "maintainers", "funding",
  "repository", "private", "exports", "types", "typings", "files",
]);

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

/** The words of a script, split at shell separators and quotes. */
const scriptWords = (script: string): string[] => script.split(/[\s;&|()'"`<>]+/);

/**
 * The scripts an install runs: the lifecycle scripts and the package's own scripts they run, such
 * as `bun run prepare:generated`, each with the `pre`/`post` hooks a package manager runs around it.
 */
function installScripts(scripts: Record<string, string>): Set<string> {
  const reached = new Set<string>();
  const pending: string[] = [];
  const reach = (name: string) => {
    for (const hooked of [name, `pre${name}`, `post${name}`]) {
      if (typeof scripts[hooked] === "string" && !reached.has(hooked)) { reached.add(hooked); pending.push(hooked); }
    }
  };
  for (const name of LIFECYCLE_SCRIPTS) reach(name);
  while (pending.length) for (const word of scriptWords(String(scripts[pending.pop()!]))) reach(word);
  return reached;
}

/**
 * A manifest as an install reads it: without `UNINSTALLED_FIELDS` and without scripts the install
 * never runs, so a release bump or a new test script leaves the fingerprint alone. A manifest the
 * install's lifecycle code reads is hashed whole instead (see `installInputFingerprint`).
 */
function installManifest(source: string): string {
  const { scripts = {}, ...fields }: PackageManifest = JSON.parse(source);
  const kept = Object.fromEntries(Object.entries(fields).filter(([field]) => !UNINSTALLED_FIELDS.has(field)));
  return JSON.stringify({ ...kept, scripts: Object.fromEntries([...installScripts(scripts)].sort().map((name) => [name, scripts[name]])) });
}

/** A workspace list this module cannot read exactly: the caller then judges every manifest. */
class UnsupportedWorkspaceList extends Error {}

/** Whether `directory` matches a workspace pattern: literal segments, `*` within one, and `**` for any number of segments (including none). */
function matchesWorkspacePattern(pattern: string, directory: string): boolean {
  if (!/^[\w.@*/-]+$/.test(pattern)) throw new UnsupportedWorkspaceList(`workspace pattern ${pattern}`);
  const match = (patternSegments: string[], segments: string[]): boolean => {
    const [head, ...rest] = patternSegments;
    if (head === undefined) return segments.length === 0;
    if (head === "**") return match(rest, segments) || (segments.length > 0 && match(patternSegments, segments.slice(1)));
    if (segments.length === 0) return false;
    const segment = new RegExp(`^${head.split("*").map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
    return segment.test(segments[0]!) && match(rest, segments.slice(1));
  };
  return match(posix.normalize(pattern).replace(/\/+$/, "").split("/"), directory.split("/"));
}

/**
 * The `packages:` list of a `pnpm-workspace.yaml`: null when it declares none, and
 * unsupported when it uses any form beyond plain, quoted or commented list items.
 */
function pnpmWorkspacePackages(source: string): string[] | null {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^packages\b/.test(line));
  if (start < 0) return null;
  if (!/^packages\s*:\s*(?:#.*)?$/.test(lines[start]!)) throw new UnsupportedWorkspaceList("inline packages list");
  const patterns: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;
    const item = /^\s+-\s+(?:"([^"]+)"|'([^']+)'|([\w.@*/!-]+))\s*(?:#.*)?$/.exec(line);
    if (!item) throw new UnsupportedWorkspaceList(`workspace list line ${line.trim()}`);
    patterns.push(item[1] ?? item[2] ?? item[3]!);
  }
  if (!patterns.length) throw new UnsupportedWorkspaceList("empty packages list");
  return patterns;
}

/**
 * The manifests an install runs lifecycle scripts for: the root and its declared workspace
 * members (`workspaces` in the root `package.json`, or `packages:` in `pnpm-workspace.yaml`).
 * A tracked manifest outside them, such as a vendored repository under `.repos/`, is never
 * installed, so its scripts are no input. When no workspace list is declared, or one cannot
 * be read exactly, every manifest is judged: the fingerprint may be refused for it, never
 * trusted wrongly.
 */
async function installedManifests(workspacePath: string, manifests: string[]): Promise<string[]> {
  const read = (path: string) => readFile(join(workspacePath, path), "utf8").catch(() => null);
  try {
    const root: PackageManifest | null = JSON.parse(await read("package.json") ?? "null");
    const declared = root?.workspaces;
    const listed: unknown[] = Array.isArray(declared) ? declared : Array.isArray((declared as { packages?: unknown } | undefined)?.packages) ? (declared as { packages: unknown[] }).packages : [];
    if (listed.some((pattern) => typeof pattern !== "string")) throw new UnsupportedWorkspaceList("workspaces entry");
    const all = [...(listed as string[]), ...(pnpmWorkspacePackages(await read("pnpm-workspace.yaml") ?? "") ?? [])];
    if (!all.length) return manifests;
    const included = all.filter((pattern) => !pattern.startsWith("!"));
    const excluded = all.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
    return manifests.filter((manifest) => {
      const directory = posix.dirname(manifest);
      return directory === "." || (included.some((pattern) => matchesWorkspacePattern(pattern, directory)) && !excluded.some((pattern) => matchesWorkspacePattern(pattern, directory)));
    });
  } catch (error) {
    if (error instanceof UnsupportedWorkspaceList) return manifests;
    throw error;
  }
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
    for (const name of installScripts(scripts)) {
      for (const word of scriptWords(String(scripts[name]))) {
        if (UNFOLLOWED_FLAG.test(word)) throw new Error(`unfollowed lifecycle script flag ${word}`);
        // `--import=./register.ts`: the value is the reference.
        const token = word.startsWith("-") ? word.slice(word.indexOf("=") + 1 || word.length) : word;
        if (!token || isAbsolute(token)) continue;
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
    const manifests = await installedManifests(workspacePath, [...selected].filter((path) => posix.basename(path) === "package.json"));
    const referenced = await referencedInputs(workspacePath, entries, manifests);
    for (const path of referenced) selected.add(path);
    const hash = createHash("sha256").update("peach-install-inputs/v2\n");
    for (const line of await installEnvironment(workspacePath)) hash.update(`${line}\n`);
    for (const path of [...selected].sort()) {
      const { mode, type, oid } = entries.get(path)!;
      // An installed manifest counts by what an install reads of it; any other file, and a manifest
      // install lifecycle code reads itself, by its exact content.
      const content = manifests.includes(path) && !referenced.has(path) ? createHash("sha256").update(installManifest(await readFile(join(workspacePath, path), "utf8"))).digest("hex") : oid;
      hash.update(`${mode} ${type} ${content}\t${path}\n`);
    }
    return `sha256:${hash.digest("hex")}`;
  } catch {
    return null;
  }
}
