import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { architectureViolations, declaredSpecifiers, importSpecifiers } from "./check-architecture.ts";

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

test("declared specifiers include every type-only form but not comments or strings", () => {
  const code = [
    "// import { gone } from \"./commented.ts\";",
    "/* export * from \"./block.ts\"; */",
    "const text = 'import x from \"./string.ts\"'; const tpl = `import y from \"./tpl.ts\" ${1 + 1}`;",
    "const pattern = /[\"']import z from/;",
    "import type { T } from \"./t.ts\";",
    "import { type A, type B } from \"./ab.ts\";",
    "import def, * as ns from \"./ns.ts\";",
    "export type { U } from \"./u.ts\";",
    "export * as star from \"./star.ts\";",
    "export const local = 1;",
    "type V = import(\"./v.ts\").V;",
    "type W = typeof import(\"./w.ts\");",
    "const late = await import(\"./late.ts\");",
    "const url = import.meta.url;",
    "let n = 4; n++ / 2; n-- / 2;",
    "import type { Z } from \"./after-postfix.ts\";",
  ].join("\n");
  assert.deepEqual(declaredSpecifiers(code).sort(), ["./ab.ts", "./after-postfix.ts", "./late.ts", "./ns.ts", "./star.ts", "./t.ts", "./u.ts", "./v.ts", "./w.ts"]);
});

test("accepts feature composition, facade re-exports and executables composing the library", () => {
  const root = fixture({
    "src/lib/slipjay.ts": 'export { run } from "./landing/run.ts";\nexport type { Plan } from "./release/plan.ts";\n',
    "src/lib/landing/run.ts": 'import { plan } from "../release/plan.ts";\nimport type { Plan } from "../release/plan.ts";\nexport const run = (p: Plan) => plan(p);\n',
    "src/lib/release/plan.ts": 'export type Plan = { n: number };\nexport const plan = (p: Plan) => p;\n',
    "src/launcher/workspace.ts": 'import { run } from "../lib/slipjay.ts";\nimport { entry } from "./entry.ts";\nexport { run, entry };\n',
    "src/launcher/entry.ts": 'import { plan } from "../lib/release/plan.ts";\nexport const entry = plan;\n',
  });
  try {
    assert.deepEqual(architectureViolations(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects library imports of executables in every static and type-only form", () => {
  const root = fixture({
    "src/launcher/command.ts": 'export type Options = {};\nexport const command = 1;\n',
    "src/lib/runtime.ts": 'import { command } from "../launcher/command.ts";\nexport { command };\n',
    "src/lib/reexport.ts": 'export { command } from "../launcher/command.ts";\n',
    "src/lib/dynamic.ts": 'export const load = () => import("../launcher/command.ts");\n',
    "src/lib/type-import.ts": 'import type { Options } from "../launcher/command.ts";\nexport type O = Options;\n',
    "src/lib/type-reexport.ts": 'export type { Options } from "../launcher/command.ts";\n',
    "src/lib/type-query.ts": 'export type Q = typeof import("../launcher/command.ts");\n',
    "src/lib/inline-type.ts": 'import { type Options } from "../launcher/command.ts";\nexport type O = Options;\n',
  });
  try {
    assert.deepEqual(architectureViolations(root).sort(), [
      "library-imports-executable|src/lib/dynamic.ts|src/launcher/command.ts",
      "library-imports-executable|src/lib/inline-type.ts|src/launcher/command.ts",
      "library-imports-executable|src/lib/reexport.ts|src/launcher/command.ts",
      "library-imports-executable|src/lib/runtime.ts|src/launcher/command.ts",
      "library-imports-executable|src/lib/type-import.ts|src/launcher/command.ts",
      "library-imports-executable|src/lib/type-query.ts|src/launcher/command.ts",
      "library-imports-executable|src/lib/type-reexport.ts|src/launcher/command.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects type-only closure escapes and undeclared packages but not type-only cycles", () => {
  const root = fixture({
    "src/lib/a.ts": 'import type { B } from "./b.ts";\nimport type { Outside } from "../../app/outside.ts";\nimport type { X } from "lodash";\nexport type A = B;\n',
    "src/lib/b.ts": 'import type { A } from "./a.ts";\nexport type B = { a?: A };\n',
  });
  try {
    assert.deepEqual(architectureViolations(root).sort(), [
      "external-import|src/lib/a.ts|../../app/outside.ts",
      "external-import|src/lib/a.ts|lodash",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
