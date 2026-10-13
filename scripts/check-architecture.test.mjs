import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { architectureViolations, importSpecifiers } from "./check-architecture.mjs";

function fixture(files) {
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

test("reads multi-line, side-effect and literal dynamic imports, ignoring comments", () => {
  const code = [
    "// import { gone } from \"./commented.mjs\";",
    "import {",
    "  a,",
    "} from \"./a.mjs\";",
    "import \"./side.mjs\";",
    "export { b } from \"./b.mjs\";",
    "const late = await import(\"./late.mjs\");",
  ].join("\n");
  assert.deepEqual(importSpecifiers(code).sort(), ["./a.mjs", "./b.mjs", "./late.mjs", "./side.mjs"]);
});

test("reports imports outside the closure and import cycles", () => {
  const root = fixture({
    "src/lib/a.mjs": 'import { b } from "./b.mjs";\nimport { x } from "lodash";\nimport { readFile } from "node:fs/promises";\nimport { Effect } from "effect";\n',
    "src/lib/b.mjs": 'export const b = 1;\nexport { a } from "./a.mjs";\nimport { app } from "../../app/thing.mjs";\n',
  });
  try {
    assert.deepEqual(architectureViolations(root).sort(), [
      "cycle|src/lib/a.mjs,src/lib/b.mjs|src/lib/a.mjs,src/lib/b.mjs",
      "external-import|src/lib/a.mjs|lodash",
      "external-import|src/lib/b.mjs|../../app/thing.mjs",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
