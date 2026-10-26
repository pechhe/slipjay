#!/usr/bin/env bun
// The slipjay source boundary (carried over from peach-pi's check:architecture):
// - every module under src/ imports only other src/ modules, Node built-ins and the
//   declared runtime dependencies, in runtime and type-only syntax alike;
// - nothing outside the executable area (src/launcher) imports a module inside it;
// - the runtime module graph is acyclic (erased type-only cycles are allowed).
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "vite/rolldown/parseAst";
import { Visitor } from "vite/rolldown/utils";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RUNTIME_PACKAGES = new Set(["effect", "proper-lockfile"]);

/** The executable area: CLI, client-facts recorder, spare refill and housekeeping entries. Library code must not import it. */
export const EXECUTABLE_AREA = "src/launcher/";

/**
 * The runner's event store records and reads events; the interpretations above it (classification, a landing's
 * outcome, the watch projection, Build's delivery state, short-landing classes) are composed by its caller
 * (`runner-service`, through `OperationLogProjections`). The store must not import one at runtime, or every test
 * that reads the ledger inherits it again.
 */
export const RUNNER_EVENT_STORE = "src/lib/runner/runner-log.ts";
export const RUNNER_PROJECTIONS = new Set([
  "src/lib/runner/pipeline-metrics.ts", "src/lib/runner/failure-classification.ts", "src/lib/runner/runner-watch-projection.ts",
  "src/lib/landing/landing-outcome.ts", "src/lib/build/build-receipts.ts",
]);

/** Transport and wire contracts may compose primitives, never delivery implementations, even through erased imports. */
export const RUNNER_NEUTRAL_MODULES = new Set([
  "src/lib/runner/runner-transport.ts", "src/lib/runner/runner-contract.ts", "src/lib/runner/runner-types.ts",
  "src/lib/release/release-types.ts",
]);
const sharedPrimitives = new Set(["src/lib/workspace/start-steps.ts", "src/lib/release/release-types.ts"]);
const deliveryImplementation = (file: string): boolean => !sharedPrimitives.has(file) && (
  ["src/lib/workspace/", "src/lib/landing/", "src/lib/release/", "src/lib/build/"].some((area) => file.startsWith(area))
  || file === "src/lib/runner/runner-client.ts" || file === "src/lib/infra/workspace-jj.ts"
);

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Runtime import specifiers of a module's source: static and literal dynamic, without type-only imports. */
export function importSpecifiers(code: string): string[] {
  // The scanner rejects a shebang, which only an executable entry point carries.
  return transpiler.scanImports(code.replace(/^#!.*/, "")).map((entry) => entry.path);
}

/**
 * Every literal module specifier, including erased imports, re-exports and type
 * queries. Use the installed toolchain's TypeScript parser: regex/division and
 * quoted bindings need grammatical context, not a preceding-token heuristic.
 * Parsing errors throw rather than silently accepting an incomplete dependency set.
 */
export function declaredSpecifiers(code: string, filename = "architecture.ts"): string[] {
  const program = parseAst(code, { lang: "ts" }, filename);
  const found: string[] = [];
  new Visitor({
    ImportDeclaration(node) { found.push(node.source.value); },
    ExportNamedDeclaration(node) { if (node.source) found.push(node.source.value); },
    ExportAllDeclaration(node) { found.push(node.source.value); },
    ImportExpression(node) {
      if (node.source.type === "Literal" && typeof node.source.value === "string") found.push(node.source.value);
    },
    TSImportType(node) { found.push(node.source.value); },
    TSImportEqualsDeclaration(node) {
      if (node.moduleReference.type === "TSExternalModuleReference") found.push(node.moduleReference.expression.value);
    },
  }).visit(program);
  return found;
}

const packageName = (specifier: string) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
const builtin = (specifier: string) => specifier.startsWith("node:") || builtinModules.includes(specifier);

function modules(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const file = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) found.push(file);
    }
  };
  walk("src");
  return found.sort();
}

function cycles(edges: Map<string, Set<string>>): string[] {
  const found: string[] = [];
  const state = new Map<string, "active" | "done">();
  const stack: string[] = [];
  const visit = (node: string) => {
    state.set(node, "active");
    stack.push(node);
    for (const next of [...(edges.get(node) ?? [])].sort()) {
      if (!state.has(next)) visit(next);
      else if (state.get(next) === "active") {
        const members = stack.slice(stack.indexOf(next)).sort().join(",");
        if (!found.includes(members)) found.push(members);
      }
    }
    stack.pop();
    state.set(node, "done");
  };
  for (const node of [...edges.keys()].sort()) if (!state.has(node)) visit(node);
  return found;
}

/** Boundary violations as `kind|file|detail` lines; empty when the boundary holds. */
export function architectureViolations(root = ROOT): string[] {
  const files = modules(root);
  const known = new Set(files);
  const violations: string[] = [];
  const edges = new Map<string, Set<string>>();
  const declaredEdges = new Map<string, Set<string>>();
  for (const file of files) {
    edges.set(file, new Set());
    declaredEdges.set(file, new Set());
    const code = readFileSync(path.join(root, file), "utf8");
    const runtime = new Set(importSpecifiers(code));
    for (const specifier of new Set([...runtime, ...declaredSpecifiers(code, file)])) {
      if (specifier.startsWith(".")) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        if (!known.has(target)) violations.push(`external-import|${file}|${specifier}`);
        else {
          declaredEdges.get(file)!.add(target);
          if (runtime.has(specifier)) {
            if (file === RUNNER_EVENT_STORE && RUNNER_PROJECTIONS.has(target)) violations.push(`store-imports-projection|${file}|${target}`);
            edges.get(file)!.add(target);
          }
          if (target.startsWith(EXECUTABLE_AREA) && !file.startsWith(EXECUTABLE_AREA)) violations.push(`library-imports-executable|${file}|${target}`);
        }
      } else if (!builtin(specifier) && !RUNTIME_PACKAGES.has(packageName(specifier))) {
        violations.push(`external-import|${file}|${specifier}`);
      }
    }
  }
  for (const owner of RUNNER_NEUTRAL_MODULES) {
    const seen = new Set<string>([owner]);
    const visit = (file: string) => {
      for (const target of [...(declaredEdges.get(file) ?? [])].sort()) {
        if (seen.has(target)) continue;
        seen.add(target);
        if (deliveryImplementation(target)) violations.push(`runner-transport-imports-workflow|${owner}|${target}`);
        else visit(target);
      }
    };
    visit(owner);
  }
  for (const members of cycles(edges)) violations.push(`cycle|${members}|${members}`);
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = architectureViolations();
  for (const violation of violations) console.error(violation);
  if (violations.length) process.exitCode = 1;
  else console.log("check:architecture: the src/ closure is self-contained, library code does not import executables, the runner event store composes no projection, runner transport and contracts depend on no delivery implementation, and the runtime graph is acyclic");
}
