/**
 * Which SlipJay build the running code is. `slipjay upgrade` builds each commit into
 * `~/.slipjay/installs/<commit>` and moves a slot symlink onto it, so the tree this module was loaded
 * from names the build actually running: the runner's slot moves before its restart, so reading the
 * `runner-install` link would answer with the install about to start rather than the one answering.
 */
import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The directory each commit is built into, as `installsHome()` names it. Spelled here rather than
 * imported: that accessor refuses while a cutover is pending, and reading this must never refuse a
 * command before it has run.
 */
const INSTALLS = "installs";
/** An install directory is named by the commit it was built from. */
const INSTALL_COMMIT = /^[0-9a-f]{40}$/;

/** `file` with every symlink resolved, or as given when it cannot be (a checkout being edited, a test path). */
function resolved(file: string): string {
  try { return realpathSync(file); } catch { return file; }
}

/**
 * The commit whose `installs/<commit>` directory holds `file`, or null when it holds none — a
 * development checkout, a test, or a tree built anywhere else. A slot symlink is resolved first, so it
 * answers for the install the running code came from, not for wherever the slot points now.
 */
export function installRevisionOf(file: string): string | null {
  let directory = dirname(resolved(file));
  for (;;) {
    if (basename(dirname(directory)) === INSTALLS && INSTALL_COMMIT.test(basename(directory))) return basename(directory);
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** What this process runs, read once as its code was loaded: a slot that moves later cannot change the answer. */
export const runningInstallRevision: string | null = installRevisionOf(fileURLToPath(import.meta.url));
