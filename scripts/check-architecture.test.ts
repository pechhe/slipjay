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

test("the runner event store composes no projection its caller supplies", () => {
  const root = fixture({
    "src/lib/runner/runner-log.ts": 'import { landingOutcome } from "../landing/landing-outcome.ts";\nimport type { LandingOutcome } from "../landing/landing-outcome.ts";\nimport { classifyEvent } from "./failure-classification.ts";\n',
    "src/lib/landing/landing-outcome.ts": "export type LandingOutcome = 1;\nexport const landingOutcome = 1;\n",
    "src/lib/runner/failure-classification.ts": "export const classifyEvent = 1;\n",
  });
  try {
    assert.deepEqual(architectureViolations(root).sort(), [
      "store-imports-projection|src/lib/runner/runner-log.ts|src/lib/landing/landing-outcome.ts",
      "store-imports-projection|src/lib/runner/runner-log.ts|src/lib/runner/failure-classification.ts",
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

const expressionPrefixes = [
  'if (true) /./.test("x");',
  'if (false) {} /./.test("x");',
  'while (false) /./.test("x");',
  'for (; false;) /./.test("x");',
  'const f = () => { return /[\\/]/; };',
  'const object = { n: 4 }; object.n / 2;',
  'let n = 4; n++ / 2; n-- / 2; ++n / 2; --n / 2;',
  'const n = (4 + 2) / 2 / 3;',
  'const n = (() => 4)() / 2;',
];

test("expressions before declarations cannot hide type-only ownership or closure violations", () => {
  for (const prefix of ["", ...expressionPrefixes]) {
    const root = fixture({
      "src/launcher/command.ts": 'export type Options = { n: number };',
      "src/lib/example.ts": `${prefix}\nimport type { Options } from "../launcher/command.ts";\nexport type Copy = Options;`,
      "src/lib/escape.ts": `${prefix}\nimport type { Outside } from "../../outside.ts";\nexport type Copy = Outside;`,
    });
    try {
      assert.deepEqual(architectureViolations(root).sort(), [
        "external-import|src/lib/escape.ts|../../outside.ts",
        "library-imports-executable|src/lib/example.ts|src/launcher/command.ts",
      ], prefix);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("finds real imports and type queries after control-flow regex and division expressions", () => {
  for (const prefix of expressionPrefixes) {
    assert.deepEqual(declaredSpecifiers(`${prefix}
      import type { T } from "./types.ts";
      export type { U } from "./export.ts";
      export * from "./star.ts";
      type V = import("./query.ts").V;
      const load = import("./dynamic.ts", { with: { type: "json" } });
      const template = \`text \${import("./interpolation.ts")}\`;
    `).sort(), ["./dynamic.ts", "./export.ts", "./interpolation.ts", "./query.ts", "./star.ts", "./types.ts"], prefix);
  }
});

test("regex bodies and non-import text never create dependencies", () => {
  const code = String.raw`
    if (false) {} /import("not-an-import")/.test("x");
    if (true) /export type { X } from "fake-export"/.test("x");
    while (false) /[/'"]import("fake-class")/.test("x");
    const f = () => /import("fake-arrow")/;
    // import type { T } from "fake-comment";
    /* export * from "fake-block"; */
    const text = 'import("fake-string")';
    const template = \`import("fake-template")\`;
    const object = { import(name: string) { return name; } };
    object.import("fake-method");
    export const ok = 1;
  `.replaceAll('\\`', '`');
  assert.deepEqual(declaredSpecifiers(code), []);
  const root = fixture({ "src/lib/example.ts": code });
  try {
    assert.deepEqual(architectureViolations(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quoted type bindings keep their actual module dependency", () => {
  const declarations = [
    'import type { "Options" as Copy } from "../launcher/command.ts"; export type T = Copy;',
    'import { type "Options" as Copy } from "../launcher/command.ts"; export type T = Copy;',
    'export type { "Options" as Copy } from "../launcher/command.ts";',
    'export { type "Options" as "Copy" } from "../launcher/command.ts";',
  ];
  for (const code of declarations) {
    assert.deepEqual(declaredSpecifiers(code), ["../launcher/command.ts"]);
    const root = fixture({
      "src/launcher/command.ts": 'export type Options = { n: number };',
      "src/lib/example.ts": code,
    });
    try {
      assert.deepEqual(architectureViolations(root), ["library-imports-executable|src/lib/example.ts|src/launcher/command.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  assert.deepEqual(declaredSpecifiers(String.raw`import type { T } from "./\u0074ypes.ts";`), ["./types.ts"]);
});

test("accepts in-closure type composition after regex and rejects incomplete syntax", () => {
  const root = fixture({
    "src/lib/a.ts": 'if (true) /./.test("x"); import type { "B" as B } from "./b.ts"; export type A = B;',
    "src/lib/b.ts": 'if (false) {} /import("fake")/.test("x"); export type { A as B } from "./a.ts";',
  });
  try {
    assert.deepEqual(architectureViolations(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(declaredSpecifiers('const load = (name: string) => import(name); const url = import.meta.url;'), []);
  assert.throws(() => declaredSpecifiers('import type { T } from "./types.ts"; const broken = '), /Parse failed/);
});

test("import-equals module references obey boundaries while namespace aliases add no dependency", () => {
  const root = fixture({
    "src/launcher/command.ts": 'export type Options = { n: number };',
    "src/lib/example.ts": 'import type X = require("../launcher/command.ts"); export type T = X.Options;',
    "src/lib/escape.ts": 'import type X = require("../../outside.ts"); export type T = X.Options;',
  });
  try {
    assert.deepEqual(architectureViolations(root).sort(), [
      "external-import|src/lib/escape.ts|../../outside.ts",
      "library-imports-executable|src/lib/example.ts|src/launcher/command.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(declaredSpecifiers('export import X = require("./x.ts"); import Y = NS.Member;'), ["./x.ts"]);
  assert.deepEqual(declaredSpecifiers('#!/usr/bin/env bun\nimport type { X } from "./x.ts";'), ["./x.ts"]);
});

test("parse failure identifies the source module", () => {
  assert.throws(() => declaredSpecifiers('const broken = ', "src/lib/broken.ts"), (error: unknown) => {
    assert.equal((error as { id: string }).id, "src/lib/broken.ts");
    assert.match((error as Error).message, /Parse failed/);
    return true;
  });
});

test("runner transport and contracts reject direct and transitive workflow dependencies, including erased types", () => {
  const root = fixture({
    "src/lib/runner/runner-transport.ts": 'import type { T } from "../infra/helper.ts"; import { run } from "../landing/run.ts"; export { run };',
    "src/lib/runner/runner-types.ts": 'export type { T } from "../release/release.ts";',
    "src/lib/runner/runner-contract.ts": 'export type T = import("../workspace/state.ts").T;',
    "src/lib/release/release-types.ts": 'export type { T } from "../infra/helper.ts";',
    "src/lib/infra/helper.ts": 'export type { T } from "../build/admission.ts";',
    "src/lib/build/admission.ts": 'export type T = {};',
    "src/lib/landing/run.ts": 'export const run = 1;',
    "src/lib/release/release.ts": 'export type T = {};',
    "src/lib/workspace/state.ts": 'export type T = {};',
  });
  try {
    assert.deepEqual(architectureViolations(root).sort(), [
      "runner-transport-imports-workflow|src/lib/release/release-types.ts|src/lib/build/admission.ts",
      "runner-transport-imports-workflow|src/lib/runner/runner-contract.ts|src/lib/workspace/state.ts",
      "runner-transport-imports-workflow|src/lib/runner/runner-transport.ts|src/lib/build/admission.ts",
      "runner-transport-imports-workflow|src/lib/runner/runner-transport.ts|src/lib/landing/run.ts",
      "runner-transport-imports-workflow|src/lib/runner/runner-types.ts|src/lib/release/release.ts",
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("higher-level workflows compose neutral contracts and transport with shared primitives", () => {
  const root = fixture({
    "src/lib/landing/run.ts": 'import { connect } from "../runner/runner-transport.ts"; export { connect };',
    "src/lib/runner/runner-transport.ts": 'import { run } from "../infra/process.ts"; export const connect = run;',
    "src/lib/infra/process.ts": 'export const run = 1;',
    "src/lib/runner/runner-types.ts": 'export type { StartSteps } from "../workspace/start-steps.ts"; export type { Result } from "../release/release-types.ts";',
    "src/lib/workspace/start-steps.ts": 'export type StartSteps = {};',
    "src/lib/release/release-types.ts": 'export type Result = {};',
  });
  try { assert.deepEqual(architectureViolations(root), []); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
