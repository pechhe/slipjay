import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, readlink, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Evidence that an installed `node_modules` tree is usable, as a structural check: every installed package
 * directory holds a readable, non-empty `package.json` that parses to an object.
 *
 * A frozen install trusts what it finds. A package-manager install over a package directory that lost its
 * files exits zero without repairing them (pnpm 12 does so over a virtual-store entry), so the install's
 * success and the inputs' fingerprint prove nothing about the bytes. Every installed package has a manifest
 * whatever its layout, so its absence is damage in any of them; requiring more (a root `index.js`, a resolvable
 * `main` or `exports`) would refuse legitimate metadata-only and conditional-export packages. This does not
 * prove each file of a package is intact.
 *
 * Layouts: a package directory directly under `node_modules` (hoisted Bun, npm, and scoped `@scope/name`);
 * the entries of a virtual store, `node_modules/.pnpm/<id>/node_modules` and Bun's isolated `.bun/<id>/node_modules`,
 * where each real directory is a package and each link is a dependency that must resolve; nested `node_modules` of
 * an installed package. Other symlinks (workspace links) are not read through, but a link into a virtual store must
 * resolve. Anything that cannot be read is reported rather than taken as empty. Bun's global-store links are checked
 * by `bunStoreDamage`.
 */

/** Concurrent filesystem operations while walking a tree; a pnpm virtual store holds thousands of entries. */
const CONCURRENCY = 64;

/** How many damaged paths a report names. */
const REPORTED = 10;

export interface DependencyTreeDamage {
  /** Damaged package directories (or missing manifests), as the first {@link REPORTED} absolute paths. */
  paths: string[];
  /** The number found, which is larger than `paths` when the report was cut. */
  total: number;
}

/** Run `work` over `items` with at most {@link CONCURRENCY} in flight. */
async function each<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

const isDirectory = async (path: string): Promise<boolean> => (await lstat(path).catch(() => null))?.isDirectory() === true;

/** Whether `dir` holds a usable `package.json`. */
async function hasManifest(dir: string): Promise<boolean> {
  const raw = await readFile(join(dir, "package.json"), "utf8").catch(() => null);
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch { return false; }
}

/** `dir`'s entries, none when it does not exist; one that cannot be read is damage, never a healthy empty directory. */
async function list(dir: string, found: string[]): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") found.push(`${dir} (unreadable: ${code ?? "error"})`);
    return [];
  }
}

/** The package directories and links one level into `modules`, scopes expanded. */
async function packagesIn(modules: string, found: string[]): Promise<{ path: string; link: boolean; directory: boolean }[]> {
  const packages: { path: string; link: boolean; directory: boolean }[] = [];
  for (const entry of await list(modules, found)) {
    if (entry.name.startsWith("@")) {
      for (const scoped of await list(join(modules, entry.name), found)) {
        packages.push({ path: join(modules, entry.name, scoped.name), link: scoped.isSymbolicLink(), directory: scoped.isDirectory() });
      }
    } else if (!entry.name.startsWith(".")) packages.push({ path: join(modules, entry.name), link: entry.isSymbolicLink(), directory: entry.isDirectory() });
  }
  return packages;
}

/** What one check has found and still has to settle. */
interface Walk {
  found: string[];
  seen: Set<string>;
  /** Package directories found in virtual stores, so most links resolve by lookup instead of a syscall each. */
  packages: Set<string>;
  /** Links into a virtual store, settled once every store has been read. */
  links: string[];
}

/** The links that do not resolve: a package that is missing. */
async function unresolved(walk: Walk): Promise<void> {
  await each(walk.links, async (link) => {
    const target = await readlink(link).catch(() => null);
    if (target !== null && walk.packages.has(resolve(dirname(link), target))) return;
    if (!await stat(link).catch(() => null)) walk.found.push(link);
  });
}

/** Damaged package directories among the `node_modules` directly in `modules` (see the module comment). */
async function scan(modules: string, walk: Walk): Promise<void> {
  const { found, seen } = walk;
  if (seen.has(modules)) return;
  seen.add(modules);
  await each(await packagesIn(modules, found), async ({ path, link, directory }) => {
    if (link) {
      // A link into a virtual store must resolve; any other link's target is validated where it lives.
      if (/(^|\/)\.(pnpm|bun)\//.test(await readlink(path).catch(() => ""))) walk.links.push(path);
    } else if (directory) {
      if (!await hasManifest(path)) found.push(join(path, "package.json"));
      else if (await isDirectory(join(path, "node_modules"))) await scan(join(path, "node_modules"), walk);
    }
  });
  for (const store of [".pnpm", ".bun"].map((name) => join(modules, name))) {
    const entries = (await list(store, found)).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules");
    await each(entries, async (entry) => {
      // An entry's `node_modules` holds its own package, a real directory, and a link to each dependency's entry.
      for (const { path, link, directory } of await packagesIn(join(store, entry.name, "node_modules"), found)) {
        if (link) walk.links.push(path);
        else if (directory) {
          walk.packages.add(path);
          if (!await hasManifest(path)) found.push(join(path, "package.json"));
        }
      }
    });
  }
}

/**
 * Damage in the `node_modules` trees beside `manifests` (repository-relative `package.json` paths) of the checkout at
 * `root`, or null when every tree present is usable. A manifest with no `node_modules` beside it has none to check,
 * unless `required`: the manifests are the trees an install recorded, and one gone is damage.
 */
export async function dependencyTreeDamage(root: string, manifests: string[], options: { required?: boolean } = {}): Promise<DependencyTreeDamage | null> {
  const walk: Walk = { found: [], seen: new Set(), packages: new Set(), links: [] };
  for (const manifest of manifests) {
    const modules = join(root, dirname(manifest), "node_modules");
    const info = await lstat(modules).then((info) => info, (error: NodeJS.ErrnoException) => error);
    if (info instanceof Error) {
      // A tree an install recorded must still be there; one only presumed from a manifest may not have been installed.
      if (info.code !== "ENOENT" || options.required) walk.found.push(`${modules} (${info.code === "ENOENT" ? "missing" : `unreadable: ${info.code ?? "error"}`})`);
    } else if (info.isDirectory()) await scan(modules, walk);
  }
  await unresolved(walk);
  if (!walk.found.length) return null;
  const paths = [...new Set(walk.found)].sort();
  return { paths: paths.slice(0, REPORTED), total: paths.length };
}

/** A damage report as an error message, naming the tree and the paths. */
export function describeDependencyTreeDamage(workspacePath: string, damage: DependencyTreeDamage): string {
  const more = damage.total > damage.paths.length ? `\n  … and ${damage.total - damage.paths.length} more` : "";
  return `The installed dependencies in ${workspacePath} are incomplete: ${damage.total} missing or unreadable part(s): a package without a usable package.json, a dependency link that does not resolve, or a directory that cannot be read.\n${damage.paths.map((path) => `  ${path}`).join("\n")}${more}`;
}
