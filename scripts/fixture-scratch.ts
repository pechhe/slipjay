// Fixture repositories are written, synced and deleted within one test, and on a disk JJ's syncs take most of their
// time (nearly half of a landing test on the runner). Where Linux offers a RAM-backed /dev/shm, each test file's
// scratch directory lives there and is removed with it; one a killed run left behind is removed by a later file once
// its process has gone. Fixtures run scripts from that directory, so a noexec /dev/shm is passed over, and so is one
// this process may not write to: a read-only agent shell may write only its temp directory, which honours $TMPDIR.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHARED_MEMORY = "/dev/shm";

/** The last mount at a path is the one in effect. */
function executable(mount: string): boolean {
  const options = readFileSync("/proc/self/mounts", "utf8").split("\n").map((line) => line.split(" ")).filter(([, target]) => target === mount).at(-1)?.[3];
  return options !== undefined && !options.split(",").includes("noexec");
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * A scratch directory for one test file's fixtures, named `slipjay-test-<pid>-XXXXXX`, in the first of `roots` this
 * process may create one in: a RAM-backed /dev/shm, then the ambient temp directory. Each root is tried rather than
 * judged, so a read-only mount needs no separate check; a left-over directory under /dev/shm from a process that has
 * gone is removed.
 */
export function createFixtureScratch(roots: readonly string[] = [SHARED_MEMORY, tmpdir()]): string {
  let refused: unknown;
  for (const root of roots) {
    if (root === SHARED_MEMORY && (process.platform !== "linux" || !existsSync(root) || !executable(root))) continue;
    try {
      const scratch = mkdtempSync(join(root, `slipjay-test-${process.pid}-`));
      if (root === SHARED_MEMORY) {
        for (const name of readdirSync(root)) {
          const owner = /^slipjay-test-(\d+)-/.exec(name)?.[1];
          if (owner && !alive(Number(owner))) rmSync(join(root, name), { recursive: true, force: true });
        }
      }
      return scratch;
    } catch (error) {
      // A root that refuses the write leaves the next one to supply the directory.
      refused = error;
    }
  }
  throw refused instanceof Error ? refused : new Error(`no test file's scratch directory could be created in ${roots.join(", ")}`);
}
