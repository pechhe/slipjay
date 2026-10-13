import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { architectureViolations, importSpecifiers } from "./check-architecture.ts";

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "slipjay-architecture-"));
  for (const [file, code] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), code);
  }
  return root;
}

test("slipjay's own closure is self-contained and acyclic", () => {
  assert.deepEqual(architectureViolations(), []);
});

test("reads multi-line, side-effect and literal dynamic imports, ignoring comments and type-only imports", () => {
  const code = [
    "// import { gone } from \"./commented.ts\";",
    "import {",
    "  a,",
    "} from \"./a.ts\";",
    "import \"./side.ts\";",
    "export { b } from \"./b.ts\";",
    "const late = await import(\"./late.ts\");",
    "import type { T } from \"./types.ts\";",
    "export type { U } from \"./types.ts\";",
    "type V = import(\"./types.ts\").V;",
  ].join("\n");
  assert.deepEqual(importSpecifiers(code).sort(), ["./a.ts", "./b.ts", "./late.ts", "./side.ts"]);
});

test("reports imports outside the closure and import cycles", () => {
  const root = fixture({
    "src/lib/a.ts": 'import { b } from "./b.ts";\nimport { x } from "lodash";\nimport { readFile } from "node:fs/promises";\nimport { Effect } from "effect";\n',
    "src/lib/b.ts": 'export const b = 1;\nexport { a } from "./a.ts";\nimport { app } from "../../app/thing.ts";\n',
  });
  try {
    assert.deepEqual(architectureViolations(root).sort(), [
      "cycle|src/lib/a.ts,src/lib/b.ts|src/lib/a.ts,src/lib/b.ts",
      "external-import|src/lib/a.ts|lodash",
      "external-import|src/lib/b.ts|../../app/thing.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
