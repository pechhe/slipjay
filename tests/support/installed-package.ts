import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The package as a consumer has it: the packed tarball unpacked into a directory outside the checkout. */
export type InstalledPackage = {
  /** Disposable directory holding the installation; nothing in it is a source-tree path. */
  root: string;
  /** The installed package directory, `<root>/node_modules/@pechhe/slipjay`. */
  packageRoot: string;
  /** The `slipjay` binary the installation links, as a package manager would. */
  bin: string;
  /** `file:` URL prefix every installed module resolves under. */
  packageUrl: string;
  /** Run `bun` in the installation with extra arguments; returns trimmed stdout. */
  bun(args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): string;
  /** Write a module into the installation (outside the package) so it can import the package by name. */
  script(name: string, source: string): Promise<string>;
  dispose(): Promise<void>;
};

/**
 * Pack the checkout (`bun pm pack`, which applies the package's `files`) and unpack it as
 * `node_modules/@pechhe/slipjay` in a fresh directory. The runtime dependencies are linked
 * from the checkout's `node_modules`; the package itself is only ever the packed copy, so a
 * path that still points into `src/` of the checkout fails to resolve. Reuse it to prove
 * that a layout-sensitive change works from the distributable.
 */
export async function installPackage(): Promise<InstalledPackage> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "slipjay-installed-")));
  const packed = join(root, "packed");
  const scope = join(root, "node_modules", "@pechhe");
  await mkdir(packed, { recursive: true });
  await mkdir(scope, { recursive: true });
  execFileSync("bun", ["pm", "pack", "--destination", packed, "--quiet"], { cwd: SOURCE_ROOT, stdio: "pipe" });
  const [tarball] = await readdir(packed);
  if (!tarball) throw new Error("bun pm pack produced no tarball");
  execFileSync("tar", ["-xzf", join(packed, tarball), "-C", packed]);
  const packageRoot = join(scope, "slipjay");
  await cp(join(packed, "package"), packageRoot, { recursive: true });
  for (const entry of await readdir(join(SOURCE_ROOT, "node_modules"))) {
    if (entry === "@pechhe" || entry === ".bin" || entry.startsWith(".")) continue;
    await symlink(join(SOURCE_ROOT, "node_modules", entry), join(root, "node_modules", entry));
  }
  const bin = join(root, "node_modules", ".bin", "slipjay");
  await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
  await chmod(join(packageRoot, "src", "launcher", "workspace.ts"), 0o755);
  await symlink(join(packageRoot, "src", "launcher", "workspace.ts"), bin);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  return {
    root,
    packageRoot,
    bin,
    packageUrl: pathToFileURL(packageRoot).href,
    bun: (args, options = {}) => execFileSync("bun", args, { cwd: options.cwd ?? root, env: options.env ?? process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
    script: async (name, source) => { const file = join(root, name); await writeFile(file, source); return file; },
    dispose: async () => { await rm(root, { recursive: true, force: true }); },
  };
}
