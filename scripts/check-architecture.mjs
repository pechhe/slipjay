#!/usr/bin/env node
// The slipjay closure boundary (carried over from peach-pi's check:architecture):
// every module under src/ imports only other src/ modules, Node built-ins and the
// declared runtime dependencies, and the module graph is acyclic.
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RUNTIME_PACKAGES = new Set(["effect", "proper-lockfile"]);

const STATIC = /^[ \t]*(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']|^[ \t]*import\s*["']([^"']+)["']/gm;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** Static and literal dynamic import specifiers of a module's source. */
export function importSpecifiers(code) {
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...stripped.matchAll(STATIC)].map((match) => match[1] ?? match[2])
    .concat([...stripped.matchAll(DYNAMIC)].map((match) => match[1]));
}

const packageName = (specifier) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
const builtin = (specifier) => specifier.startsWith("node:") || builtinModules.includes(specifier);

function modules(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const file = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.mjs$/.test(entry.name)) found.push(file);
    }
  };
  walk("src");
  return found.sort();
}

function cycles(edges) {
  const found = [];
  const state = new Map();
  const stack = [];
  const visit = (node) => {
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

/** Boundary violations as `kind|file|detail` lines; empty when the closure holds. */
export function architectureViolations(root = ROOT) {
  const files = modules(root);
  const known = new Set(files);
  const violations = [];
  const edges = new Map();
  for (const file of files) {
    edges.set(file, new Set());
    for (const specifier of importSpecifiers(readFileSync(path.join(root, file), "utf8"))) {
      if (specifier.startsWith(".")) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        if (known.has(target)) edges.get(file).add(target);
        else violations.push(`external-import|${file}|${specifier}`);
      } else if (!builtin(specifier) && !RUNTIME_PACKAGES.has(packageName(specifier))) {
        violations.push(`external-import|${file}|${specifier}`);
      }
    }
  }
  for (const members of cycles(edges)) violations.push(`cycle|${members}|${members}`);
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = architectureViolations();
  for (const violation of violations) console.error(violation);
  if (violations.length) process.exitCode = 1;
  else console.log("check:architecture: the src/ closure is self-contained and acyclic");
}
