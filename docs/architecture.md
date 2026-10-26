# Architecture

One package, two public entries (`@pechhe/slipjay` and `@pechhe/slipjay/delivery`, both `src/lib/slipjay.ts`) and one binary (`slipjay`, `src/launcher/workspace.ts`). Bun runs the TypeScript directly; there is no build step.

## Where code lives

`src/lib` is importable library code, grouped by the capability that owns it. A folder holds a capability's implementation; files keep their descriptive names.

| Folder | Owns |
|---|---|
| `workspace` | Workspace creation, state, attempts, spare pool, housekeeping, sweep, lifecycle, teardown, cutover |
| `landing` | Landing candidates, steps and outcome, submission handoff and source, required verification, migration candidates, repair claims and repair workspaces |
| `runner` | The runner service, queue, local executor, API, HTTP, log, watch and client; client facts; command evidence and artifacts; pipeline metrics; verification test-report ingestion and per-file timing evidence; failure classification |
| `release` | Release, deploy and reset (with their schedulers) and the post-integration steps they share; nightly audit scheduling, evidence and failure attribution |
| `build` | Build integration: admission, receipts, handoff, pipeline relay, the tracker and Issue references |
| `policy` | Repository policy (`slipjay.json`) and machine configuration: execution, deployment, verification and post-integration policy, `policy` command and settings |
| `infra` | Primitives with consumers in several capabilities: bounded processes, the `jj` wrapper, workspace transactions (locking), command execution, UTF-8 and verification-output text, checkout resolution |

`src/launcher` holds executables and the command handlers they dispatch to. The CLI entry (`workspace.ts`) only starts up, applies the cutover gate and dispatches to one handler per command, and the three detached background entries are `client-facts.ts`, `spare-refill.ts` and `housekeeping-run.ts`. A command's handler lives in the `*-command(s).ts` module of its feature (workspaces, retention, start, landing, release and deploy, policy and config, cutover, observation, runner administration, the guard hook); a new command goes there and gets one line in the entry's handler table. A handler parses its arguments, formats its output and owns its signal handling, and calls the library feature that owns the behaviour; importing a handler runs nothing until it is invoked. They compose library code. Library code spawns the background entries by path (`new URL(...)` plus a child process); it never imports the entries or the handlers.

`tests/<folder>` mirrors the owning folder. `tests/integration` holds tests that span capabilities (the CLI, the installed package). `tests/support` holds fixtures shared by several folders, and a fixture used by one folder lives in it (`tests/runner/fixtures`).

A new implementation goes in the folder of the capability it extends; add `infra` only for a primitive that two or more capabilities already need. A new test goes in the matching `tests/` folder.

## Composition

A capability may import another's focused module; landing calls workspace and release code, the runner composes landing, release and build, and so on. There is no folder-level layering: the dependency graph between modules is what must stay acyclic. Import the module that owns the function, not the facade, from inside `src/lib`.

External consumers import only the two package names. Adding a public export means adding it to `src/lib/slipjay.ts`.

## What `bun run check` enforces

`scripts/check-architecture.ts` reads every `.ts` file under `src/` and fails when:

- a module imports a relative path outside `src/`, or a package that is not a Node built-in, `effect` or `proper-lockfile` (`external-import`), in any syntax, type-only included;
- a module outside `src/launcher` imports a module inside it, by static import, re-export, literal dynamic import or type-only form (`library-imports-executable`);
- the runtime module graph has a cycle (`cycle`). Type-only imports are not runtime edges, so erased type cycles pass.

The declaration scan uses the installed Vite toolchain’s TypeScript parser, including import-equals declarations. Invalid syntax fails the check with a parse error naming the source file; it never silently accepts a partial dependency set. Bun’s separate runtime scan supplies cycle edges.

It does not forbid cross-capability imports, does not follow non-literal dynamic imports or spawn paths, and does not check other repositories' imports of the package. Whether the packed package works from another directory is covered by `tests/integration/installed-package.test.ts`, whose fixture (`tests/support/installed-package.ts`) installs the packed tarball outside the checkout; reuse it for any change that depends on file locations.
