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
    // Half the cores: on the 16-core runner, 8 workers took the suite from 585 s to 315 s, leaving room for other lanes.
    maxWorkers: "50%",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    setupFiles: [hermeticEnvironment],
  },
  lint: {
    options: { typeAware: true, typeCheck: false },
  },
});
