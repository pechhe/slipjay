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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RUNTIME_PACKAGES = new Set(["effect", "proper-lockfile"]);

/** The executable area: CLI, client-facts recorder, spare refill and housekeeping entries. Library code must not import it. */
export const EXECUTABLE_AREA = "src/launcher/";

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Runtime import specifiers of a module's source: static and literal dynamic, without type-only imports. */
export function importSpecifiers(code: string): string[] {
  // The scanner rejects a shebang, which only an executable entry point carries.
  return transpiler.scanImports(code.replace(/^#!.*/, "")).map((entry) => entry.path);
}

type Token = { kind: "word" | "string" | "punct"; text: string };

const WORD = /[\p{ID_Continue}$]/u;
// A `/` after one of these tokens divides; after anything else it opens a regular expression.
const DIVIDES_AFTER = /^(?:[\p{ID_Continue}$)\]}]|\d)/u;
const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "yield", "await", "throw", "delete", "new"]);

/** Whether the tokens end in a postfix \`++\` or \`--\`, after which \`/\` divides. */
const postfix = (tokens: Token[]) => {
  const [last, before] = [tokens.at(-1), tokens.at(-2)];
  return last?.kind === "punct" && (last.text === "+" || last.text === "-") && before?.text === last.text;
};

/** Code tokens of a module: comments dropped, string/template/regex bodies skipped, string literals kept. */
function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  const braces: ("code" | "template")[] = [];
  let i = 0;
  const quoted = (quote: string) => {
    let text = "";
    for (i++; i < code.length && code[i] !== quote; i++) {
      if (code[i] === "\\") i++;
      text += code[i] ?? "";
    }
    i++;
    return text;
  };
  const template = () => {
    // Positioned after the opening backtick or a closing `}`: skip text up to the next `${` or closing backtick.
    for (; i < code.length; i++) {
      if (code[i] === "\\") i++;
      else if (code[i] === "`") { i++; return; }
      else if (code[i] === "$" && code[i + 1] === "{") { i += 2; braces.push("template"); return; }
    }
  };
  while (i < code.length) {
    const c = code[i]!;
    const prev = tokens.at(-1);
    if (/\s/.test(c)) i++;
    else if (c === "/" && code[i + 1] === "/") while (i < code.length && code[i] !== "\n") i++;
    else if (c === "/" && code[i + 1] === "*") { const end = code.indexOf("*/", i + 2); i = end < 0 ? code.length : end + 2; }
    else if (c === '"' || c === "'") tokens.push({ kind: "string", text: quoted(c) });
    else if (c === "`") { i++; template(); tokens.push({ kind: "string", text: "" }); }
    else if (c === "/" && !(prev && (prev.kind === "string" || postfix(tokens) || (DIVIDES_AFTER.test(prev.text.at(-1)!) && !(prev.kind === "word" && KEYWORDS_BEFORE_REGEX.has(prev.text)))))) {
      for (i++; i < code.length && code[i] !== "/"; i++) {
        if (code[i] === "\\") i++;
        else if (code[i] === "[") while (i < code.length && code[i] !== "]") { if (code[i] === "\\") i++; i++; }
      }
      i++;
      tokens.push({ kind: "string", text: "" });
    } else if (WORD.test(c)) {
      const start = i;
      while (i < code.length && WORD.test(code[i]!)) i++;
      tokens.push({ kind: "word", text: code.slice(start, i) });
    } else if (c === "{") { braces.push("code"); tokens.push({ kind: "punct", text: c }); i++; }
    else if (c === "}") {
      i++;
      if (braces.pop() === "template") { template(); tokens.push({ kind: "string", text: "" }); }
      else tokens.push({ kind: "punct", text: "}" });
    } else { tokens.push({ kind: "punct", text: c }); i++; }
  }
  return tokens;
}

/**
 * Every module specifier a source mentions in import syntax, type-only forms included:
 * static imports, re-exports, literal dynamic imports and `import("x")` type queries.
 * Comments and ordinary strings are not imports.
 */
export function declaredSpecifiers(code: string): string[] {
  const tokens = tokenize(code.replace(/^#!.*/, ""));
  const found: string[] = [];
  const word = (index: number, text: string) => tokens[index]?.kind === "word" && tokens[index]!.text === text;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "word" || (token.text !== "import" && token.text !== "export")) continue;
    if (tokens[i - 1]?.text === ".") continue;
    if (tokens[i + 1]?.text === "(" && tokens[i + 2]?.kind === "string" && tokens[i + 3]?.text === ")") {
      found.push(tokens[i + 2]!.text);
      continue;
    }
    if (token.text === "import" && tokens[i + 1]?.kind === "string") {
      found.push(tokens[i + 1]!.text);
      continue;
    }
    // `import|export [type] <bindings> from "x"`: the bindings hold only words, `,`, `*` and one braced list.
    let depth = 0;
    for (let j = i + 1; j < tokens.length; j++) {
      const next = tokens[j]!;
      if (next.kind === "string") { if (depth === 0 && word(j - 1, "from")) found.push(next.text); break; }
      if (next.text === "{") depth++;
      else if (next.text === "}") depth--;
      else if (next.kind === "punct" && next.text !== "," && next.text !== "*") break;
      else if (next.kind === "word" && depth === 0 && !word(j - 1, "from") && ["const", "let", "var", "function", "class", "async", "interface", "enum", "default", "declare", "namespace", "abstract"].includes(next.text) && j === i + 1) break;
    }
  }
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
  for (const file of files) {
    edges.set(file, new Set());
    const code = readFileSync(path.join(root, file), "utf8");
    const runtime = new Set(importSpecifiers(code));
    for (const specifier of new Set([...runtime, ...declaredSpecifiers(code)])) {
      if (specifier.startsWith(".")) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        if (!known.has(target)) violations.push(`external-import|${file}|${specifier}`);
        else {
          if (runtime.has(specifier)) edges.get(file)!.add(target);
          if (target.startsWith(EXECUTABLE_AREA) && !file.startsWith(EXECUTABLE_AREA)) violations.push(`library-imports-executable|${file}|${target}`);
        }
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
  else console.log("check:architecture: the src/ closure is self-contained, library code does not import executables, and the runtime graph is acyclic");
}
