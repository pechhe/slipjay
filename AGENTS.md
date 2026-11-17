# SlipJay

SlipJay allocates jj workspaces and lands every repository's work through its runner.
Global agent policy governs workflow, delegation and delivery; this file adds only what
this repository needs.

- **Where to read.** The README's [Read by task](README.md#read-by-task) index names the
  contract for landing, a failed landing, the runner, promotion and deploys.
  [Architecture](docs/architecture.md) says which folder owns new code and its test.
- **The code you edit is not the code that runs.** This machine's `slipjay` client and
  its runner are separate installs. A landed change reaches the client with the hourly
  `maintain` upgrade, and the runner only with `slipjay upgrade --runner`; say which of
  the two your change needs when you report it. Try a change in tests, which build their
  own state, never against the live runner or the real `~/.slipjay`.
- **Tests.** Run one file with `bunx vp test tests/<capability>/<file>.test.ts`. Before
  landing, run `bun run test:landing`: it runs the gate's own selection for the working
  copy, every test file the change can reach (about 200 files and several minutes for a
  `src/` change, seconds for a doc change). Hand-picked files are not enough. Vitest gives
  each file a disposable `HOME`, which `bun test` does not: use `bun test` only for the
  `scripts/*.test.ts` files that `test:runtimes` lists.
- **Commit messages.** A change's commit message is its only record: the subject says
  what now happens, the body why. Add no `CHANGELOG.md` entry and do not bump the
  `package.json` version; `slipjay changes` reads the history.
