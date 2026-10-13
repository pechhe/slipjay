# slipjay

Harness-neutral JJ workspace and landing tool. One tagged artifact is both the
`slipjay` CLI and a library, written in TypeScript and run by Bun (1.4 or later),
its only runtime.

slipjay was extracted from `pechhe/peach-pi` at `37a32367` as `peach-workspace`,
became Slipway in v1.0.0, and is renamed to SlipJay in v2.0.0. It uses the
`slipjay` CLI, `slipjay.json` config, `SLIPJAY_*` environment names, and state
under `~/.slipjay`. See [CHANGELOG.md](CHANGELOG.md) and [State and cutover](#state-and-cutover).

## State and cutover

| What | Location |
| --- | --- |
| Landing state, locks, verification slots, post-land and post-integration records | `~/.slipjay/state` |
| Checkout mode (`slipjay mode`) | `~/.slipjay/mode.json` |
| New isolated workspaces | `~/.slipjay/workspaces` |
| Cutover record | `~/.slipjay/cutover.json` |

In v2.0.0, `slipjay cutover` moves state from `~/.slipway` to `~/.slipjay` once. The
package also ships a `slipway` bin that only refuses: it prints "slipway is now
slipjay. Run instead: slipjay <args>" and exits 1. On a machine that still has `~/.slipway/state`,
every command except `status` and `cutover` refuses until the cutover has run.

`slipjay cutover`:

1. Refuses, naming each holder, while any landing transaction, verification slot
   (or a landing waiting for one), Direct primary-checkout writer, post-land run or
   post-integration run is held or live. Nothing changes.
2. Moves `~/.slipway/state` and `~/.slipway/mode.json` to `~/.slipjay`, by rename,
   or across devices by copy, verify, then delete. Existing workspaces stay at
   `~/.slipway/workspaces/...` and keep working through landing and cleanup; new
   workspaces go to `~/.slipjay/workspaces`.
3. Writes `~/.slipjay/cutover.json`. Running `slipjay cutover` again is a no-op.

`slipjay cutover --check` reports what would block or move without changing anything.

Never sync `~/.slipjay/state` or `~/.slipjay/workspaces` between machines: they
are per-machine lock stores.

## Repository config

A repository's landing policy is `slipjay.json` at its root. A repository with
only `slipway.json` is refused with a message to rename it; the landing guard still
guards it (fail closed). Once `slipjay.json` exists, a leftover `slipway.json` is
ignored. The earlier retired path `.peach/execution.json` is no longer read.

Workspaces are named by a project code: `projectCode` in `slipjay.json` (2-8
lowercase letters or digits) when declared, else two letters derived from the
checkout folder (`peach-pi` → `pp`, `slipjay` → `sl`). Declare it when the folder
name may change, so existing `ys-412`-style names stay stable.

### Workspace teardown

A repository can declare a command that runs in a workspace just before slipjay
deletes it, for example to stop a dev server started from that checkout:

```json
{ "workspaceTeardown": { "executable": "ys-preview", "args": ["stop"] } }
```

`executable` is a bare name resolved on `PATH`; `args` is optional. It runs with
the workspace as its working directory and `SLIPJAY_WORKSPACE_NAME` and
`SLIPJAY_WORKSPACE_PATH` set, under a 30 second timeout, read from the primary
checkout's `slipjay.json`. It runs on every path that deletes a checkout:
`cleanup`, `remove`, `prune --empty`, and the sweeps after landing and at start,
all through `retireWorkspace`. It is best effort: a missing executable, a
non-zero exit, a timeout or an unreadable policy is logged to stderr
(`[teardown] <workspace>: ...`) and never blocks the removal. A registered
workspace whose checkout is already gone has no working directory, so it is
forgotten without a teardown. Claiming a spare renames an unused checkout in
place and does not run one.

### Workspace options

Optional `slipjay.json` fields for the workspace pool and shared output:

| Field | Meaning |
| --- | --- |
| `spares` | Integer 0-8, default 1. How many prepared spare workspaces the pool keeps; 0 disables the pool. A refill tops the pool up one spare at a time, counting spares still being prepared, and holds the pool lock only to count and register a name, never during the dependency install, so a claim always takes any ready spare even while another is installing. Every claim by `start` also starts a background refill, so a burst of starts finds the pool replenished. An idle spare costs nothing at landing. |
| `sharedPaths` | Array of repository-relative directories (at most 20; literal paths, no globs, none inside another, none in `.jj`/`.git`). Each workspace gets a symlink at that path to the same path in the primary (integration) checkout, which is created when missing. The link is made when a workspace is started, resumed or claimed and when a spare is provisioned. An existing real directory is replaced only when empty; with content it is left alone with a warning. Cleanup ignores a link into the primary checkout, so git-ignored output such as `artifacts/` no longer keeps a landed workspace. List the path in `.gitignore`, or jj snapshots the link as source (slipjay warns). |

When a new workspace has no spare to claim, or a spare is provisioned, and it has
no `node_modules`, slipjay first clones the `node_modules` trees of a prepared
spare (or of the primary checkout) whose install-input fingerprint is identical,
with copy-on-write clones (`cp -c` on macOS, `--reflink=auto` on Linux; bun links
with relative symlinks, which are copied verbatim, so the copy resolves inside its
new checkout). The normal frozen install still runs afterwards as the
verification, and if it fails on a cloned tree, the clone is discarded and the
install repeated from scratch.

`land` runs that frozen install again after rebasing the candidate, before any
migration generation or verification, so the gate sees the dependencies of the
integration tip it verifies against rather than the one the workspace was
allocated from. An install that edits tracked source is undone and fails the
landing.

## Environment contract

| Name | Set for |
| --- | --- |
| `SLIPJAY_POST_LAND_BASE`, `SLIPJAY_POST_LAND_COMMIT` | Post-land verification commands. |
| `SLIPJAY_WORKSPACE_NAME`, `SLIPJAY_WORKSPACE_PATH` | The `workspaceTeardown` command. |
| `SLIPJAY_VERIFICATION_SLOT` | Commands running inside the held verification slot. Set to `held`, it lets a nested landing pass through. |
| `SLIPJAY_FINALIZATION_COMMIT`, `_KEY`, `_TARGET` | Post-integration finalization commands and target probes. A policy's `environmentKeys` may not start with `SLIPJAY_FINALIZATION_`. |

slipjay reads `SLIPJAY_COMMAND_TIMEOUT_MS`, the per-command timeout for jj, git
and gh. The pre-v1.1.0 Peach environment names are neither set nor read.

## Install

Releases are git tags. Nothing is published to npm.

```sh
bun add -g github:pechhe/slipjay#v3.1.2
slipjay status
```

To upgrade, run `bun remove -g @pechhe/slipjay && bun pm cache rm` first: Bun keeps
the installed tag otherwise.

From Slipway, remove it first (`bun remove -g @pechhe/slipway`) and run
`slipjay cutover` once after installing.

The repository is public, so the `github:` tag form needs no authentication.

## CLI

`slipjay <command>` offers the same commands and behaviour as the earlier `slipway`
tool, plus `cutover` and what a Claude Code `WorktreeCreate`/`WorktreeRemove` hook needs without library
imports (`start --integration --issue <n> --json`, `remove <path>`):

| Command | Effect |
| --- | --- |
| `status` | Mode, current workspace, integration checkout, landing and post-land state (JSON). |
| `mode [isolated\|direct]` | Read or write the checkout mode. |
| `list` | Workspaces with their state, Issue and retained material. |
| `pool [refill]` | Show ready spare workspaces, or provision one (up to `spares`). |
| `prune --empty` | Remove empty workspaces, empty workspaces of a closed Issue, and state left by workspaces that no longer exist. |
| `attach-issue <n>` | Bind the current workspace to Issue `n`. |
| `start "task"` | Assign an isolated workspace for a task and print its path. An empty, undescribed change is described `wip: <task> (#<n>)` so abandoned work is never anonymous; landing replaces exactly that generated text (recorded in the workspace metadata) with the Issue title or task, never publishing it; a description you write, `wip:` or not, lands as written, and a stack with the placeholder left on a lower commit is refused. A new workspace is based on the integration branch freshly fetched from the declared remote (best effort: offline, it starts from the local branch). |
| `start [--integration] [--issue <n>] [--refill] [--json] ["task"]` | `--integration` allocates from the integration checkout even inside a workspace; `--issue` creates or resumes that Issue's workspace (the task defaults to `Issue #<n>`); `--refill` then starts a background spare refill (a claimed spare is always refilled); `--json` prints one JSON object (`workspacePath`, `workspaceName`, `integrationRoot`, `issueNumber`, `created`, `reused`, `pooled`, `refill`) and sends all install output to stderr. |
| `preview` | Diffstat of what a landing would integrate. |
| `land [--local-only] [--direct]` | Verify, integrate and publish the current workspace (or, with `--direct`, the primary checkout). Afterwards it removes the landed workspace itself, as `cleanup` would: this process and the session that ran it do not keep it, but any other process with its working directory inside does, and is named with its pid and command (the shell's directory is gone once it is removed, so `cd` to the primary checkout). It also sweeps other delivered workspaces, saying why it kept any. |
| `release [--confirm <commit>] [--migrations-ready]` | Plan a promotion of the integration branch to the declared release branch, or verify and publish the confirmed candidate (see [Release](#release)). |
| `cleanup [path]` | Remove the current (or given) workspace once it has landed. The working copy is snapshotted once and judged; just before the workspace is forgotten it is snapshotted again, and if it changed in between, the workspace is kept (`working-copy-changed`) rather than orphaning the new commit. |
| `remove <path>` | Remove the workspace at `path` if it has landed or is untouched; otherwise keep it and exit 1. |
| `guard` | Claude Code PreToolUse landing guard (reads the tool call on stdin). It denies moving or pushing the integration branch outside `land`, and a declared release branch outside `release`. In a SlipJay workspace it also denies `jj new`, `jj edit`, `jj checkout`, `jj next`/`prev` and `jj workspace forget` (of the current or any named workspace) while the workspace left or forgotten has a non-empty, unintegrated `@` with no description (or only the generated one), telling the agent to `jj describe`, `jj abandon` or land it; that check runs one jj query in each workspace it would leave, inside that workspace's checkout so its unsnapshotted edits count (by its last snapshot when that checkout is missing or unreadable), and allows the command if jj cannot be queried. Each command is judged by the repository it targets (`git -C`, `jj -R`, else the working directory). |
| `cutover [--check]` | Move state from `~/.slipway` to `~/.slipjay` once and retire the `slipway` CLI (see [State and cutover](#state-and-cutover)). |
| `runner <serve\|log <operation>>` | Run the landing runner on this host, or print one operation's run log (see [Runner](#runner)). |

## Runner

When a runner location is configured, `slipjay land` sends the change to one
long-lived runner instead of verifying locally. The runner queues landings and takes
them one at a time in arrival order. For each one it rebases onto the integration tip,
runs the repository's declared gate in its own warm checkout, then integrates and
publishes. The authoring machine runs none of the gate.

- **Location.** One value: `SLIPJAY_RUNNER`, or `"runner"` in `~/.slipjay/config.json`.
  On the runner's host it is `http://127.0.0.1:7787`. Elsewhere it is
  `ssh://<host>`, and `land` opens an SSH port forward for the duration of the call
  (the host must be reachable with key auth). Without a location, `land` runs locally
  as before. `--local-only` always runs locally.
- **Credential.** A bearer token: `SLIPJAY_RUNNER_TOKEN` in the environment, or else
  the Bitwarden Secrets Manager key of that name, read through `bws`. A request
  without it is refused. The runner binds loopback only.
- **What `land` prints.** One line per stage, naming the runner and the queue
  position. Then a summary: the verdict, the failing command's output verbatim on
  failure, and `slipjay runner log <operation>`, which prints the full run log from any machine with the location. Interrupting `land` stops following but
  not the landing. Running `land` again in the same workspace reattaches to the same
  operation (or, if it landed meanwhile, finishes the workspace housekeeping); it never submits twice. While an older commit of the change is running, `land` follows it instead of moving its bookmark, then asks you to land again. Set `SLIPJAY_RUNNER_VERBOSE=1` to see every
  progress line.
- **Transport.** The client publishes the change as the bookmark
  `slipjay/changes/<changeId>` and submits it by jj change ID. The runner fetches it
  on its turn and deletes it when the operation closes.
- **Migrations and finalization.** Within a change's turn, the runner generates its
  `migrationFinalization` artifacts on the rebased candidate (generation and its
  verification are recorded runs, like the gate), runs the gate, integrates, runs the
  repository's `postIntegration` step (YardSmith: migrate Development), then publishes.
  Because the queue is serial, concurrent migration changes get consecutive numbers.
  The runner host therefore needs whatever that step needs (YardSmith: a logged-in
  `vercel` CLI on the unit's `PATH`).
- **Held integrations.** If finalization or publication fails, the external target
  may already reflect the integration, so the runner keeps it on its local
  integration branch instead of dropping it, and the failure says so. Every later
  turn first retries finalizing and publishing it (with the same artifact key, so
  the migration is never regenerated), and nothing else lands until that succeeds.
  Relanding the same commit reports it landed once it is published. A deterministic
  failure needs a person: reconcile the target, then on the runner host move the
  checkout's integration bookmark back to the remote
  (`jj -R ~/.slipjay/runner/repos/<owner>/<name> bookmark set <branch> -r <branch>@origin --allow-backwards`).
- **State.** The runner's own state lives in `~/.slipjay/runner`:
  - `config.json`: the name, the listen port and the repositories, keyed `owner/name` with their git URL.
  - `operations.sqlite`: one append-only event log; operations, queue positions and runs are projections of it.
  - `logs/<operation>.log`: the run logs.
  - `repos/<owner>/<name>`: the warm checkouts.
  - Finalization receipts, target outcomes and the target lease stay in
    `~/.slipjay/state/post-integration`, shared with local landings on the same host so
    the lease covers both. Held-integration retries rely on them; move them with the runner.

  On restart, queued operations resume. An operation that was running is recorded as
  landed if its commit already reached the remote, and as failed ("land again")
  otherwise.
- **Setup.** On the runner host, with `slipjay`, `jj` and `bws` installed and the
  Bitwarden secret `SLIPJAY_RUNNER_TOKEN` saved:
  `scripts/setup-runner.sh pechhe/YardSmith=git@github.com:pechhe/YardSmith.git`.
  It writes the config and a systemd user unit that runs `bws run -- slipjay runner
  serve` with `Restart=always`, and enables lingering so the unit survives logout and
  reboot. Logs: `journalctl --user -u slipjay-runner`.
- **API.** Under `/v1`: operations (submit, read, cancel, event stream, log) and
  changes by jj change ID. The contract is `src/lib/runner-contract.ts`.

## Release

A repository that declares a `releaseBranch` in `slipjay.json` promotes its
integration branch to it only through `slipjay release`:

```json
{ "integrationBranch": "develop", "releaseBranch": "master",
  "requiredReleaseVerification": [{ "executable": "bun", "args": ["run", "check:static"] }] }
```

`requiredReleaseVerification` takes the same command shape as
`requiredLocalVerification`. A release branch without it is refused; declare `[]`
to release without checks. The policy that applies is the one committed in the
candidate.

1. `slipjay release` fetches and plans: the candidate (the integration branch on
   the remote), the base (the release branch on the remote), the commits between
   them, the declared checks, and any files under
   `migrationFinalization.artifactPaths` in that range. It publishes nothing.
   `halfBuiltSpecs` lists each open Spec (the open, non-`programme` parent Issue of
   an Issue a commit in the range served, by its `Issue:` trailer or `(#N)`) with
   its closed and total Tickets, so the approver sees a partly delivered feature.
   It only warns. Without a GitHub remote, or when `gh` cannot answer, it reads
   `{ "checked": false, "reason": … }` and the release goes ahead; `--confirm`
   checks again.
2. After explicit human approval of that candidate, `slipjay release --confirm
   <commit>` checks the exact commit out on its own under
   `~/.slipjay/state/releases/checkouts`, prepares its dependencies and runs the
   checks inside the repository's release slot, which it holds until it has
   published. Landing continues while a release verifies. The candidate must
   already be published on the integration branch.

   Concurrent confirms coalesce rather than refuse. Candidates sit on the linear
   integration branch, so of any two one contains the other, and releasing the
   newer ships both. A confirm made while another release runs waits for the slot,
   printing what it waits for (`[release] waiting for release 16bea7013436
   (contains 5b4569ebb74d)`, or `… to finish before …` when its own candidate is
   newer). It stands aside for any waiting confirm whose candidate contains its
   own, so of several waiters only the newest verifies. As soon as the release
   branch contains its candidate (the release it waited for published), or when
   it takes the slot and a fresh fetch shows that, it returns `"status":
   "released_by"` with the release `merge` that shipped it and that merge's
   candidate as `releasedBy`, without verifying. Otherwise, holding the slot, it
   plans again against the moved base and verifies and publishes its own
   candidate, so when the release it waited for fails, an older waiter still
   runs. Each session only ever verifies the commit it was approved for. A
   holder or waiter stops counting once its process is gone or, for a waiter,
   once it has not polled for a minute; a dead holder's lock goes stale after a
   minute. A confirm whose candidate is already released when it plans returns
   `"status": "up_to_date"`.
3. It builds the merge `Release <integration> to <release>` (parents: base, then
   candidate; a `Release-Candidate:` trailer) and refuses unless the merge is
   conflict-free and its tree is the candidate's, so a release branch with changes
   the integration branch lacks is refused rather than merged.
4. It pushes the release branch, refusing if the remote moved since the plan, and
   records the release in `~/.slipjay/state/releases`.

5. When the candidate's policy declares `postRelease`, it then runs that step
   against an external target, for example resetting a development database from
   the release's production one:

   ```json
   { "postRelease": { "version": 1, "target": "app-development-db:…", "timeoutMs": 1200000,
       "command": { "executable": "bun", "args": ["scripts/reset-development.ts"], "cwd": "app" },
       "targetProbe": { "executable": "bun", "args": ["scripts/probe-development.ts"], "cwd": "app" },
       "environmentKeys": ["NEON_API_KEY"] } }
   ```

   It is shaped like `postIntegration`, and the candidate's declaration applies.
   The target follows the integration branch, so the step runs in an exact source
   view of the local integration branch, read once it holds the target lease (the
   newest commit a landing has finalized against the target), not of the
   candidate. The view has no dependencies installed (the command bootstraps what
   it needs). The step gets the sanitized environment plus `environmentKeys`,
   `SLIPJAY_RELEASE_CANDIDATE`, `SLIPJAY_RELEASE_MERGE`, `SLIPJAY_RELEASE_SOURCE`
   (that integration commit) and `SLIPJAY_RELEASE_TARGET`. Its output goes to an
   owner-only log under `~/.slipjay/state/post-release`, never into the result,
   because it may echo the secrets it was given. To say why it failed, the step
   may write one short line to the file `SLIPJAY_RELEASE_REASON_FILE` names; the
   result's `reason` carries that line (first line only, control characters
   removed, at most 300 characters), so it must hold no secret. Its `targetProbe` must print `{"target": …}` equal to
   the declared `target` first. It holds the same target lease as landing's
   `postIntegration` step for that target, so a landing finalizing against it waits
   (up to about 20 minutes) until the step is done, and vice versa. `timeoutMs` may
   be up to 15 minutes. It runs only after the release has published, never on a
   refused or failed release, and its failure never undoes the release: the result
   is still `"released"` with `postRelease: { "ok": false, "reason": …, "retry":
   "slipjay release --confirm <candidate>" }`, and the command exits 2. A plan
   reports a step that did not complete as `pendingPostRelease`, and a later
   `--confirm` of an already released candidate reruns it instead of skipping it.

`land` and `release --confirm` each append one line to
`~/.slipjay/state/metrics/landings.jsonl` or `releases.jsonl`: stage durations in
milliseconds (`queued` is time waiting for another landing's slot), the outcome,
and for a release its verification time.

A release whose range carries migration artifacts also needs `--migrations-ready`:
apply those migrations where the release branch deploys first. slipjay never
migrates a release environment itself.

## Library

```js
import { createWorkspace, landWorkspace, workspaceContext } from "@pechhe/slipjay";
```

`@pechhe/slipjay` and `@pechhe/slipjay/delivery` export the same public entry,
`src/lib/slipjay.ts`, which Bun imports directly (there is no build step). It covers
workspaces, landing and its verification, repository policy and post-integration
finalization, plus the process and text utilities that hosts share. Other
modules under `src/lib` are internal, and `bun run check` enforces that the
`src/` closure imports only itself, Node built-ins, `effect` and `proper-lockfile`,
with no runtime cycles (type-only imports are not edges). A host that brokers child processes injects its broker with
`setProcessBroker`. Before the cutover, any library call that reads or writes
state rejects with an error whose `code` is `SLIPJAY_CUTOVER_REQUIRED`;
`cutoverPending()` reports that state and `cutover()` runs the cutover.

## Development and landing

slipjay lands its own changes through `slipjay land` from an isolated JJ workspace, under its own
`slipjay.json`.

If a concurrent publisher leaves the integration bookmark conflicted after an
isolated landing, rerun `slipjay land` from that preserved workspace. Recovery
accepts only its exact recorded artifact and the declared remote's published tip,
with matching committed policies and an unchanged workspace. It retains the
earlier receipt, takes the published tip as the base, and rebases and verifies the
candidate again before publication. Extra heads, policy disagreement or later
workspace edits require reconciliation. An interrupted recovery remains retryable.
Verification checks run with the working-copy revision on the exact candidate,
including retries that started on an empty continuation child.

- **Per landing**, the fast static gate runs: `bun install --frozen-lockfile`,
  `bun run check` (Oxlint and the closure boundary) and `bun run typecheck`. No
  test suite runs per landing.
- **At release**, `bun run verify:release` runs the complete suite (`bun run test`)
  against the exact commit to be tagged. It prints that commit and exits non-zero
  on failure. Tag only a commit it passed. To trace a release failure to its
  landing, bisect `<last tag>..main` and read the commit's `Issue:` trailer.

Every Vitest file runs under its own disposable `HOME`
(`scripts/vitest-hermetic-env.ts`). `scripts/hermetic-home-guard.ts` fails a test
that would otherwise write the real `~/.slipjay` or `~/.pi`. The cutover tests build
pre-v1.0.0 state in that disposable `HOME` and never touch the real one. Run a single file with
`bunx vp test tests/<file>.test.ts`.
