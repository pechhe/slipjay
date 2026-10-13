import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";

// Every test file gets a disposable HOME before its imports run (scripts/vitest-hermetic-env.mjs):
// slipjay derives all workspace, lock and landing state from homedir().
const hermeticEnvironment = fileURLToPath(new URL("./scripts/vitest-hermetic-env.mjs", import.meta.url));

export default defineConfig({
  check: { fmt: false },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    maxWorkers: 4,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    setupFiles: [hermeticEnvironment],
  },
  lint: {
    options: { typeAware: true, typeCheck: false },
  },
});
