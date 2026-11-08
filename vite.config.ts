import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";

// Every test file gets a disposable HOME before its imports run (scripts/vitest-hermetic-env.ts):
// slipjay derives all workspace, lock and landing state from homedir().
const hermeticEnvironment = fileURLToPath(new URL("./scripts/vitest-hermetic-env.ts", import.meta.url));

export default defineConfig({
  check: { fmt: false },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    // The runner's systemd slice bounds CPU and memory. Keep that budget busy
    // while subprocess-heavy fixtures wait, with an isolated fork per file.
    // Half the CPUs: at "100%" one complete suite held peach-live's five-minute load at 35 on 14 CPUs, with CPU pressure
    // up to 75%, because each worker's fixtures start their own jj, git and runner processes (SJ-212).
    maxWorkers: "50%",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    setupFiles: [hermeticEnvironment],
  },
  lint: {
    options: { typeAware: true, typeCheck: false },
  },
});
