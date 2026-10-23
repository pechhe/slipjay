# SlipJay

Harness-neutral JJ workspace and landing tool. One tagged artifact is both the
`slipjay` CLI and a library, written in TypeScript and run by Bun (1.4 or later),
its only runtime.

SlipJay was extracted from `pechhe/peach-pi` at `37a32367` as `peach-workspace`,
became Slipway in v1.0.0, and is renamed to SlipJay in v2.0.0. It uses the
`slipjay` CLI, `slipjay.json` config, `SLIPJAY_*` environment names, and state
under `~/.slipjay`. See [CHANGELOG.md](CHANGELOG.md) and [State and cutover](#state-and-cutover).

## State and cutover

| What | Location |
| --- | --- |
| Landing state, locks and post-integration records | `~/.slipjay/state` |
| Checkout mode (`slipjay mode`) | `~/.slipjay/mode.json` |
| New isolated workspaces | `~/.slipjay/workspaces` |
| Removed checkouts awaiting deletion | `~/.slipjay/trash` |
| Cutover record | `~/.slipjay/cutover.json` |

In v2.0.0, `slipjay cutover` moves state from `~/.slipway` to `~/.slipjay` once. The
package exposes only the `slipjay` command. On a machine that still has `~/.slipway/state`,
every command except `status` and `cutover` refuses until the cutover has run.

`slipjay cutover`:

1. Refuses, naming each holder, while any landing transaction, verification slot
   (or a landing waiting for one), Direct primary-checkout writer, post-land run or
   post-integration run that a pre-v1.0.0 Slipway left is held or live. Nothing changes.
2. Moves `~/.slipway/state` and `~/.slipway/mode.json` to `~/.slipjay`, by rename,
   or across devices by copy, verify, then delete. Existing workspaces stay at
   `~/.slipway/workspaces/...` or the older `~/.pi/workspaces/...` and keep working
   through landing, cleanup and safe recovery; new workspaces go to
   `~/.slipjay/workspaces`. A preserved checkout without `slipjay.json` gets branch
   protection from its JJ repository's primary checkout's canonical policy.
3. Writes `~/.slipjay/cutover.json`. Running `slipjay cutover` again is a no-op.

`slipjay cutover --check` reports what would block or move without changing anything.

Never sync `~/.slipjay/state` or `~/.slipjay/workspaces` between machines: they
are per-machine lock stores.

## Repository config

A repository's landing policy is `slipjay.json` at its root. It is the only
configuration filename read by the CLI and landing guard. Former filenames are
ordinary files and declare neither landing checks nor guarded branches. Migrate a
repository's configuration before using it with SlipJay. The earlier retired path `.peach/execution.json` is no longer read.

Workspaces are named by a project code: `projectCode` in `slipjay.json` (2-8
lowercase letters or digits) when declared, else two letters derived from the
checkout folder (`peach-pi` → `pp`, `slipjay` → `sl`). Declare it when the folder
name may change, so existing `ys-412`-style names stay stable.

### Settings

Three `slipjay.json` fields are settings: `spares` (see [Workspace options](#workspace-options)),
`process` and `requiredLandingVerification` (the gate). Change them with `slipjay policy set`
rather than by hand, and this machine's own settings with `slipjay config`.

- **`process`.** `"standard"` (the default when absent), `"light"` or `"development"`: how much
  process agents apply to the repository's work. Agents read it through `slipjay policy show`;
  `development` implies everything `light` does. Only `development` changes SlipJay: the runner
  then promotes by itself (see [Release](#release)). Any other value is refused, and an unreadable
  policy is an error, never `light` or `development`.
- **Retired fields.** `parallelExecution` and `unattendedMergeToIntegration` drive nothing. A
  policy that still declares them loads; `land` and `policy show` print a one-line warning to
  stderr (other commands stay quiet), `policy show --json` lists them as `retired`, and
  `policy set` drops them.
- **`slipjay policy show [--json]`.** The policy committed on the integration branch, read the
  way landing reads it: the integration branch, the `revision` it was read from, the policy's
  `digest`, the file as `declared`, the `settings` in force with defaults filled in, and any
  `retired` fields. It reads the local integration bookmark, so fetch first to see another
  machine's change.
- **`slipjay policy set --base <revision> [--spares <n|default>] [--process <standard|light|development|default>] [--landing-verification <json|default>] [--patch <json>] [--json-lines]`.**
  Applies a patch of those three fields (`default`, or `null` in `--patch`, removes one) to the
  policy at `--base`, the `revision` from `policy show`. Any other field is refused. If the
  integration branch's policy has changed since that revision, the patch is refused as stale, so
  two saves from one read never overwrite each other; its commit carries a `Policy-Base:` trailer
  with the base's digest, and the runner refuses it as stale too if the policy moved before it
  reached the queue. The change is made in a workspace of its own on the integration tip (never
  the primary checkout) and lands through the normal queue. It prints one JSON object whose
  `phase` is `refused` (nothing submitted, exit 2: this includes a usage error, a malformed
  `--patch`, no runner location, a failed fetch, a stale base, a runner that cannot be reached
  and one that refuses the submission; a fresh attempt's workspace is then removed), `already-applied`, `landed`,
  `rejected` (the runner refused or failed it before integration; nothing changed),
  `failed-after-integration` (integrated, but finalization or publication has not finished; the
  runner retries it) or `uncertain` (rerun the same command: it reattaches to the attempt it made
  and never submits twice). A rerun never submits an attempt again: it follows the attempt's
  operation, reports its last outcome, and reports `already-applied` once the policy is on the
  integration branch. Success exits 0, `refused` exits 2, and every other outcome exits 1.
  With `--json-lines`, stdout is one compact JSON object per line instead: a
  `{"phase":"following","operationId":"…"}` line as soon as the change is submitted or a rerun
  reattaches to its operation, so a caller can show the operation's queue position and stage
  while it waits, and the outcome object above as the last line.
- **Runner version.** The fast path below and the runner's stale refusal need a runner on
  SlipJay 3.25.0 or later. An older runner ignores the `Policy-Base:` trailer and gates a
  settings landing with the full checks; only the client's own stale check then applies.
- **The settings fast path.** The runner gates a landing with the integration branch's current
  checks, not the candidate's, so a changed check would otherwise first run on the next
  landing. When a rebased candidate's only difference from its integration base is
  `slipjay.json`, and the two policies match outside the settings fields (and retired fields),
  the runner skips `requiredLandingVerification`: it checks the new policy loads, and that every
  check's executable (and capability probe's) resolves on the runner host, then records a
  `verification_skipped` event with the changed fields and the reason. Preparation, barriers,
  finalization and publication are unchanged. It decides again for every prepared candidate, so
  after any rebase. Anything else, including an edit that also touches a migration,
  post-integration, deployment, reset or release field, takes the normal route. **What it does not
  prove:** that a new or edited check passes. That is first shown when a later landing runs it;
  a broken check blocks the repository's landings until it is fixed, which the same fast path
  can do.
- **`slipjay config [--json]`, `config set runner <location>`, `config set spares <0-8> [--repo <path>]`, `config unset <runner|spares> [--repo <path>]`.**
  Reads and writes `~/.slipjay/config.json`, keeping its other keys. `--json` reports `runner`
  (`value`, `source`: `environment`, `file` or `unset`, the `file` value, and whether
  `SLIPJAY_RUNNER` overrides it) and, for the current repository and each one with a limit,
  `declared`, `machineLimit` and `effective` spares. A spare limit only lowers the declared count
  and the next refill applies it; `--repo` defaults to the current repository's integration
  checkout. Changing the runner location does not move or cancel operations already submitted:
  from an assigned workspace, `land` keeps following each on the runner that may hold it,
  including one that failed at or after integration while its publication is unresolved (a
  submission the runner refused is not pinned, so a retry goes to the current location), and
  from the primary checkout (`land --direct`) it uses the current location. `runner log`, `outcome`,
  `handoff`, `source` and `artifact` read an operation this machine submitted from that runner.

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

### Generated output and evidence

Retiring a workspace never deletes a file that no history holds: an untracked or
ignored file keeps the checkout (`unique-files`), except where the repository
says what it is. Two `slipjay.json` declarations, read from the policy
committed on the integration branch (as the spare allowance is, so a stale or
unlanded local edit on one host changes nothing there), take repository-relative paths or globs (`*` within one segment, `**`
across segments); a match covers everything below it:

```json
{ "generatedPaths": [".t3/userdata", "apps/*/dist-electron"], "evidencePaths": [".t3/review"] }
```

- **`generatedPaths`**: disposable build, preview and runtime output, deleted
  with the checkout when it retires. The sweeps and the landing's own cleanup
  retire a checkout only once no live process works in it; an explicit
  `cleanup` or `remove` does not wait.
- **`evidencePaths`**: review, acceptance or recovery evidence. Just before a
  checkout is forgotten, `retireWorkspace` copies its untracked files there
  into `~/.slipjay/state/evidence/<workspace>-<time>/files/` with a
  `provenance.json` naming the workspace, repository, Issue, task,
  working-copy commit and landing artifact, and each file's size and SHA-256
  (symbolic links are recorded with their target, not followed; sockets and
  FIFOs are listed as skipped). The copy is written as `<name>.partial` and
  renamed once complete; the workspace's next retirement removes an
  interrupted one. Evidence over 64 MiB, or that cannot be copied, keeps the
  workspace with the reason, and so does evidence that changes during the
  copy (its copy is then removed). The preserved directories are kept until
  deleted by hand.

Nothing is disposable by default: not `.t3`, patches, or other ignored files.
A file that appears while a checkout is being retired keeps it
(`working-copy-changed`). The runner's own retained landing evidence (source,
handoff, artifacts) expires on its separate schedule; see [Runner](#runner).

### Workspace options

Optional `slipjay.json` fields for the workspace pool and shared output:

| Field | Meaning |
| --- | --- |
| `spares` | Integer 0-8, default 1. How many prepared spare workspaces the pool keeps; 0 disables the pool. A refill tops the pool up one spare at a time, counting spares still being prepared, and holds the pool lock only to count and register a name, never during the dependency install, so a claim always takes any ready spare even while another is installing. Every new workspace `start` makes, a claimed spare or a fresh one after a miss, also starts a background refill, so a burst of starts finds the pool replenished and an empty pool fills itself. An idle spare costs nothing at landing. A machine can lower (never raise) a repository's count: `spares` in `~/.slipjay/config.json` maps integration checkout paths to counts, such as `{ "spares": { "/Users/me/Engineering/yardsmith": 2 } }`, and `0` disables the pool on that machine (the next refill retires spares beyond the count); `slipjay status` and `slipjay config` report the count in force with the declared and machine values and the `source` of the declared one: the integration branch and the commit whose committed `slipjay.json` was read. That is the integration bookmark as of the last fetch (every `start` fetches it before the refill it starts), never the primary checkout's working files, so an unlanded or stale local edit cannot change the allowance, and both hosts reach the same count once each has fetched. A machine limit applies to its checkout by real path, so a symlinked or differently spelled path still matches, and a spare whose record names a checkout path that no longer exists still counts against the allowance while it is one of the repository's workspaces. Retiring assigned workspaces never takes a spare. When the pool is short and no abandoned spare waits, retiring an assigned workspace instead makes the next spare from it: a new workspace, at its own path on the integration head, receives the retiring checkout's `node_modules` trees by rename once retirement's last checks pass (a checkout whose forget then fails gets them back), and the refill this starts installs over them in place, so a spare costs an incremental install rather than a full clone and install. One repository's refills run in turn, and refills of every repository on one machine install one at a time, holding that machine-wide lock only for each install, so repositories take turns between spares; claims never take either lock. Spares are not moved to each new integration head: a claim runs `jj new` on the head itself and keeps the spare's dependencies when the install inputs there are the ones they were installed for. After topping up, a refill refreshes one spare only when no ready spare recorded the head's install inputs (read from the head's commit), so a landing that changes them costs one install per refill, not one per spare: that spare moves to the head and installs over its existing `node_modules` in place, which changes only what changed. The others are refreshed in place when claimed, or one at a time by later refills. A claim takes the most recently prepared spare first. A start's installs into one repository's checkouts run one at a time on a machine, so a second waits for the first and clones its result; a start never waits for a refill's install. |
| `tracker` | `"github"` (default) or `"forge"` (a repository still declaring `"build"` keeps working until that value is removed): where the repository's work items live. With either of the two, the numbers `start --issue` and `attach-issue` record are HQ Forge numbers: a landing names its item in a `Forge: #N` trailer (instead of `Issue: owner/repo#N`), a landing with no description takes the item's title from Forge, `prune --empty` and the landing sweep treat a workspace whose item is closed (landed, accepted, dropped, achieved, superseded or imported_closed, or any `legacy` item) as delivered, and `land` writes the landing's Forge handoff itself (see `land`). Forge is read only through the runner (see [Forge reads](#forge-reads)); when it cannot be read, the title falls back to the task, a workspace is kept, and promotion says it could not check. |
| `sharedPaths` | Array of repository-relative directories (at most 20; literal paths, no globs, none inside another, none in `.jj`/`.git`). Each workspace gets a symlink at that path to the same path in the primary (integration) checkout, which is created when missing. The link is made when a workspace is started, resumed or claimed and when a spare is provisioned. An existing real directory is replaced only when empty; with content it is left alone with a warning. Cleanup ignores a link into the primary checkout, so git-ignored output such as `artifacts/` no longer keeps a landed workspace. List the path in `.gitignore`, or jj snapshots the link as source (slipjay warns). |

When a new workspace has no spare to claim, or a spare is provisioned, and it has
no `node_modules`, slipjay first clones the `node_modules` trees of a prepared
spare (or of the primary checkout) whose install-input fingerprint is identical,
with copy-on-write clones (`cp -c` on macOS, `--reflink=auto` on Linux; bun links
with relative symlinks, which are copied verbatim, so the copy resolves inside its
new checkout). The normal frozen install still runs afterwards as the
verification, and if it fails on a cloned tree, the clone is discarded and the
install repeated from scratch. Existing `node_modules`, however stale, are installed
over in place and never replaced by a clone: in a large repository, deleting and
cloning the tree takes minutes, while an incremental install changes only what changed.

Each spare a background refill provisions is one line in `pool-refill.log` (in the state home), so the log alone
shows how often spares come from handovers rather than clones, and what each cost, per repository:
`{"provisioned":true,"workspacePath","name","project","integrationRoot","dependencySource","dependencyMs"}`, with
`cloneMs` when the source is `clone`. `dependencySource` is `handover` (a retiring checkout's `node_modules` were
moved in, then verified by an install over them), `clone`, `install`, or `none` (no dependencies needed);
`dependencyMs` is the whole dependency step, verifying install included, timed once the machine's refill lock is held, so a
wait behind another repository's refill is not counted. A foreground `slipjay pool refill` prints the same lines to stdout
instead. The log starts afresh when background work starts with it over 1 MiB, so its counts cover the time since then. When a retiring checkout's trees move to a
new spare, that move is its own line, `{"handover":true,"project","integrationRoot","from","workspacePath","name","trees","moveMs"}`,
before the spare's provisioning line. A claim that keeps its spare's dependencies because the install inputs are
unchanged provisions nothing, so it logs nothing here.

The install-input fingerprint covers what a frozen install reads: lockfiles,
package-manager configuration, patches, the files install lifecycle scripts reach,
and each installed `package.json` less its metadata and publishing fields
(`version`, `description`, `exports`, `types`, `files` and the like) and the
scripts an install never runs. A release bump, a new export or a new test script
therefore leaves a spare's dependencies reusable.

`land` runs that frozen install again after rebasing the candidate, before any
migration generation or verification, so the gate sees the dependencies of the
integration tip it verifies against rather than the one the workspace was
allocated from. An install that edits tracked source is undone and fails the
landing.

## Environment contract

| Name | Set for |
| --- | --- |
| `SLIPJAY_WORKSPACE_NAME`, `SLIPJAY_WORKSPACE_PATH` | The `workspaceTeardown` command. |
| `SLIPJAY_MIGRATION_CONTEXT` | Late-bound migration generation and verification commands. The same trusted JSON provenance record is bound before generation; see below. |
| `SLIPJAY_BUILD_CONTEXT` | A Forge-bound landing's `requiredLandingVerification` and migration `generate`/`verify` commands: its admitted Forge binding (see [Forge access for checks](#forge-check-access)). |
| `SLIPJAY_BUILD_READ_URL`, `_TOKEN` | The same commands, for every landing of a Forge-tracked repository on a runner with a Forge connection: read-only Forge access for this operation only (see [Forge access for checks](#forge-check-access)). |
| `SLIPJAY_FINALIZATION_COMMIT`, `_KEY`, `_TARGET` | Post-integration finalization commands and target probes. A policy's `environmentKeys` may not start with `SLIPJAY_FINALIZATION_`. |
| `SLIPJAY_RESET_TARGET`, `_SOURCE`, `_REASON_FILE` | The runner's `reset` command and target probe (see [Reset](#reset)). A policy's `environmentKeys` may not start with `SLIPJAY_RESET_`. |
| `SLIPJAY_TEST_REPORT_DIR` | Each gate command on the runner. It also tells a test it is running in a landing on the runner: the systemd containment tests fail there, not skip, when the user systemd is missing. |

Every workspace allocation, Issue workspace recovery included, schedules a detached sweep of the repository's unused empty and delivered workspaces, at most once every 15 minutes, counted from each attempt so a failing sweep is retried no faster; `SLIPJAY_AUTO_HOUSEKEEPING=0` turns that off (`slipjay prune --empty` still sweeps on demand). An unused empty workspace, of a closed Issue or of none, is kept for 10 minutes after it was last assigned, so a just-resumed or repair checkout survives the sweep its own allocation starts. Removing a workspace, by any path, moves its checkout into `~/.slipjay/trash` and returns; a detached process at the lowest CPU priority deletes it, one at a time on the machine, and each sweep restarts that deletion if a crash interrupted it. Each sweep's outcome is one line in `pool-refill.log` in the state home, the log the spare refill and start metrics also append to.

slipjay reads `SLIPJAY_COMMAND_TIMEOUT_MS`, the per-command timeout for jj, git
and gh. The pre-v1.1.0 Peach environment names are neither set nor read.

When migration-owned paths change, `SLIPJAY_MIGRATION_CONTEXT` contains
`{ "version": 1, "repository": "owner/repo" | null, "baseCommit": "…",
"candidateCommit": "…", "candidateChangeId": "…", "issueNumber": 123 | null }`.
The base is the integration commit used for the final rebase. The candidate is
that rebased source revision before generated artifacts, so generation and
verification receive identical provenance even after generation changes the
working copy's commit. The remaining command environment is resolved afresh for
each step; SlipJay overwrites any inherited `SLIPJAY_MIGRATION_CONTEXT` without
mutating the caller's environment object.

Repository identity comes only from the configured publication remote (default
`origin`). A missing or non-GitHub remote supplies `repository: null` and
`issueNumber: null`; SlipJay never substitutes another remote. For a GitHub
repository, the existing commit-description parser reads a matching `Issue:`
trailer, closing reference or `(#N)` title reference. Missing, unrelated or invalid
Issue references supply `issueNumber: null`. Raw remote URLs, credentials and other
environment values are not included. This record supplies provenance to migration
consumers; it grants no mutation authority and does not replace credentials. A
consumer requires a SlipJay version that implements this environment contract.

## Install

Releases are git tags. Nothing is published to npm.

```sh
bun add -g github:pechhe/slipjay#v3.42.0
slipjay status
```

To upgrade, remove the installed tag first, since `bun add -g` (even with `--force`)
keeps it otherwise, and check the version:

```sh
bun remove -g @pechhe/slipjay && bun add -g github:pechhe/slipjay#<tag>
slipjay --version
```

On a runner host, restart the unit afterwards (`systemctl --user restart slipjay-runner`): it finishes any integration
in flight first (see [Runner](#runner)). That needs a release with the #3360 fix and the unit `scripts/setup-runner.sh`
now writes; until a host has both, wait until `slipjay watch --json` shows nothing running.

Never clear Bun's package cache (`bun pm cache rm`) to upgrade: projects that set
`globalStore = true` link every checkout's packages into it, so clearing it breaks
their dependencies. When a workspace's dependencies are damaged that way, `slipjay start`
and landing say how to repair them.

From Slipway, remove it first (`bun remove -g @pechhe/slipway`) and run
`slipjay cutover` once after installing.

The repository is public, so the `github:` tag form needs no authentication.

## CLI

`slipjay <command>` runs the workspace and runner commands below. It also provides
what a Claude Code `WorktreeCreate`/`WorktreeRemove` hook needs without library
imports (`start --integration --issue <n> --json`, `remove <path>`):

| Command | Effect |
| --- | --- |
| `status` | Mode, current workspace and its Issue, integration checkout, landing state and this machine's spare count (JSON). |
| `config [--json]`, `config set\|unset <runner\|spares> …` | This machine's runner location and spare limits, each with its source (see [Settings](#settings)). |
| `policy show [--json]`, `policy set --base <revision> …` | Read the integration branch's policy, or land a change to its settings fields without running the landing checks (see [Settings](#settings)). |
| `landed <path>` | The landing recorded for the workspace at exactly that path, even after it was removed, as one JSON line (`workspaceName`, `workspacePath`, `artifactCommitId`, and `operationId`, `issueNumber`, `landedAt` when recorded), or `null`. Read-only. |
| `mode [isolated\|direct]` | Read or write the checkout mode. |
| `list` | Workspaces with their state, Issue and retained material. |
| `pool [refill]` | Show ready spare workspaces, or provision one (up to `spares`). |
| `prune --empty` | Remove empty workspaces, empty workspaces of a closed Issue, and state left by workspaces that no longer exist. A registered workspace whose checkout is gone from disk is forgotten when its revision holds no unlanded work; one whose working copy JJ cannot read is kept, with how to recover it. Directories in workspace storage that no repository lists (a forgotten checkout, one whose repository is gone, one with no JJ identity) are removed only when they hold nothing but reproducible output, are over an hour old and no live process uses them; any other is kept and named. |
| `prune [--empty] --plan [--json]` | Change nothing; list every workspace of the repository with its path, state, Issue, task, assignment time, landing (and whether it is published, as of the last fetch), live processes, unique files and size, and whether the automatic sweep (or, with `--empty`, `prune --empty`) would remove it now and why not. It shares the sweep's decisions but snapshots no working copy, fetches nothing and finishes no landing, so an edit since a checkout's last snapshot, a checkout missing most of its tracked files (see `remove` below), a landing's pending housekeeping and an unreadable fact (an Issue state the tracker cannot report, metadata that cannot be parsed) each keep the workspace, with that reason. States are `integration`, `spare`, `unlanded`, `landed`, `empty`, `missing` (registered, checkout gone from disk), `broken` (JJ cannot read its working copy) and `orphan` (a directory in workspace storage no repository lists; its `repository` is the one it names, or null). |
| `attach-issue <n>` | Bind the current workspace to Issue `n` (a Forge number in a Forge-tracked repository; see `tracker`). |
| `start "task"` | Assign an isolated workspace for a task and print its path. An empty, undescribed change is described `wip: <task> (#<n>)` so abandoned work is never anonymous; landing replaces exactly that generated text (recorded in the workspace metadata) with the Issue title or task, never publishing it; a description you write, `wip:` or not, lands as written, and a stack with the placeholder left on a lower commit is refused. A new workspace is based on the integration branch freshly fetched from the declared remote (best effort: offline, it starts from the local branch). The fetch runs before the start takes the repository's allocation lock, and starts within 30 seconds of a fetch, or arriving while one runs, share it, so concurrent starts never queue behind each other's fetch. |
| `start [--integration] [--issue <n> \| --base <revision>] [--attempt <id>] [--refill] [--json] ["task"]` | `--integration` allocates from the integration checkout even inside a workspace; `--issue` creates or resumes that Issue's workspace (the task defaults to `Issue #<n>`), except that `--integration --issue <n>` run from the caller's own isolated workspace, when it has no Issue, holds no work and the Issue has no workspace to resume, is refused and names `slipjay attach-issue <n>`: a host such as T3 Code allocates each session's workspace when the session starts, so an Issue attaches to that workspace rather than taking a second; `--base` (implies `--integration`, no `--issue`) starts a new workspace, a claimed spare or a fresh one, on that revision of the current checkout instead of the integration head, so a helper sees a lead's unlanded work; it must name one commit other than the caller's working copy (`jj new`, then pass `@-`), and dependencies are reused unless that revision changed the install inputs; `--attempt <id>` records the start as that allocation attempt (see `attempt`); `--refill` then starts a background spare refill (a new workspace always does); `--json` prints one JSON object (`workspacePath`, `workspaceName`, `integrationRoot`, `issueNumber`, `created`, `reused`, `pooled`, `refill`, `steps`, and `attemptId` when given; `steps` gives the milliseconds spent in each step this start took, each exclusive of the others: `fetch` the integration fetch, `claim` taking a spare, `jjNew` moving it to its base, `fingerprint` computing install inputs, `install` making dependencies ready, absent when a claimed spare's are reused, `describe` the working-copy description) and sends all install output to stderr. With a runner configured, the start's metrics (`workspace_start`, `pool_claim`) are posted to its ledger by a detached process, so a slow or unreachable runner never delays the start; a failure is one line in `pool-refill.log`. |
| `attempt show <id>` \| `attempt release <id>` | Recover a start a caller never got the result of. `start --attempt <id>` (an id the caller chose, such as a UUID, used once) records the attempt before anything is allocated: its status (`allocating`, `preparing`, `ready` or `failed`, with the error), the checkout once assigned, whether the attempt created or claimed it (`owned`) or bound or resumed an existing one, and the start's process, so `show` reports a start whose process died as `interrupted`. That survives a failed dependency install, a lost or malformed receipt, a timeout and a restart of either process. `release` reconciles it: it removes the checkout only when this attempt created or claimed it, no later start has bound or resumed it since, and it has no live process or owner, unlanded work, unique files or undelivered runner facts; a bound or resumed checkout (a resumed Issue's) or one that has gone is kept and the attempt forgotten, any other refusal keeps the attempt so the caller can retry, and a start still running is refused. It prints one JSON object (`released`, `removed`, `reason`) and exits 1 when it refuses. Housekeeping forgets an attempt once its start has ended and its checkout is gone. |
| `repair <failed-operation> [--json]` | Set up a repair of a failed landing from the runner's retained evidence: claim it, restore the exact candidate into a fresh workspace and write a repair brief (see [Repairing a failed landing](#repairing-a-failed-landing)). `--json` prints `operationId`, `workspacePath`, `workspaceName`, `claimId`, `source`, `changeId`, `issueNumber`, `briefPath` and `resumed`. |
| `preview` | Diffstat of what a landing would integrate. |
| `record-preview <port>` | Record a host's started workspace preview in the runner ledger. |
| `metrics [--since <ISO date>] [--repo <owner/name>] [--json]` | Pipeline outcomes and causes; stage, queue and command percentiles per repository and operation kind; each repository's landing verify time against its budgets, and its slowest, growing and over-budget test files; held integrations, attempts and flake candidates, from the runner ledger. |
| `land [--direct]` | Send the current workspace (or, with `--direct`, the primary checkout) to the runner, which verifies, integrates and publishes it (see [Runner](#runner)); without a runner location it refuses. Afterwards it moves the primary checkout onto the new integration, carrying its uncommitted edits along when they apply cleanly; edits that would conflict there, a conflicted checkout and unlanded commits under it stay where they are (`status` reports the outcome as `landing.primaryCheckout`). It removes the landed workspace itself, as `cleanup` would: this process and the session that ran it do not keep it, but any other process with its working directory inside does, and is named with its pid and command (the shell's directory is gone once it is removed, so `cd` to the primary checkout). It also sweeps other delivered workspaces, saying why it kept any. |
| `land [--session <id>] [--ticket <n>]...` | In a Forge-tracked repository (`tracker`), a landing without `--handoff` writes its own Forge handoff, so Forge always learns of it. A workspace with no Forge item lands as a chore (`build: { "unassociated": true }`, titled by the description's first line), and its output says so, naming Forge's number for the chore, the landed revision and `hq_forge_associate_landing` (see [Forge receipts](#forge-receipts)); with `--session` or `HQ_FORGE_SESSION_ID` (formerly `HQ_BUILD_SESSION_ID`) it is refused before submitting, naming `attach-issue <n>`, since a session says the landing is a Spec's. One started with `--issue <n>` (or `attach-issue <n>`) lands as delivery of item `n`'s Spec: `n` itself when it is a Spec, else the Spec of Ticket `n`, which it lists with each `--ticket <m>` of the same Spec. The binding takes the Spec's body revision and its current bind's generation from Forge, and the lead's open Forge session from `--session` or `HQ_FORGE_SESSION_ID` (formerly `HQ_BUILD_SESSION_ID`). Land refuses before submitting when the session is missing (start one with `hq_forge_start_session`), the Spec has no current bind (`hq_forge_bind`), or the item is neither a Spec nor a Ticket; Forge's admission then checks the session and bind itself. A workspace whose item's Spec Build takes no delivery of — it is Landed, Accepted, dropped or imported closed, so a delivery bind would be refused (`bind_status_invalid`) — lands as a chore instead, with or without `--session`, so a fix found in a Landed Spec's own workspace reaches Build there: its output says the Spec took no delivery and names `hq_build_associate_landing`, which attaches the published revision to that Spec. A source review fix that should land as the Spec's own delivery uses Build's `fix` route first: `hq_build_dispose_finding` with decision `fix` creates the review-origin Ticket and returns the Spec to In progress, after which the Spec binds again and `--session <id> --ticket <n>` lands it as delivery. A `--ticket` named for such a Spec is refused before submitting, naming both routes. The handoff is written only for a new submission: rerunning `land` to follow a submitted landing needs neither the session nor Forge, and a retry of a submission still unacknowledged or awaiting Forge admission replays the handoff first written, so Forge changing meanwhile cannot make it unreconcilable. `--session` and `--ticket` cannot be combined with `--handoff`, and need a Forge-tracked repository. |
| `promote [--candidate <commit>] [--confirm <commit>] [--migrations-ready]` | Plan a promotion of the integration branch (or of an older staging-green `--candidate`) to the declared release branch, or have the runner verify and publish the confirmed candidate (see [Release](#release)). |
| `deploy <environment>` | Have the runner deploy the integration branch's latest commit on the remote to a declared environment now, and follow it (see [Deploys](#deploys)). |
| `deploys [--environment <name>] [--json]` | Each deploy, newest first: environment, commit, outcome per project, and the commits it added since the previous deploy. |
| `reset` | Have the runner reset the repository's declared `reset` target now (or follow its open reset) and print the verdict as JSON; exits 0 once it is `reset` (see [Reset](#reset)). |
| `audit [status]` | The repository's nightly audits and what they say: the last green audit, the latest verdict, whether the last green one is overdue, the open failure with its suspects and recorded cause, and the escapes counted (see [Audit](#audit)). |
| `audit cause <landing...\|--flake\|--infrastructure\|--unresolved> [--audit <id>] [--note <text>]` | Record why the repository's failing audit failed: one or more culprit landings (a landing's operation id, or its published commit in full or by 12 or more hex digits), or exactly one of `--flake`, `--infrastructure`, `--unresolved`. It covers the whole open failure, or the failing audit `--audit` names, and lifts the promotion refusal. |
| `cleanup [path]` | Remove the current (or given) workspace once it has landed or all its unintegrated work has archived published adoption coverage. The working copy is snapshotted once and judged; just before the workspace is forgotten it is snapshotted again, and if it changed in between, the workspace is kept (`working-copy-changed`) rather than orphaning the new commit. |
| `adopt <helper-path> [--json]` | From the lead workspace, duplicate the helper's non-empty commits after its recorded start base onto the lead and squash them into the lead's working copy, keeping its description. Records `{ workspaceName, base, revisions }` in lead metadata (printed with `--json`). Refuses unsnapshotted helper edits, merge commits, a base outside the lead's ancestry, changing helper revisions, conflicts (with paths and rollback), or more than 32 adopted revisions per landing. A live helper process does not block adoption. |
| `remove [--discard] <path>` | Remove a delivered or untouched workspace with no unique files; otherwise keep it and exit 1. Published adoption coverage also counts as delivery, including for an Issue-bound helper. `--discard` explicitly confirms deletion of uncovered unlanded work and Issue attachment, including new work after a previous landing. It never overrides pending runner facts, live processes or unique files. A landing record naming another workspace's archived artifact counts as no landing. A checkout missing most of the tracked files its sparse patterns include (an interrupted checkout looks like this, and so does deliberate mass deletion) is named as a partially written checkout, with the missing and expected counts, and is neither snapshotted nor removed by `remove`, `cleanup`, the sweep or `prune --plan`: inspect its last snapshot with `jj --ignore-working-copy -R <path> diff -r @`, restore it with `slipjay start --base <workspace>@` after copying out anything you need, run from another checkout (inside it JJ would snapshot the checkout), or delete it with `remove --discard`. Files outside a sparse checkout's patterns are never counted as missing or edited. |
| `guard` | Claude Code PreToolUse landing guard (reads the tool call on stdin). It denies moving or pushing the integration branch outside `land`, and a declared release branch outside `promote`. In a SlipJay workspace it also denies `jj new`, `jj edit`, `jj checkout`, `jj next`/`prev` and `jj workspace forget` (of the current or any named workspace) while the workspace left or forgotten has a non-empty, unintegrated `@` with no description (or only the generated one), telling the agent to `jj describe`, `jj abandon` or land it; that check runs one jj query in each workspace it would leave, inside that workspace's checkout so its unsnapshotted edits count (by its last snapshot when that checkout is missing or unreadable), and allows the command if jj cannot be queried. Each command is judged by the repository it targets (`git -C`, `jj -R`, else the working directory). |
| `cutover [--check]` | Move historical state from `~/.slipway` to `~/.slipjay` once (see [State and cutover](#state-and-cutover)). |
| `runner <serve\|log <operation>\|kill [<operation>]\|pause\|resume>` | Run the landing runner on this host, print one operation's run log, or use the owner's controls (see [Runner](#runner)). |

## Runner

`slipjay land` sends the change to one long-lived runner; it is the only way a
change lands. The runner queues landings and takes each repository's one at a time
in arrival order by default. For each one it rebases onto the integration tip,
runs the repository's declared gate in its own warm checkout, then integrates and
publishes. A change that contains a merge, such as an upstream update merged into
the integration line, lands as a merge: only its first-parent line moves onto the
tip, and the merged-in history is kept rather than copied, so the integration line
must be the merge's first parent. The authoring machine runs none of the gate.

Before a landing queues, the runner dry-runs its rebase, in a checkout of its own: onto
the integration head, then onto each landing of the repository queued ahead of it, in
order, with no verification. A candidate that would conflict is refused before it waits,
naming the conflicting paths and the queued landing (operation and change id) it clashes
with, or the integration head. A landing ahead that conflicts on its own is left out of
the stack. A probe that fails, runs past 30 seconds, or would start while the repository's
previous probe still runs lets the candidate queue unchecked, and the runner logs why. The probe
runs before admission, so a slow one never delays another repository's submissions. A refused
candidate that would have replaced an earlier one of the same change leaves that one queued, and
the refusal names it so it can be cancelled. Resets take turns in the
same repository's queue. A confirmed release verifies in a release queue and a
checkout of its own, beside the repository's landings, and takes a turn in the
repository's queue only to publish (see [Release](#release)). A release and a reset
of one repository never overlap, and a repository in a shared `lane` verifies its
releases in that lane, since its gates share external state. A pre-verification of a
promotion candidate runs in the release queue like a release (see [Release](#release)):
beside the repository's landings, never beside its reset, and never stopped by either.

Each gate command gets a temporary directory (`TMPDIR`) of its checkout's own, emptied
at each turn, so a lock or file a gate keeps there never makes another operation wait:
the runner's `limits` bound concurrent runs together.

- **Workers.** Different repositories share no checkout, branch, reset target or
  environment, so their queues run at once: at most `workers` of them (runner config,
  default 2; `1` is a single queue for every repository), plus one short landing (below). Without a systemd user
  manager there is no combined budget, so the runner admits one operation at a time,
  runs every command (deploys and concurrent verification stages included) one at a
  time, and refuses to start with `workers` above 1. Repositories whose gates do
  share external state (a database, a deploy environment, fixed ports) must share a
  queue: give them the same `lane` in the runner config's `repos` entries. When the
  rule below leaves no place for it, the next operation of an idle queue waits, oldest
  first, and names what holds the places (`a worker (landing …)` or `every place (…)`); one waiting behind its own queue
  names the running operation, or the release or reset holding it. A release holds a
  worker from verification until it has published. A pre-verification holds one while
  it runs and is admitted in arrival order like a release, so a stream of landings can
  neither delay its start for long nor stop it; the workers bound the total, so it
  never adds a place beyond them.
- **Short landings.** With a combined budget, a landing of a short repository may start
  while other operations hold every worker: at most `workers` operations other than
  short landings run at once, and at most `workers + 1` in all. A repository is short
  when its landings' verify-stage p90 over the last 7 days, from at least 10 landings
  (the `slipjay metrics` budget projection), is at or below `shortLandingP90Seconds` in
  the runner config (default 180); with fewer landings it is not. The class only
  decides admission: a short landing that overruns runs to its outcome under the usual
  deadlines. Releases, resets, audits, pre-verifications, recoveries and depth-two
  successors always count as long. Places go to operations that can start, oldest
  first. A short landing waiting because all `workers + 1` places are full names them
  (`every place (landing …)`); a long one names the long operations holding the
  workers (`a worker (…)`) when they fill them, and every place otherwise. The ledger marks a landing admitted as short (`shortLanding` on its first
  stage).
- **Limits.** On a systemd host every run, deploys included, joins `slipjay.slice`, so
  the workers' gates and everything they start share one cap: `limits` in the runner
  config sets `memoryHigh` (throttled above, default `40G`), `memoryMax` (the hard
  ceiling, `48G`), `cpuQuota` (`1400%`) and `tasksMax` (`4096`). The runner sets them
  as runtime properties at its first run after each start; if systemd refuses, the
  run fails before its command starts. Dependency installation and post-integration
  commands use the same executor and budget as gates and deploys. Each run has a
  slice of its own beneath the runner's, named to its command in
  `SLIPJAY_SYSTEMD_SLICE`: a command that starts a systemd user scope of its own
  (such as a memory-capped check) must pass `--slice="$SLIPJAY_SYSTEMD_SLICE"`, or that
  scope leaves the runner's limits and outlives a kill of the run.

### Optional depth-two verification

A runner repository entry can set `verificationDepth: 2` (default `1`) only when
its gates are safe in independent checkouts, dependency trees and temporary
directories, without shared database writes or other mutable external targets.
This is an explicit configuration assertion about the gate, not an inference from
its repository name. A configured shared `lane` cannot use depth two. The executor
must enforce combined resource limits; an uncapped executor refuses this setting.
Each admitted operation holds one place until its terminal outcome: the head of a
short repository may take the short place, and its successor always counts as long, so
it waits for a worker (`a worker (…)`) even when its own queue could take it. An older
reset, release or audit of its repository holds a depth-two head or successor back, and it names that
operation. Of the repositories SlipJay itself lands, only T3 Code is a candidate: it
runs at depth one until its gates are shown safe in independent checkouts on
`t3peach`, including a controlled pair through its upstream-receipt check.
YardSmith's gates share the Development database, SlipJay's real-systemd tests are not
yet shown safe in parallel, and agent-config's and splay's landings are too short to
gain from it.

For integration D and submissions A then B, the queue prepares immutable CA on D
and CB on that exact CA, in two independent warm verifier repositories. B can
verify while A verifies, but waits outside the publisher lane until A publishes
CA. Only `home/repos/<repo>` integrates, finalizes and publishes. It imports the
artifact before moving any bookmark, checks its exact base and submitted source,
records publication intent, and publishes with JJ's expected-old-remote-ref
precondition. A stale-parent refusal never refreshes the base to accept the old
verification. The integration remains held if finalization or publication fails.

The ledger records each prepared attempt's submitted source, base, candidate,
predecessor and verifier checkout, plus invalidations and publication intent. Runs
name their attempt. Submitted source is duplicated before preparation so a later
attempt never rewrites a retained candidate. Local private refs retain both source
and artifact across slot reuse, independently of JJ's mutable change identifiers;
they are not pushed upstream. Consumers pin their own copies before producer reuse.
These verifier refs are separate from the evidence retention schedule below, which
covers retained submissions, manifests and command artifacts.

A failed, killed or changed predecessor invalidates the dependent, even after a
green gate: its D+A+B evidence is never reused as D+B. Once the predecessor's
outcome is known, the dependent takes one fresh attempt, with a new identity, as the
head on whatever that outcome left: D if A did not publish, D+A if it did. A dependent
stays killable while it waits for that outcome, and a pause that starts meanwhile
stops the rebuild. A remote move before canonical integration permits a head one
fresh attempt of its own, including when a held predecessor publishes under it; a
second move fails. If a held integration still cannot publish, the attempt fails
behind it. An operation's own failure or owner kill, changed author source, or a
paused runner never starts a rebuild. Migration policies, post-integration mutation and reset policies are
conservative preparation barriers, including when introduced by submitted source.
Queued resets and releases fence later prefix admission. Restart retains artifacts,
ends interrupted verifier attempts, and reconciles canonical publication intent
and held state through the existing recovery path.

- **Gate.** `requiredLandingVerification` in `slipjay.json`, an array of commands
  (`{ "executable", "args"?, "cwd"?, "concurrent"?, "stopOnFailure"? }`), run in the runner's checkout.
  Consecutive `concurrent` checks run together. A failed check (nonzero exit, signal or
  timeout) does not stop the gate: every later check still runs, and one failure reports
  every failed check in declaration order, led by an index of each check's outcome (passed,
  failed, timed out, accepted by baseline, capability unavailable, not run). The index and
  summaries are capped at about 24,000 characters; the structured record is complete.
  `"stopOnFailure": true` marks a check that later checks depend on, such as an install or
  a generation step: if it fails, nothing after its stage (its concurrent siblings included)
  starts and the later checks show as not run. Dependency is declared, never inferred.
  Cancellation and infrastructure errors still end verification at once.
  A policy declaring its former name, `requiredLocalVerification`, is refused.
  A policy declaring `postLandVerification` (no longer run)
  is refused; move its checks into the gate or remove it.
- **Location.** One value: `SLIPJAY_RUNNER`, or `"runner"` in `~/.slipjay/config.json`.
  On the runner's host it is `http://127.0.0.1:7787`. Elsewhere it is
  `ssh://<host>`, and `land` opens an SSH port forward for the duration of the call
  (the host must be reachable with key auth). Without a location, `land` refuses.
- **Credential.** A bearer token: `SLIPJAY_RUNNER_TOKEN` in the environment, or else
  the Bitwarden Secrets Manager key of that name, read through `bws`. A lookup that
  fails (`bws` cannot be started, exits non-zero, times out after 15 s, or prints unparsable output) is tried three times; the final error
  names which, never any `bws` output. Another secret holding a raw newline or tab does not hide the token. A request
  without it is refused. The runner binds loopback only.
- **What `land` prints.** One line per stage, naming the runner and the queue
  position. Then a summary: the verdict, the failing command's output verbatim on
  failure, and `slipjay runner log <operation>`, which prints retained operation events from any machine with the location. Interrupting `land` stops following but
  not the landing. Running `land` again in the same workspace reattaches to the same
  operation (or, if it landed meanwhile, finishes the workspace housekeeping, even when the working copy is left empty on integrated history); it never submits twice, and never submits a commit already on the integration branch. While an older commit of the change is running, `land` follows it instead of moving its bookmark, then asks you to land again. Set `SLIPJAY_RUNNER_VERBOSE=1` to see every
  progress line.
- **Transport.** The client publishes the change as the bookmark
  `slipjay/changes/<changeId>` and submits it by jj change ID. The runner fetches it
  on its turn and deletes it when the operation closes. Until the operation has a result
  (a failed or unknown submission included), the client keeps a local bookmark of that name,
  without a remote ref, on the candidate: another workspace that imported the runner's copy
  would otherwise abandon the candidate, and rebase what is stacked on it, when the runner
  deletes the copy. A rerun reaches the original submission's outcome, which retires it, and deletes the
  remote copy it pushed again when the operation had already closed. A submission the runner refuses
  without creating an operation, or that fails before it is sent, holds nothing there: the client deletes the remote
  copy it pushed (unless a newer commit of the change has replaced it) and forgets the local bookmark, so the author's
  later rewrite of the change is not divergent from an imported copy.
- **Commit descriptions.** A candidate published as a stack keeps its commits and
  descriptions. When the runner folds a multi-commit candidate into one
  landing artifact, its title comes from the first commit on the submitted
  first-parent line outside the integration history. That commit's full description
  comes first; later commits' titles and bodies follow in order, separated by blank
  lines. Review fixes therefore keep the feature title, and all bodies and trailers
  remain in the published description. A single commit keeps its description.
- **Migrations and finalization.** Within a change's turn, the runner generates its
  `migrationFinalization` artifacts on the rebased candidate (generation and its
  verification are recorded runs, like the gate), runs the gate, integrates, runs the
  repository's `postIntegration` step (YardSmith: migrate Preview's PostgreSQL), then publishes.
  Because the queue is serial, concurrent migration changes get consecutive numbers.
  The runner host therefore needs whatever that step needs (YardSmith: Docker access to
  its Coolify databases).
- **Held integrations.** If finalization or publication fails, the external target
  may already reflect the integration, so the runner keeps it on its local
  integration branch instead of dropping it, and the failure says so. Every later
  turn first retries finalizing and publishing it (with the same artifact key, so
  the migration is never regenerated), and nothing else lands until that succeeds.
  Relanding the same commit reports it landed once it is published. A restart does not wait
  for a landing: at start the runner queues one recovery turn per repository that still holds
  an integration (a `recovery` operation in its lane, ahead of everything queued after it), which
  finishes and publishes it, so a hold nothing else will touch is cleared without a person.
  Forge keeps a held delivery in its custody until the publication is confirmed and refuses a
  new admission of the Spec meanwhile (`delivery_pending`), so relanding the commit whose
  integration is held follows that recovery turn instead: it ends `landed`, and Forge's
  `published` receipt for the original landing follows from the confirmation. A deterministic
  failure needs a person: `slipjay runner pause` first, so the retries below stand still while
  you work, reconcile the target, then on the runner host move the
  checkout's integration bookmark back to the remote
  (`jj -R ~/.slipjay/runner/repos/<owner>/<name> bookmark set <branch> -r <branch>@origin --allow-backwards`).
  The next recovery turn finds the commit neither held nor on the remote, records
  `integration_released` to clear the hold and ends `cancelled`. A paused runner runs no recovery turn, and
  none is queued after a failed landing until the runner restarts or that commit is landed again, so
  `slipjay runner resume` and land the commit: while the hold is recorded that landing follows a recovery
  turn, which releases the hold and ends `cancelled`. Land the commit once more then, as
  an ordinary submission. A recovery turn that fails (the remote is unreachable, say) is queued
  again after 30 seconds, doubling per failure up to 15 minutes, until it publishes, releases the hold
  or is stopped. Once the hold is released, the runner tells Forge that the landing whose integration it
  was failed unpublished (`failed`, recovering by `code_repair`), which ends Forge's custody: that Spec is
  admitted again with no step in HQ. A landing that fails while retrying an earlier landing's hold never
  integrated its own candidate, so Forge records its failure as ended (`infrastructure_retry`) and admits
  its Spec again at once; land it again once the hold is cleared.
- **Owner controls.** From any machine with the location, `slipjay runner kill <operation>` stops
  that running landing, release or pre-verification while it is still fetching, rebasing, installing or
  verifying (a killed pre-verification is not queued again until staging next deploys that commit
  green), and a reset while it is fetching or resetting: verification's and the
  reset's commands are killed at once (an earlier stage finishes its
  current step, such as an install, then stops before verification), it ends
  `cancelled` with "killed by the owner, not run to completion" (never a pass),
  nothing moves, and the queue goes on. From
  `integrating` on (a release: `publishing`) the kill is refused with exit 1, because
  stopping there could leave the integration target ahead of the remote; it finishes
  on its own. A kill of an operation that is not running (it finished, or has not
  started) kills nothing and exits 1. Bare `slipjay runner kill` stops the only running
  operation; with several running it kills none, exits 1 and lists the
  `slipjay runner kill <operation>` commands; with none it does nothing.
  `slipjay runner pause` makes the
  runner take no next operation: running ones finish, and queued ones show
  `paused` as their stage until `slipjay runner resume`, then proceed in order. The
  pause is recorded in the operation log, so it survives a restart. Each run's
  commands go in their own systemd user slice when the runner has a user manager
  (`XDG_RUNTIME_DIR` set, as under the setup's unit), so a kill or timeout also reaches
  processes a gate tool started in a separate process group or scope within it; the
  slice is cleared after every run, so a gate cannot leave processes behind. The
  slices sit beneath one named for the runner's home, so a runner that was killed
  outright leaves its commands where its next start finds them: recovery stops them
  before it touches a checkout, and does not start if it cannot. A run whose
  processes cannot be shown stopped makes every later command fail until they are.
  Elsewhere, such as macOS, only the run's process group is killed: after every
  command, and at the next start for a command the runner home records as running when
  the runner was killed. Tools that leave the process group are out of reach there.
- **A release that breaks the runner.** The runner runs the SlipJay version
  installed on its host, so a broken release cannot land its own fix. Reinstall the
  previous tag there (`bun add -g github:pechhe/slipjay#v<previous>`), restart the
  runner unit, then land the fix.
- **State.** The runner's own state lives in `~/.slipjay/runner`:
  - `config.json`: the name, the listen port, the repositories, keyed `owner/name` with their git URL,
    and `jj`: settings set as repository config in every warm checkout. It must name `user.name` and
    `user.email`, the identity the runner commits as (use an email GitHub links to the owner);
    the runner also sets `snapshot.max-new-file-size` to 64MiB unless `jj` overrides it, so none of these depend on the host's jj config.
    An optional `build.origin` names the HQ that Forge admission and receipts go to; it takes effect
    only with `YARDSMITH_SLIPJAY_BUILD_TOKEN` in the runner's environment.
    With both, the runner also pushes its metrics export to HQ (see Pipeline metrics relay).
  - `operations.sqlite`: one append-only event log; operations, queue positions and runs are projections of it.
  - `logs/<operation>.log`: the run logs. A reset's step output goes to the owner-only
    `logs/<operation>.reset-output` beside it, never into the log.
  - `repos/<owner>/<name>`: the warm checkouts; `releases/<owner>/<name>`: each repository's release checkout.
  - Finalization receipts and target outcomes stay in
    `~/.slipjay/state/post-integration`. Held-integration retries rely on them; move them with the runner.

  Stopping the runner (`systemctl --user restart slipjay-runner`) first stops admitting work
  and waits for every operation that is integrating, finalizing, publishing or recovering a held integration, and for a
  deploy that is running. The unit's `ExecStop` (`stop-runner.sh`, beside the config) signals only the runner process
  (`bws` does not forward signals, and systemd would otherwise signal the `jj` and `git` commands it started along with
  it), so those commands finish; the unit's `TimeoutStopSec` (15 minutes) bounds the wait, and a second SIGTERM to the
  runner stops it at once. `scripts/setup-runner.sh` writes both and keeps the other settings in `config.json`, such as
  `build`; an existing runner host runs it again to take them. Work before integration is not waited for: it is recorded
  as below. So an upgrade's restart does not interrupt a publication, but only a runner that already runs this behaviour
  under that unit waits: the first restart onto it still stops the old process at once, so wait until
  `slipjay watch --json` shows nothing running. `stop-runner.sh` needs a cgroup v2 host and a `pgrep` with `--cgroup`;
  where it cannot find the runner it fails loudly in the journal, and systemd then stops the whole unit at once, which a
  stop hook cannot prevent, so the idle check above is the only guard there.

  On restart, queued operations resume. A landing that was running is recorded as
  landed if its commit already reached the remote, and as failed ("land again")
  otherwise. A release that was running is recorded as failed with the
  `slipjay promote --confirm` command that reruns it. A pre-verification that was
  running is queued again; one whose green staging deploy was recorded without it is
  queued then. A reset that was running is
  recorded as failed ("run slipjay reset again"); the schedule waits a full interval
  after it. An audit that was running is recorded as interrupted (cancelled), and the schedule
  submits it again. A deploy that was running is
  recorded as failed, and the schedule deploys that commit again; a production
  deploy's failure names the `slipjay promote --confirm` that deploys it again. A
  restart can stop a promotion's deploy between activations: projects it already
  activated keep serving it, nothing moves them back, and its migrations may have been
  applied, so the rerun is not rolled back automatically if it carries non-additive
  ones (a deploy with no record cannot show the schema untouched).
- **Moving the runner to another host.** Run Setup on the new host with the same
  repositories, give it what their steps need (YardSmith: Docker and its Coolify host), and
  stop its unit. On the old host, `slipjay runner pause`, wait until no operation is
  running and none is held (the last one landed or failed before integrating), then
  stop its unit. Copy `operations.sqlite`, `logs/` and `~/.slipjay/state/post-integration`
  to the new host (warm checkouts are cloned again on first use), start its unit,
  point each machine's location at it (`"runner": "ssh://<new host>"`, or
  `http://127.0.0.1:7787` on the host itself), and `slipjay runner resume`: the pause
  moved with the log.
- **Setup.** On the runner host, with `slipjay`, `jj`, `bws` and `corepack` installed and the
  Bitwarden secret `SLIPJAY_RUNNER_TOKEN` saved:
  `scripts/setup-runner.sh pechhe/YardSmith=git@github.com:pechhe/YardSmith.git`.
  The commit identity comes from `SLIPJAY_RUNNER_USER_NAME` and `SLIPJAY_RUNNER_USER_EMAIL`,
  else git's global user. It writes the config and a systemd user unit that runs `bws run -- slipjay runner
  serve` with `Restart=always`, and enables lingering so the unit survives logout and
  reboot. Logs: `journalctl --user -u slipjay-runner`. The unit's PATH starts with corepack shims
  for pnpm, so each repository installs with the pnpm its `packageManager` pins, whatever pnpm
  is installed globally; re-run the script to add them to an existing unit.
- **API.** Under `/v1`: operations (submit, read, cancel, event stream, log),
  releases (submit), deploys (submit, list) and changes by jj change ID.

### Deploys

A repository can declare environments the runner deploys. `staging` follows the
integration branch; `production` deploys only through a promotion (see
[Release](#release)), never on a schedule or by `slipjay deploy`:

```json
{ "deployments": { "version": 1, "environments": { "staging": {
  "minIntervalMs": 3600000, "timeoutMs": 900000, "environmentKeys": ["VERCEL_TOKEN"],
  "projects": [{ "name": "app", "command": { "executable": "bun", "args": ["scripts/deploy.ts", "app", "staging"] } }]
} } } }
```

- **When.** After each landing, the runner deploys the latest landed commit once
  `minIntervalMs` (default one hour) has passed since the environment's last deploy.
  Otherwise one timer deploys it when the interval ends. It never redeploys a commit
  the environment already has. A commit whose projects failed is retried only on
  demand (`slipjay deploy staging`) or by the next landing. A failure before any
  project ran retries after at least an hour, even with a zero `minIntervalMs`;
  a newer landing follows the normal interval. Cancelling a queued deployment
  prevents scheduled retries of that commit. Scheduling is rebuilt from the log
  at startup.
- **Where.** Deploys take turns in their own lane, so a deploy waiting minutes on its
  build never holds a landing. Each project's command runs, all side by side, in an
  exact source view of the commit (a detached git checkout that borrows the warm
  checkout's objects). It gets the declared `environmentKeys`,
  `SLIPJAY_DEPLOY_ENVIRONMENT` and `SLIPJAY_DEPLOY_COMMIT`, and must finish within
  `timeoutMs` (at most 30 minutes). The last line it prints that is a URL is recorded
  as that project's deployment. A deploy is never killed by `runner kill`, but it
  honours `runner pause`.
- **Health and activation.** A project may declare `healthCheck`, run after its
  deploy with `SLIPJAY_DEPLOY_URL` set to the deployment; a failing check fails the
  project. An environment whose projects all declare `activate` deploys without
  taking traffic: only once every project deployed and passed its check does each
  `activate` (with `SLIPJAY_DEPLOY_URL`) move that project's traffic to its
  deployment. Otherwise nothing is activated and the environment keeps serving what
  it served before. If one activation fails, its traffic state is recorded as
  `activated: "unknown"`. When compensation is allowed, the failing project and
  the projects already activated are
  activated again on the deployment they last served, with `SLIPJAY_DEPLOY_RESTORE=1`
  (a host may move back to an earlier deployment differently from activating a new one).
  A missing previous URL or a failed restore leaves recovery unresolved; a successful
  restore records `activated: false` and `restored: true`. Later projects that were
  never attempted are unchanged. Unknown outcomes cannot establish a future served
  baseline.
  Every activation also receives runner-owned `SLIPJAY_DEPLOY_ROLLBACK_ALLOWED=1`
  when compensation is permitted, or `0` when the promotion's migration policy
  prohibits it. Downstream activation commands must honor this flag before their
  own local compensation; declared environment keys cannot override its authority.
- **Production migrations.** `production` may declare `migrations: { verify, apply }`,
  two commands run in the same source view and environment as its projects. For a
  promotion whose migration files are all additive they run before any project
  deploys, so the health checks run the new code on its own schema (the code production
  serves already fits an added schema); a failure there deploys nothing. Otherwise (a
  non-additive migration, see `nonAdditiveMigrations` below, or a rerun deploy that does
  not know the promotion's files) they run after every project
  passed its check and before any activates, so earlier code runs on the new schema only
  briefly. `verify` exits 0 when the
  database matches the commit, 2 when the commit's migrations are pending, anything
  else to refuse. Only on 2 does `apply` run, and `verify` must then exit 0. Either
  failure activates nothing. The deploy's `migrations` records the promotion's
  migration files and `status`: `current` (nothing to apply), `applied`,
  `verify_failed` (nothing applied) or `apply_failed` (the database may be partly
  migrated, so the promotion is not rolled back automatically). The commands'
  output is redacted of URLs and secret-named variables before it is recorded.
- **Records.** A deploy ends `deployed`, or `failed` with `deploy failed: <project> (<reason>)`.
  Once its projects ran, either way it records the commit, the commit the environment
  served before (the last deploy any project succeeded in), the commits between them,
  and each project's outcome (none when additive migrations failed before any deployed).
  A deploy that failed before its projects ran (the commit
  is not on the integration branch, or the runner restarted) records only its reason.
  `slipjay deploys` reads them back. The contract is `src/lib/runner/runner-contract.ts` (its values) and
  `src/lib/runner/runner-types.ts` (its declarations).

### Reset

A repository can declare an external target the runner rebuilds weekly and on demand,
for example resetting a development database from a scrubbed copy of production. It
never runs at promotion:

```json
{ "reset": { "version": 1, "target": "app-development-db:…", "timeoutMs": 900000, "intervalMs": 604800000,
    "command": { "executable": "bun", "args": ["scripts/reset-development.ts"], "cwd": "app" },
    "targetProbe": { "executable": "bun", "args": ["scripts/probe-development.ts"], "cwd": "app" },
    "environmentKeys": ["NEON_API_KEY"] } }
```

- **When.** `intervalMs` (one hour to 30 days) after the latest reset that ran its
  step, scheduled or on demand, or at once when the repository never had one. A reset
  that failed in its step waits for the next interval; one that failed before it (a
  fetch, a tip that declares no reset) retries an hour later; one the owner killed
  counts as run, so the schedule does not restart it. `slipjay reset` resets now, or follows the open reset instead of
  submitting a second. The schedule reads `reset` at the last landed commit, and is
  rebuilt at startup, after every landing and after every reset. A repository needs an
  `integrationBranch` to declare it, and must have landed on the runner once.
- **Where.** A reset takes its turn in its repository's queue with landings and releases,
  because landings finalize migrations against the same target, and `runner pause`
  holds it like any queued operation. In its turn the runner fetches the integration
  branch and reads `reset` at its tip; a tip that declares none fails the reset. The
  probe, then the command, run in an exact source view of that tip (no dependencies
  installed: the command bootstraps what it needs), with the sanitized environment
  plus `environmentKeys` (from the runner's environment), `SLIPJAY_RESET_TARGET`,
  `SLIPJAY_RESET_SOURCE` (the tip) and `SLIPJAY_RESET_REASON_FILE`. `targetProbe`
  must print `{"target": …}` equal to `target` within 30 seconds, or the command does
  not run. The command must finish within `timeoutMs` (at most 15 minutes).
  `runner kill` stops a reset at once: it moves no branch, and the target's script is
  built to survive a kill.
- **Records.** A reset ends `reset` with its `target` and `source`, or `failed`. The
  command's output can echo the secrets it was given, so it goes only to the
  owner-only `~/.slipjay/runner/logs/<operation>.reset-output`, which the failure's
  reason names. To say why it failed, the step may write one short line to the file
  `SLIPJAY_RESET_REASON_FILE` names; the reason carries that line (first line only,
  control characters removed, at most 300 characters), so it must hold no secret.
  `GET /v1/resets?repo=<owner/name>` lists a repository's resets, newest first.

### Audit

The nightly audit is a repository's complete-run baseline: its own list of commands, run in
full on the exact integration-branch head at a wall-clock time, recording that commit.
Landings and releases keep their checks. Declare it in `slipjay.json`:

```json
{ "audit": { "commands": [
    { "executable": "bun", "args": ["install", "--frozen-lockfile"] },
    { "executable": "bun", "args": ["run", "verify:release", "--full"] } ],
  "timeOfDay": "02:00", "timeZone": "Europe/London" } }
```

`commands` take the shape of `requiredLandingVerification` entries and must list at least one;
`timeOfDay` (24-hour `HH:MM`) and `timeZone` (an IANA name) default to 02:00 Europe/London.

- **When.** Once for every scheduled time on the zone's clock, which follows daylight saving, not
  an interval after the last run. The latest time that has passed is covered once an audit for it
  reached a verdict, green or failing; until then an audit is submitted at once. So a time the
  runner missed (it was down, or the repository declared the audit only now) and a run that was
  cancelled or killed are submitted again at the next opportunity (a queued audit's cancellation
  is one), and several missed times are one run. A failing audit is a verdict: it is not retried before the next time. The schedule
  reads `audit` at the repository's integration head, so a repository audits without any landing
  in the ledger; it is rebuilt at startup and after every landing and every audit.
- **Where.** An audit takes its repository's lane like a landing and waits its turn behind queued
  work. The runner fetches the
  integration branch, resolves the published head, records it (`audit_head`), checks that exact
  commit out and runs the commands in order, with the landing gate's bounds. It leaves the
  integration bookmark alone, so a held integration stays held. `runner kill` stops it while it
  verifies. A head that declares no audit ends the audit `cancelled`.
- **Green.** Only an audit whose commands all ran and passed counts: none skipped (a command
  whose capability is unavailable fails the audit rather than passing it) and none reused. It
  ends `audited` with its commit and commands. A failing command ends it `failed`, as for a landing.
  A runner restart mid-audit records it `cancelled` (interrupted) and the schedule runs it again;
  neither is a verdict.
- **Suspects, then escapes.** A failing audit records its suspects: the landings published, by the
  integration-branch ancestry the ledger recorded (each landing's base and published commit),
  between the last green audit's commit and the failing one, or all of them when none was green
  (or the green one is not an ancestor, when only the landings the two share are left out). Failing
  audits with no green one between are one open failure. Anyone then records its cause with
  `slipjay audit cause`. Only a culprit whose landing passed the landing checks is an **escape**
  (a settings landing, whose checks did not run, is not); escapes are counted per repository, once each.
  Nothing bisects automatically.
- **Promotion.** While the latest audit failed and its failure has no recorded cause (a culprit,
  `flake`, `infrastructure` or `unresolved`), `slipjay promote` refuses at planning, which for an
  audited repository always reads the runner, and the runner fails a confirmed release, asking
  again just before it publishes in case an audit failed while the release verified. A cause lasts until a green audit closes the failure.
- **Overdue.** `slipjay audit` flags a repository overdue when its last green audit finished more
  than 26 hours ago (when it has never been green: since its first audit).

`GET /v1/audits?repo=<owner/name>` lists a repository's audits, newest first, with the summary
above; `POST /v1/audits/cause` records a cause (`src/lib/runner/runner-types.ts`). The ledger reads
are `auditSummary` in `src/lib/release/audit-ledger.ts`.

## Release

A repository that declares a `releaseBranch` in `slipjay.json` promotes its
integration branch to it only through `slipjay promote`:

```json
{ "integrationBranch": "develop", "releaseBranch": "master",
  "requiredReleaseVerification": [{ "executable": "bun", "args": ["run", "check:static"] }] }
```

`requiredReleaseVerification` takes the same command shape as
`requiredLandingVerification`. A release branch without it is refused; declare `[]`
to release without checks. The policy that applies is the one committed in the
candidate. The retired `slipjay release` command refuses with a pointer to
`slipjay promote`; it performs no promotion.

A candidate that declares a `production` deployment is a promotion. The plan reads
the runner: its candidate is the newest commit staging deployed (not the integration
tip), and it lists the paths the release touches. When the owner approved an earlier
candidate that did not ship (its verification failed and a fix landed), the plan's
`delta` and `subjects` show only the commits, paths and migration artifacts since
that approval. The runner refuses to release a commit staging did not deploy. Once
the release branch holds the candidate, the runner deploys production from exactly
that commit in the deploy lane, and `--confirm` follows it: the promotion ends
`deployed`, or `deploy failed: <project> (<reason>)` (exit 1). Rerunning `--confirm`
deploys a failed promotion again and reuses one that deployed.

By default the candidate is the newest staging-green commit. When Preview (staging) runs
newer, unaccepted work, `slipjay promote --candidate <commit>` plans the release of an
older commit instead, and `slipjay promote --confirm <commit>` releases it. It is allowed
only when staging recorded a green (deployed, health-passed) deploy of exactly that
commit, and it is on the integration branch and is not behind the release: it
contains every integration commit the release branch already holds, so it is a prefix of integration history. Anything else is refused with the
reason: a commit staging never deployed green, one that is behind the release or on
another line. Every other rule applies to it as to the newest:
the pre-verification, migrations, an audit refusal, and approval coverage computed against
that candidate. The deploy hooks map a commit to the images built at its staging deploy, so
promoting it ships exactly what staging verified for it. The plan's `candidateSource` is
`newest_green` or `requested`; for `requested`, `newerGreen` lists the newer green commits it
leaves out, newest first. A `--candidate` plan whose commit has no pre-verification asks the
runner to queue one (`POST /v1/verifications`), which neither supersedes nor delays the
newest green commit's; the plan reports it `queued` and a confirm before it passes verifies
as usual. A newer green staging deploy supersedes a queued requested pre-verification like any
queued one, and planning again requests it afresh (a superseded or cancelled one counts as none).
The runner lists the staging-green commits for this (`stagingGreenCommits` of the promotion
state); against an older runner that does not, only the newest green commit can be chosen, and
asking for another says the runner is too old to list older green commits. `--candidate` on a
repository that does not ship by promotion is refused. The runner also checks the prefix rule
itself when it runs the release, and refuses such a commit
before verifying or publishing.

A promotion is verified before anyone approves it. When staging records a green
deploy of a commit, the runner queues a **pre-verification** of it. This runs the
candidate's `requiredReleaseVerification` exactly as a confirm would, in the release
checkout, and publishes nothing. It is admitted like a release, in arrival order: it
starts once staging has finished a deploy of the latest landing (which may be a newer
candidate), no reset of its repository runs and a worker is free, and it neither
waits for the repository's landings nor is stopped by one. Landings, resets and
other repositories' work that arrive later wait for a free place instead of
stopping it, so release verification is never starved by a stream of landings, and the
workers still bound the total load. A release of the same commit waits for the
pre-verification and reuses its pass. So at most one pre-verification runs per
repository. A newer green staging deploy supersedes a queued pre-verification; a
running one finishes. Only a runner restart returns a running one to the queue
(`yielded`). The runner lists them at `GET
/v1/verifications?repo=`.

The plan reports the candidate's pre-verification. It also says whether the earlier
approval covers the candidate:

```json
"verification": { "status": "failed", "commit": "<candidate>", "operationId": "op_…",
  "failedCommand": "bun run verify:release" },
"approval": { "approvedCandidate": "<earlier candidate>", "covered": false,
  "reasons": ["4f0c2a9e1b7d (Add exports) names Forge: #2961, which the approved range does not"] }
```

- `verification.status` is `queued`, `running`, `failed` (with the `failedCommand`
  when a check failed), `passed`, or `none`. `passed` means the candidate's newest
  pre-verification passed against the current release base with the checks the
  candidate declares. A pass against an older base or other checks counts as `none`.
  `operationId` is null for `none`.
- `--confirm` of that candidate reuses a `passed` pre-verification. It skips
  installing and verifying, still rechecks the release base before publishing, and
  its result's `verification` is `{ "preverified": "<operationId>" }`. Otherwise it
  verifies as described below.
- `approval.covered` is true only when the owner approved an earlier candidate that
  has not shipped, and both of these hold:
  - no commit since it adds or changes a file under
    `migrationFinalization.artifactPaths`;
  - every commit since it names no work item, or only items the approved range
    (`base..approvedCandidate`) already names. Work items are read from `Forge: #N`
    and `Issue:` trailer lines.

  A re-ask of exactly the approved candidate is covered. `reasons` names each rule
  that failed and the commits involved. It is also non-empty when there is no such
  approval, when the candidate does not descend from it, or when SlipJay cannot
  compare them. When coverage holds, `next` says so. SlipJay decides no authority.
  `covered` is a conservative signal that the earlier yes saw everything that
  matters. Whether to act on it is the approver's policy.

Both fields appear on promotion plans that have commits to release.

**Automatic promotion (`process: "development"`).** When the policy committed on the release
branch, at the base the pre-verification ran against (never the candidate's policy), has
`process: "development"`, the runner queues a release by itself of the newest green candidate
whose pre-verification passed, looking back no further than the newest commit already released or
tried. A newer green commit that is still verifying, or whose verification failed, does not hold it
back, so a stream of landings cannot keep every verified commit from shipping; the newer commit
ships in turn once its own verification passes. It is the release `slipjay promote --confirm`
submits, in the same release queue, so landings, resets and releases keep their order, and it reuses
the passed pre-verification. The release, its production deploy and the `slipjay promote --confirm`
and `slipjay deploys` output carry `automatic: { "setting": "process", "value": "development" }`, and
the runner log says `promoting <commit> automatically`. The safeguards stay: nothing is promoted
automatically when the candidate has `nonAdditiveMigrations`, when its verification failed or is
missing, or when the audits refuse a promotion; a failed production health check rolls back as
above. Such a candidate stays unpromoted, with the reason (`Not promoting <commit> automatically:
…`) on its pre-verification's log. A candidate with a release, or a production deploy, on record, or
any release or production deploy in flight, is never released again; a newer verified candidate
replaces a queued automatic release of an older one, and an automatic release that starts after one
has passed fails as superseded. one. Under `standard` and `light` nothing promotes without a human `--confirm`.

When recovery can be proven, a failed production promotion is rolled back
automatically: production
keeps (or is moved back to) what it served before, the release branch returns to
the commit before the release merge (unless a later release moved it), and the
deploy's `rollback` and reason say so. `rollback.automatic` is true only after every
project is proven restored or unchanged and the release pointer actually returned.
An unknown outcome or a failed pointer return records `automatic: false`. So
`production` must declare `activate` for every project. A project that could not
be moved back is named, and the release branch stays on the release because
production may still serve the candidate. Rollback is
code only. The plan's `nonAdditiveMigrations` names migration artifacts not known to be additive:
any that is neither SQL nor JSON metadata (such as Drizzle's `meta/` snapshots and journal,
which are never counted), and SQL ones that drop,
rename, retype, delete or rewrite something, or tighten what an existing table accepts
(a heuristic, `nonAdditiveSql` in `src/lib/release/release.ts`: it does not flag tables or
columns the migration itself adds, or a CHECK dropped and added back under the same
name as an `IN (...)` list over one column, so an enum that gained a value is additive), and its `next` repeats them: a
failed promotion carrying one, including a rerun confirm of it, is left as it is,
with nothing moved back, for the owner to decide, once its migrations may have changed
the schema: they were applied or failed part-way, were already in place, an earlier
deploy of the same commit did any of that, or the environment declares no `migrations`
(they may have been applied by hand). A deploy that failed before them (a build or
health check) or whose first verify refused, with no such earlier deploy, changed
nothing, so it rolls back and restores earlier projects as usual.

1. `slipjay promote` fetches and plans: the candidate (the integration branch on
   the remote), the base (the release branch on the remote), the commits between
   them, the declared checks, and any files under
   `migrationFinalization.artifactPaths` in that range. It publishes nothing.
2. After explicit human approval of that candidate, `slipjay promote --confirm
   <commit>` checks locally that the candidate is published on the integration
   branch (and, for a release that is not a promotion and carries migration
   artifacts, that `--migrations-ready` was given), then
   submits it to the runner (see [Runner](#runner)); a confirm needs a runner
   location. Releases take turns in their repository's release queue on the runner,
   beside its landings: the runner checks the exact candidate out in the release
   checkout, prepares its dependencies and runs the checks while landings go on
   (a promotion whose pre-verification passed skips this; see above).
   Their failure publishes nothing and prints the failing command and its output
   verbatim. A verified release then waits for the repository's running landing or
   reset (its progress says `Verified; publishing after <repo>'s running turn`), and
   a landing submitted meanwhile waits behind its publication, printing `queued
   (position 1, behind release 16bea7013436)`. Publication rechecks that the release
   branch is still the planned base, so a release branch moved during verification
   publishes nothing. If the install or a check changed tracked
   source, the verified tree is not the candidate's: the release publishes nothing,
   lists the changed paths and restores the candidate. The terminal follows the stages (`verifying`,
   `publishing`, `finalizing`); Ctrl-C stops following, and rerunning the same
   confirm follows the open release of that candidate instead of submitting a
   second.

   A confirm of a candidate the release branch already holds (a newer release
   shipped it) verifies nothing: it returns `"status": "released_by"` with the
   release `merge` that shipped it and that merge's candidate as `releasedBy`.
3. It builds the merge `Release <integration> to <release>` (parents: base, then
   candidate; a `Release-Candidate:` trailer) and refuses unless the merge is
   conflict-free and its tree is the candidate's, so a release branch with changes
   the integration branch lacks is refused rather than merged.
4. It pushes the release branch, refusing if the remote moved since the plan. The
   runner's operation log records the release.

The runner's append-only SQLite operation log is the pipeline ledger. `land` keeps
its timing line on stderr, one duration per runner stage, then `housekeeping`: this
machine's own work after the verdict (recording the landing, sweeping other workspaces); `landings.jsonl` and `releases.jsonl` are no longer written.
`slipjay metrics [--since <ISO date>] [--repo <owner/name>] [--json]` reads that ledger and prints outcomes, cause
classes, and for each repository and operation kind (landing, release, verification,
deploy, reset) its median and p90 stage and command durations and active and paused
queue waits; kinds and repositories are never pooled. For each repository it then
gives its landing verify time against its budgets, and its test files; then
held integrations, attempts per change, flake candidates, and workspace starts (per
repository and machine: starts, how many came from the spare pool, median and p90 claim time, and
median spares available, and the median of each start step that recorded `steps`, as in `start --json`). The claim time is the allocation itself, not `slipjay`'s own startup. The default range
starts at midnight UTC today. `--json` prints the same as JSON; `--repo` keeps one repository.

**Budgets.** A repository declares `budgets` in `slipjay.json`, a settings field
(`slipjay policy set`): `verifyP50Seconds` and `verifyP90Seconds` for its landings'
verifying stage, and `testFileSeconds` for any one test file's median at landing (an audit's
complete run is listed, not judged against it). The runner records them
with each landing's verification, so metrics judge a repository by its latest. A
verify sample is a landing whose checks ran (not a settings landing, not cancelled),
timed by its verifying stage, over the 7 days ending now; each retry is its own sample.
A budget with fewer than 10 samples reports `insufficient-samples`, never pass or fail;
a test file is judged on its own landings, so one with fewer than 10 is listed but never over.

**Test reports.** Each gate command runs with `SLIPJAY_TEST_REPORT_DIR`, an empty
directory of its own. A command that writes reports there, with a manifest
`slipjay-test-reports.json` (`{"version":1,"reports":[{"format":"vitest-json"|"bun-junit","path":"<file in the directory>","suite":"<name>","cwd":"<repository-relative directory>"}]}`),
gets one `{file, suite, ms, status}` row per test file in its run's evidence. A test
file's samples are its executed (not skipped) rows within one operation kind, so a
landing's related run and the audit's complete one are listed apart. A test
file is growing when the later half of its samples has a median over 1.2 times the
earlier half's, from at least 3 each. The command's exit status stays its verdict; a
command that wrote no manifest is recorded as `missing` and a malformed report as
`malformed`, and neither contributes rows. Each stage also
records the runner's load average, memory and running operations as it began, and
the queue snapshot gives each operation's `startedAt`, when it left the queue.

**Flake candidates** are a test failing for two different changes, or a test that
failed and then passed on a retry of the same source commit verified on the same candidate (the
`verification_base` event's `candidate`); a pass on a different candidate shows the base changed, so it is not a flake, and a
failure or pass with no recorded candidate is not enough to confirm one.

Older operations retain their original evidence;
missing instrumentation is not synthesized as a measured fact.

Assigned-workspace landings persist a request identity in local workspace metadata
before submitting. A lost or unreadable submission response is an **unknown outcome**:
run `slipjay land` again from the same workspace to reconcile it. The runner binds
`requestId` to its operation in the existing ledger and echoes it in the submission
response. Replaying that identity returns the same operation even after failure,
cancellation, supersession or publication; using it for different source or submitter
returns HTTP 409 without another attempt. Once the response is acknowledged, a later
explicit landing of failed source may create a new attempt. Requests without the
optional identity retain the existing API behaviour. Direct/default checkouts retain
the legacy follower contract because they have no assigned-workspace metadata.

The runner service pins new submissions in a private bare Git object store under
its state directory before acknowledging them. A hashed manifest and `source_retained`
ledger event bind that source to the operation. Verification and publication import
from those pinned objects, so loss of the author checkout or upstream candidate
bookmark does not lose the submitted source. Capture never touches an active publisher
or verifier checkout. Failed capture acknowledges no new operation and does not
supersede queued work. Admission rechecks queue state after capture, so work that
started meanwhile is followed rather than superseded.

Without `--handoff`, the manifest records that no Spec snapshot or helper, check or
review evidence was supplied. Source objects and manifests follow the retention
schedule below. Older operations without a retention event keep their historical
source availability. An older runner
that does not echo request identity cannot certify request reconciliation; the CLI
reports the outcome as unknown.

Required verification selects redacted diagnostic lines before local process output
is reduced to its bounded head and tail. This preserves named failures, nearby error
text and file locations even when progress noise surrounds them. Each stream keeps
at most 16 KiB of selected diagnostics; oversized lines, private-key blocks and
exhausted selection capacity mark capture `incomplete`. A broker or older executor
without this capture reports `unavailable`. Run events expose `diagnosticCapture`
alongside parsed test identities and diagnostics, and the terminal failure includes
the compact summary. `slipjay runner log <operation>` retrieves these retained
events, including after restart; it does not provide complete stdout/stderr.
An external signal alone does not prove timeout or OOM. Diagnostic text is untrusted
output, never authority to execute a suggested command.

Run-finished events now reference immutable per-command JSON artifacts outside SQLite.
`slipjay runner artifact <operation> <run>` retrieves one, verifies the retained hash,
then prints JSON. Authenticated consumers can page
`GET /v1/operations/:id/artifacts/:runId?offset=0&limit=16384`: each response names its
operation/run, SHA-256, total byte length, byte offset, nullable next offset and base64
bytes. Pages never exceed 16 KiB; every read checks the file against its ledger reference.
Missing, unavailable or changed artifacts return 410, invalid ranges 400, unknown
operations 404, and missing credentials 401. The CLI read exits zero after verified
retrieval regardless of the command's verdict; errors are nonzero and never resubmit.

Artifacts keep at most 8 KiB of each sanitized stdout/stderr stream and of each selected
diagnostic stream. Small complete streams carry `complete: true`; output already
truncated by the process collector is withheld, since an edge may contain part of a
credential. Selected middle diagnostics are retained separately with their own
incomplete/capacity metadata. Redaction precedes artifact clipping, and the serialized
file has a hard 256 KiB bound. These artifacts do not recover full noisy command logs.
Private finalization/reset/deployment output is withheld. Capture failure records
`unavailable`, preserving the original gate verdict and available diagnostics.
Files are flushed before their ledger reference is appended; a repeated run identity
cannot overwrite different bytes. Crash-orphaned files may remain without a ledger
reference and cannot be retrieved through the API. Artifacts follow the retention
schedule below.

`slipjay land --handoff <json-file>` optionally supplies version-1 author evidence
alongside the exact source. The file is at most 64KiB. All fields below are required;
arrays may be empty and `spec` may be null. A Spec snapshot's SHA-256 must match its
exact UTF-8 body. Revisions are full 40-character commit IDs. Each evidence array
has at most 32 entries. Intent, scope entries and evidence details are at most 2,000
characters; the Spec snapshot is at most 32,768 characters.

```json
{
  "version": 1,
  "source": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "intent": "What this candidate delivers",
  "scope": ["src/lib/example.ts"],
  "spec": null,
  "helpers": [],
  "checks": [],
  "reviews": [],
  "toolchain": [{ "name": "bun", "version": "1.4.3" }],
  "gaps": ["Independent review pending"]
}
```

A non-null `spec` has `ref` (`owner/repo#57`), `bodySha256` and `snapshot`.
Helpers have `revision`, `base` and `scope`; checks have `revision`, `command`,
`result` (`passed`, `failed`, `not-run`) and `detail`; reviews have `revision`,
`reference`, `result` (`complete`, `incomplete`) and `detail`. These are author
reports, never runner verification, independent-review approval or repair authority.
Empty evidence arrays do not establish that a check or review was unnecessary.

`adopt` records are merged into `helpers` when the first submission is frozen,
one entry per original revision with its helper base and changed paths as `scope`;
explicit handoff helpers merge by revision too. Retries replay that evidence.
After publication, adoption coverage (workspace name, base, revisions) is retained
in the repository-scoped artifact archive, independently of the lead's checkout
and metadata. Only that archived coverage authorises helper retirement; historical
or hand-supplied `helpers` never do, and helpers receive no landing record of their
own. Remove, cleanup, prune and sweeps share this judgement: every non-empty commit
outside integration must be covered. Any later helper commit keeps it protected.
The archive retains the lead's original published source. Its ancestry counts as
delivered even when publication flattens it under new commit IDs, so a review or
verify workspace based on the candidate can retire too. Helper branches still
require exact recorded adoption coverage. Source-only coverage preserves Issue
guards: an open Issue still protects its review workspace from removal and sweeps.
Post-publication cleanup preserves
ancestry held by other workspaces so those pinned helper revisions remain unchanged.
At freeze, an adoption must remain in the candidate's JJ evolution and at least
one of its changed paths must remain changed relative to the lead's start base.
Dropped adoptions are removed with a warning. Pending adoptions are consumed by
freeze; the operation-bound frozen copy survives retries and is archived by the
client, cleanup or state pruning. A new submission carries forward an earlier
frozen adoption only when runner facts prove that landing was declined, cancelled,
superseded or failed before integration, or when it has neither an operation nor a pending
submission request. Before replacing a queued candidate, the new freeze also copies
its adoptions before posting to the runner, keeping the original until supersession
is confirmed. A crash or lost response cannot lose either landing's provenance.
Future freezes defer copies while their original submission is unresolved, and
omit copies of already archived adoption coverage.
Other queued, running and unknown-outcome submissions, including
failures during integration or publication, keep their adoptions until resolved.
Transferred adoptions leave the old record; published submissions keep their
evidence without resending it. A failed push or definite submission refusal clears
the pending request so a changed candidate can reclaim that freeze. Lost responses
and retained operations still awaiting Forge admission keep their request identities.
Each adoption run keeps its own evolution anchor, so undoing a later adoption does
not drop earlier helper revisions. Conflicting adoption duplicates are abandoned
before any squash, preserving other workspaces' operations.
Frozen handoffs and adoption records keep the
same newest 32 acknowledged submissions and all unresolved submissions. Large
helper scopes collapse to enclosing directories (or `.`) to fit the evidence bound.
Before publication is known as of the last fetch, `prune --plan` reports
`adopted, landing not published`; another guard (runner facts, processes or unique
files) may take precedence. Unadopted contributions remain `unlanded work`.

An optional `build` object carries the author's Forge binding for the Spec work:
`specId` and the lead execution `sessionId` (UUIDs), `ticketIds` (up to 200 distinct
UUIDs, possibly empty for work with no Tickets), `bodyRevision` (the numeric HQ Docs
revision, or `null` when unknown), and `bindGeneration` (an integer of at least 1).
All five keys are required when `build` is present and are retained exactly as
supplied; an invalid binding is refused before retention. Omitting `build` records no
Forge claim; `build: { "unassociated": true }` instead states that the work belongs
to no Spec, so once published it is reported to Forge as a chore landing titled by
the handoff's `intent`, and it is never admitted. Nothing is inferred from the Spec ref, the identity's `sessionId` or
branch names, and `bodyRevision` and the Spec's `bodySha256` are never coerced into
each other.

**Forge admission.** A runner accepts a submission with a `build` binding only when its
config sets `build.origin` (HQ's https origin, or a loopback http one) and its environment holds
`YARDSMITH_SLIPJAY_BUILD_TOKEN`; otherwise it refuses the submission (400) rather than
queue it unadmitted. After retaining the source it records the operation as awaiting
Forge admission, then calls Forge's `admitAttempt` (`POST {origin}/api/build/runner`)
with that `submitted` record's ledger sequence, waiting at most 10 seconds. Until Forge
admits it the operation has no place in its queue and never starts (`waitingFor`
reads `Forge admission`); once admitted it queues as usual, and a pause still holds
it. A Forge refusal (`bind_generation_stale`, `admission_session_invalid`,
`delivery_pending`, `attempt_fact_conflict`, or an input Forge will not accept) ends
the operation as `declined` with Forge's code, and nothing runs. Only `delivery_pending`
is marked retryable: another delivery of the Spec is still in Forge's custody, so land
again once it has finished. When Forge does not
answer, the runner keeps the operation awaiting admission and refuses the submission
as retryable (503). The receipt drain then keeps offering that same admission until Forge
answers, which Forge replays, so a lost response never opens a second operation and
needs no further landing; running `slipjay land` again only asks sooner. An owner may
cancel an operation awaiting admission: the drain still settles its admission, and if
Forge had admitted it, reports it `failed` (`cancelled`), so Forge never keeps custody of
abandoned work. A newer candidate of the same change names the queued one it supersedes
to Forge; if that one's admission never got an answer, the runner resends it first, and
while Forge stays silent it refuses the newer candidate as retryable and leaves the queued
one as it was. A Forge-bound newer candidate replaces the queued one only once Forge admits
it: until Forge answers, the queued one waits (`waitingFor` reads `Forge admission of a
newer candidate`), and if Forge refuses the newer one, the queued one keeps its place.

<a id="forge-reads"></a>**Forge reads.** A runner with a Forge connection also answers clients' reads of Forge at
`POST /v1/build/read` (`{ "action", "input" }`, with the runner token), forwarding only Forge's read-only
`read`, `list`, `waits` and `binds` actions to its runner route; any other action is refused (400) before Forge is
asked. The answer is `{ "value" }`, Forge's refusal is 409 with its `code`, and no answer is 503. So a
client of a Forge-tracked repository needs only the runner token: the Forge credential never leaves
the runner. A runner without a Forge connection refuses the read (400).

<a id="forge-check-access"></a>**Forge access for checks.** In a Forge-tracked repository (`tracker: "forge"`), a
landing's `requiredLandingVerification` commands and its `migrationFinalization` `generate` and `verify` commands
can see Forge:

- A Forge-bound landing (`slipjay land --session … [--ticket …]`) gives them `SLIPJAY_BUILD_CONTEXT`,
  `{ "version": 1, "specId": "<uuid>", "specNumber": <n>, "ticketNumbers": [<n>…], "sessionId": "<uuid>" }`, from
  the binding Forge admitted, never from commit text. The runner reads the Spec's and Tickets' numbers by id when
  Forge admits the landing (an admission whose items it cannot read stays unresolved and is offered again), so the
  checks get them without Forge having to answer while they run.
  A chore (no Forge item) gets no `SLIPJAY_BUILD_CONTEXT`.
- Every landing, bound or not, gives them `SLIPJAY_BUILD_READ_URL` and `SLIPJAY_BUILD_READ_TOKEN`. A check POSTs
  `{ "action", "input" }` to the URL with `Authorization: Bearer <token>` and gets the answers of
  [Forge reads](#forge-reads): `200 { "value" }`, `409 { "code" }` for Forge's refusal (`build_item_unavailable`
  for an unknown item), anything else meaning Forge gave no answer. Only `read`, `list`, `waits` and `binds` are
  allowed. The token is random, reaches no other runner route, is good only while this operation runs and
  never outlives a runner restart; it is neither the runner token nor the Forge token, and it is redacted
  from the runner's logs and stored evidence.

On a runner with no Forge connection, and in a GitHub-tracked repository, neither read variable is set: a check
that needs Forge should refuse by name rather than pass. Dependency installs, finalization, deploys and resets get none of these.

<a id="forge-receipts"></a>**Forge receipts.** For each admitted landing the runner owes Forge a receipt for each
fact it reports, named by the operation and that fact's ledger sequence: its admission
delivers `submitted`, and an admission Forge never answered is owed like any receipt; its first held integration is reported `held`; its outcome is
`published`, or `failed` with how it recovers (`publication_unknown` when it failed while
integrating or after integrating its own candidate, `cancelled` for an owner cancel or kill,
`superseded`, `policy_refusal`, `infrastructure_retry` for an infrastructure failure or one
retrying an earlier landing's hold, otherwise `code_repair`); and an integration whose
publication was unknown is reported `published` once any later reconciliation confirms it,
or `failed` with how it recovers once the runner releases it (`integration_released`). That
release also ends any attempt that failed retrying the released hold, should Forge still
hold it open; Forge answering that it already ended counts as delivered. Each command it ran is reported through `recordAttemptRun` as a named run
(`passed`, `failed`, `incomplete` or `cancelled`, with its failing test names), attached to
the outcome fact and sent only after it; a pass with no recorded verified candidate is
reported `incomplete` with that gap. A settings landing that skipped its checks reports no
`verifiedRevision` on any attempt receipt, and one `incomplete` run (`verification-skipped`)
whose known gap names the changed fields and the reason. Repair linkage comes only from a repair the author
proposed, never from queue-prefix ancestry. A declared chore reports only its
publication, through `recordChoreLanding`, and its `land` output says the landing is a chore: it names
the Forge number Forge created for the chore and the landed revision, and names
`hq_forge_associate_landing` as the way to attach it to a Spec, in this repository or another Forge
repository. A Spec spanning repositories lands its parts in the other repositories as chores, each
attached the same way. Nothing is attached automatically, a `Forge: #<n>` or `Spec #<n>` line in a commit
message is never trusted, and SlipJay has no attach command of its own: Forge refuses the runner's identity.
Every receipt repeats the admitted source tuple:
the author's commit as `candidateRevision`, the Spec, Tickets, body revision and hash,
and the bind generation. An independent drain reconciles unanswered admissions and sends owed receipts in ledger order,
with each lane stopping at its first unavailable answer. An unresolved admission never blocks receipts for already-admitted work;
either lane still owing an answer retains the shared outage state and exponential backoff. The drain
records each delivery in the ledger, and resends until Forge answers, which Forge
replays, so a Forge outage, a runner restart or a lost response delays a receipt but
never loses it, and catch-up needs no further landing. When Forge stops answering the
drain backs off (1 second, doubling to 5 minutes) and records a runner-wide
`build_delivery` event, so watch clients see the outage; the queue snapshot's `build`
reports whether Forge is answering, how many receipts are owed and since when, and how
many are parked. A receipt Forge refuses, including one it finds too large, is parked with its code and never holds back
another operation's; a failure's command lists and excerpt are cut, and the receipt marked truncated,
to keep each request under 200 KB. A landing's outcome reports its `build` admission and receipt
state apart from its verdict: a published landing whose receipt is still owed is
landed, with `receipts: "pending"`. Refused, unadmitted and unbound operations owe
nothing. No Forge call is made during integration or publication.

The client redacts with its environment before transport, then the runner redacts
again before retention. Redacted Spec snapshots receive a new snapshot digest and
a gap preserving the original body digest. Unknown credentials cannot be detected
reliably: supply evidence without secrets. The manifest records redaction status,
input digest and explicit missing repair authority. Its immutable file and parent
directories are flushed before acknowledgement. Reusing a request identity with
different evidence is refused; evidence on an existing acknowledged operation is
immutable. Reattaching to an existing operation observes its original evidence.

`slipjay runner handoff <operation>` retrieves the retained sanitized manifest as
JSON through authenticated `GET /v1/operations/:id/handoff` (`{ manifest }`). It
checks the ledger digest before serving; missing/tampered evidence returns 410,
non-landing operations return 409 and unsupported runners may return 404/501.
Read failure exits nonzero. This read never creates a repair claim or resubmits.
A manifest records what the author supplied; it does not certify that a fresh worker
has every reproduction prerequisite, and its gaps say what is missing.

`slipjay runner source <operation> <bundle-file>` downloads a self-contained Git
bundle of the exact retained source, including ancestry, into a **new** local file.
It checks the operation's retained-source acknowledgement, declared size and SHA-256
while streaming to a private temporary file, then installs the completed file without
overwriting an existing destination. Source bundles are authenticated repository
content, not sanitized diagnostic logs. No author chat or warm checkout is needed.

The API is `GET /v1/operations/:id/source`; success streams `application/x-git-bundle`
with `Content-Length`, `X-SlipJay-Source`, `X-SlipJay-Operation` and `X-SlipJay-Sha256`.
Generation uses the existing bounded executor (120-second command deadline), validates
the bundle's ref/source and rejects completed bundles above 128MiB. This is an export
size limit, not a hard temporary disk quota while Git builds the bundle. The client
has a five-minute request deadline. Unsupported export is 501, unavailable/capacity or
missing retained evidence is 410, non-landing is 409 and unknown operations are 404.
An interrupted export can be requested again without retrying the landing. Normal
completion/failure/disconnect removes the derived server bundle; a process crash may
leave a temporary file. The retained private source ref and manifest follow the
retention schedule below.

The public `importSourceBundle(bundle, assignedCheckout, operationId, sourceCommitId)`
validates the bundle's exact operation ref and imports immutable objects into an
already assigned authoring checkout. It leaves the working revision unchanged. It
does not grant repair ownership, execute source, retry verification or publish.

<a id="repairing-a-failed-landing"></a>**Repairing a failed landing.** A source correction uses a durable repair claim, and
`slipjay repair` sets one up in one step from any checkout of the same repository:

```sh
slipjay repair <failed-operation>   # prints the repair workspace and its brief
# In that workspace: fix the cause, keeping its change, and run focused checks. Then:
slipjay land
```

Before allocating anything, `repair` reads the operation's outcome and repair state and
refuses what they already show: a published or unconfirmed publication, a landing that
did not fail (a kill, pause or cancellation included), expired or missing retained
source, an active claim, and whatever the runner's `eligibility` names (a newer
attempt, migration or finalisation history, a paused runner). Each refusal names the
next step. The claim stays the authority: when the runner refuses it after allocation,
for example to a concurrent claimant, `repair` removes the workspace it just allocated.
Otherwise it downloads and imports the retained source (`runner source`,
`importSourceBundle`, which needs no claim), allocates a workspace whose task is `Repair
<operation>`, claims the repair there (`runner repair-claim`) and moves the workspace's
untouched placeholder change onto the candidate, so the next `land` from it is the linked
repair. The failed
landing's evidence is never changed.

`repair` writes a brief to `~/.slipjay/state/repairs/<operation>.md`, outside every
checkout so it can never land. It holds only what the runner recorded, and names each
absence as a gap:
- the operation, change, candidate, the author's source base and the runner's prepared integration base
- the submitted intent and Spec reference with its body digest
- the classification and diagnostics (an interaction with an earlier landing is marked suspected)
- the recorded commands, each passed, failed or invalidated
- the author-reported checks and reviews
- every integration commit published since the prepared base, up to the integration head observed

Log output is quoted as untrusted data, and the brief is redacted with the caller's environment.

The repair workspace belongs to the work item the failed candidate named: `land` writes
it into the candidate's description (`Issue: owner/repo#<n>`, or `Forge: #<n>` in a
Forge-tracked repository), so it is attached as `start --issue` would. A candidate that
named none, such as a chore, stays unassociated. Further Tickets named in the landing's
Forge binding are listed in the brief as `--ticket` flags. A failure that belonged to a
Spec therefore never lands as a chore.
Custody stays the repairer's own: `land` needs their current lead session and the
Spec's current bind, exactly as for any landing, and the old binding is never copied.
When the author's workspace on the same machine still holds that item, `repair` refuses:
fix the failure there, or remove that workspace first.

Running `repair` again on the same machine resumes the workspace it set up, found by its
task, which is recorded the moment it is allocated: after an interruption anywhere from
allocation on, a lost claim response, or once the fix has begun. It never takes a second
claim and never moves a workspace away from edits. Another machine cannot reuse it: the
claim capability belongs to that workspace, and is released or revoked rather than shared.
Starting a repair agent, accepting a repair automatically and repair budgets are not
SlipJay's: the repair is reviewed and gated like any landing.

The lower-level steps remain for operators: `slipjay runner repair-claim`, `runner
source` and the public `importSourceBundle`.

The claim capability is stored and flushed in private workspace metadata **before**
the claim request; its confirmed identity is retained before CLI success. A new CLI
process retries the same capability after response loss. stdout and ledger events
never contain its token. Ordinary `land` carries the matching workspace capability
and records a new `repair_proposed` attempt linked to the original failure. The old
attempt, source and failure are immutable history. This command does not waive the
normal independent review/gate requirements.

`GET /v1/operations/:id/repair` reports whether the logical change has ever been
fenced, its public current claim, and `eligibility`: why a fresh claim would be refused
now, or `null`. `POST` accepts `claim` with `workspace`, `by`
and a 64-character lowercase hex `token`; `release` with `claimId`, `token`, `by`;
or explicit owner `revoke` with `by`. All use the existing runner credential. This
is the runner's existing trusted-owner API, not a separate person/agent role system.
Claim/release/revoke failures return 409, invalid input 400, missing operation 404,
missing or invalid retained handoff 410, unsupported validation 501. Owner revocation
is an explicit control action; loss of heartbeat never invokes it.

Only the latest confirmed pre-publication gate/conflict failure with retained source
and a valid manifest accepts a fresh claim. Pause, kill/cancellation, held/unknown
publication, published source and migration/finalisation-sensitive histories do not.
Only one claimant may write a logical change, across retry attempts and runner
restart. The capability is checked before candidate transport and again by server
admission after source capture. Reattachment to an already accepted operation remains
observation. Claims have no automatic timeout: offline admission is not exclusive
ownership, and an absent author is not permission to take over.

`slipjay runner repair-release <operation>` releases the holder's claim.
`slipjay runner repair-revoke <operation>` is an explicit owner override after a
lost/stale claimant. Neither may change repair ownership while the runner has an
admitted queued/running attempt: wait or explicitly cancel that attempt first.
A released/revoked claimant cannot submit source, and releasing does not silently
restore the original author's write authority. A new claimant must acquire a new
capability on the latest repairable failed attempt. Publication closes the claim.
No automatic repair session or model is started.

**Retention.** A landing attempt's retained source ref, handoff manifest and command
artifacts are kept while it is queued or running, while its publication is
unconfirmed, and while its logical change has an active repair claim. Otherwise they
are deleted 14 days after the attempt's outcome once any attempt of its change has
published, or 30 days after it when none has. The runner checks at start and every six
hours, and records an `evidence_expired` event: `outcome` then names the policy and
time, and `source`, `handoff` and `artifact` return 410 saying the evidence expired. The
ledger's own events, run records and failure excerpts are never deleted. Unreferenced
source objects leave the private store through Git's own gc expiry, so a submission
retained at the same moment keeps its objects. Claim a failure within 30 days to keep
its evidence.

`slipjay runner outcome <operation>` reads one landing's version-1 JSON evidence
without following or submitting it. The authenticated API route is
`GET /v1/operations/:id/outcome` (`{ outcome }`); the same object appears on landing
operation projections and in `slipjay land`'s stdout as `outcome`. Existing `ok`,
`verdict` and `log` fields remain. Older runners may omit it. The read command exits
zero when evidence was retrieved, including for a failed or live operation; read
`status` and `terminal` for that operation's outcome. Unavailable/unsupported evidence
is a nonzero command error. The API returns 404 for unknown operations, 409 for
non-landing kinds, and 401 without the runner credential. Normal landing exit codes
remain zero for the requested published candidate and one otherwise; progress stays
on stderr.

The object records its operation-local `asOfSeq`, source/request/actor identity when
available, the latest prepared attempt and exact base/candidate, versioned failure
classification, bounded causal excerpt, and all recorded command completions with
invalidation flags. An invalidated pass remains historical evidence, not a passing
current attempt. Missing run completions are `incomplete`; signals do not establish
OOM. `evidence.coverage` is always `partial` until complete artifact and handoff
contracts exist: gaps explicitly include absent exact argument/cwd records,
unstarted/skipped units, artifacts and repair authority. Missing structured command
context is reported per historical or capacity-limited run.

New run-start events include structured `commandEvidence`: executable, argument
array (including empty arguments), checkout-relative cwd, environment variable names
and a configuration fingerprint. No environment values or stdin are retained.
Known credential values, secret flags and URLs are redacted before recording, and
the display command uses the same sanitized context. A redacted argument is not
replayable input; a cwd outside the checkout is `null`. The fingerprint covers the
sanitized command and execution limits, excluding environment values, and is not
proof of identical credentials or runtime configuration. Context is bounded to 256
arguments, 32 KiB of executable/arguments and 256 environment names/8 KiB of names;
excess capacity reports `unavailable` without silently clipping individual arguments.

`publication.state` is `published` only for that operation's landed verdict. An
integration/publication intent, held integration, or failure at the integration tail
reports `unconfirmed`. It may have been recovered by a different operation: this
historical projection cannot certify current remote refs or external migration state.
`recovery.kind` calls for reconciliation before retry in that case; every outcome
has `automaticRetry: false`. A read never claims a repair lease or releases the
author workspace. Owner cancellation and supersession remain terminal history.

Cause rules in `src/lib/runner/failure-classification.ts` carry their version on every
`classified` event: `gate` for a failed verification, `conflict` for a rebase
conflict, `infrastructure` for fetch/install/executor problems or a timeout before
test execution, `policy` for declined paths, `killed` for the owner's kill,
`paused_out` for cancellation during a pause, `held` for incomplete finalization
or publication after integration, and `superseded` or `cancelled`. A gate failure
on a new base links an earlier verified attempt of the unchanged submission.
Recurrence is projected from evidence, never written back into historical facts.
A flake candidate needs the same named test and command to fail in different
changes in the selected window. It is confirmed when a later successful run of
the same command in the same repository uses an unchanged source tree from a
failed run. Candidate and confirmation are reported separately.

The authenticated `GET /v1/metrics/events?since=<seq>&limit=<1..1000>` exports
events in global sequence order, returning `events`, `nextSeq` and `hasMore`.
`POST /v1/operations/:id/events` accepts only bounded client facts with a caller's
event `id`; repeating that id returns the original event. Clients cannot post
runner stages, results or classifications. Workspace starts and pool claims use
attributed client operations, created by `POST /v1/client-operations`; `land`
records following and reattachment on its landing operation. Hosts may call the
public `recordClientFacts` library export for preview and transport observations,
or `slipjay record-preview <port>` after starting a workspace preview. These
observations never enter the landing queue.

**Pipeline metrics relay.** HQ runs where it cannot reach the runner, so a runner with
`build.origin` and `YARDSMITH_SLIPJAY_BUILD_TOKEN` pushes its own export: at start, five seconds
after a new ledger event (a burst goes in one pass, and an event during a pass is followed by
another), and every 30 minutes regardless, it `POST`s pages of `/v1/metrics/events` (`{since, events, nextSeq, hasMore}`) to
`{origin}/api/build/runner/pipeline` with the same bearer as Forge admission. HQ owns the cursor: a
pass opens with an empty page to learn it and follows any 409 to the cursor HQ names, so resending
a stored page is harmless and the relay keeps no state. A page is read again with a lower `limit`
until its body fits 3 MiB. It shares nothing with the landing queue or the receipt drain; every
read and POST is aborted after 30 seconds, and a failure is logged to the runner's stderr and
retried at the next tick.

SSH forwarding failures in an assigned workspace are retained as pending delivery
fields in its existing metadata until the same runner address can be reached.
Delivery reuses a stable event ID and its client-operation ID after an interrupted
acknowledgement. Pending facts keep the workspace from being removed. The runner
log remains the ledger; metadata is cleared after acknowledgement. A command run
without isolated workspace metadata reports when durable retention is unavailable.
Migration generation and migration verification carry distinct typed `purpose`
values on their command runs; source-tree evidence is taken after generation,
immediately before the gate.

A promotion's migration artifacts are applied by the runner (see Production
migrations under Deploys): its production deployment must declare `migrations`, and
`--migrations-ready` is refused. A release that is not a promotion and whose range
carries migration artifacts needs `--migrations-ready`: apply those migrations
where the release branch deploys first; slipjay does not migrate it.

## Library

```js
import { createWorkspace, landThroughRunner, workspaceContext } from "@pechhe/slipjay";
```

`@pechhe/slipjay` and `@pechhe/slipjay/delivery` export the same public entry,
`src/lib/slipjay.ts`, which Bun imports directly (there is no build step). It covers
workspaces, landing and its verification, repository policy and post-integration
finalization, plus the process and text utilities that hosts share. Other
modules under `src/lib` are internal, and `bun run check` enforces that the
`src/` closure imports only itself, Node built-ins, `effect` and `proper-lockfile`
(type-only imports included), that nothing outside `src/launcher` imports it, and
that there are no runtime cycles (type-only imports are not runtime edges).
[docs/architecture.md](docs/architecture.md) maps the capability folders. A host that brokers child processes injects its broker with
`setProcessBroker`. Before the cutover, any library call that reads or writes
state rejects with an error whose `code` is `SLIPJAY_CUTOVER_REQUIRED`;
`cutoverPending()` reports that state and `cutover()` runs the cutover.

## Development and landing

slipjay lands its own changes through `slipjay land` from an isolated JJ workspace, under its own
`slipjay.json`.

Verification checks run with the working-copy revision on the exact candidate,
including retries that started on an empty continuation child.

- **Per landing**, the gate runs `bun install --frozen-lockfile`, then
  `bun run check` (Oxlint and the closure boundary), `bun run typecheck` and the
  affected tests (`bun run test:landing`) concurrently. The selector validates the exact
  rebased JJ candidate and its single integration parent, then uses `vp test related`
  plus explicit runtime fixture readers and source CLI/subprocess callers. Toolchain,
  lockfile, test setup, deletions of anything other than a `tests/**` or `scripts/**`
  `*.test.ts`, unknown paths and unreadable/ambiguous candidates run the complete
  landing suite. A deleted test file selects nothing: its tests are gone, and a guard
  test keeps it true that nothing imports one. Only an explicit harmless list (docs, README,
  CHANGELOG, GLOSSARY, AGENTS and .gitignore) can skip Vitest; runtime tests always run.
  Command output records the candidate, changed paths, selection and reasons.
  `tests/quarantine.json` lists `{file, issue, reason}` entries naming an open Issue;
  those files are excluded even from complete landing runs, but still run in
  `bun run test` (release) and `bun run test:audit` (the nightly audit's complete
  suite, which writes the same reports). Remove entries when their Issue closes.
  With `SLIPJAY_TEST_REPORT_DIR`, the gate writes Vitest JSON, Bun JUnit and a
  version-1 `slipjay-test-reports.json` manifest there; command exit status remains
  authoritative when a report is missing. `bun scripts/test-landing.ts --replay`
  replays selection for the last 30 main commits using their exact parent diffs
  and historical import graphs in disposable scratch trees, without running test bodies.
- **At release**, `bun run verify:release` runs the complete suite again
  against the exact commit to be tagged. It prints that commit and exits non-zero
  on failure. Tag only a commit it passed. To trace a release failure to its
  landing, bisect `<last tag>..main` and read the commit's `Issue:` trailer.

Every Vitest file runs under its own disposable `HOME`
(`scripts/vitest-hermetic-env.ts`). `scripts/hermetic-home-guard.ts` fails a test
that would otherwise write the real `~/.slipjay` or `~/.pi`. The cutover tests build
pre-v1.0.0 state in that disposable `HOME` and never touch the real one. Run a single file with
`bunx vp test tests/<capability>/<file>.test.ts`.


## Watching the runner

`slipjay watch --json` uses the configured authenticated runner connection, including
SSH forwarding. stdout contains only version-1 JSONL envelopes: `snapshot` with the
`QueueSnapshot`, `event` with a stored global event, `heartbeat` with `at` and `seq`,
and `connection` with `connecting`, `connected` or `disconnected` and the replay
`cursor`. Without a saved cursor, the first snapshot's `seq` establishes the initial
cursor and history is not replayed. A consumer can set `SLIPJAY_WATCH_CURSOR` on the
watch process to resume from a non-negative safe integer sequence; invalid values
are rejected before connecting. Catch-up is bounded to the latest 100 global events
on each connection, so older events are skipped. The `connected` envelope's cursor
establishes the applied baseline before replay. A cursor ahead of a replaced runner
log (HTTP 409) resets to a fresh snapshot's sequence and resumes watching.
Events and heartbeats refresh the runner-owned queue projection; replay refreshes
once at the end of the batch rather than after each historical event. Reconnect
creates a new transport, refreshes the snapshot, and replays from the applied cursor
within the same bound; only emitted events advance it after the baseline.
Heartbeats prove connection liveness even during a quiet command and never advance
the replay cursor. Interrupting watch closes its readers and SSH transport.
Every connection attempt emits `connecting`, and a failed attempt emits
`disconnected`, even before the first snapshot (cursor `0`). Neither exposes
credential or transport error details. Missing credentials are retried inside the
watch process after 30 seconds; a successful credential is cached while ordinary
transport retries wait two seconds.

`GET /v1/queue` returns both ordered lanes and their paused and held facts, recent
release outcomes and the latest completed staging attempt per repository, including failed attempts and their recorded result. Timing includes `amberAfterMs`, twice the recorded stage median, and the active command deadline; absent evidence returns a null threshold. Missing timing evidence and the hourly
suite producer are explicitly unavailable; consumers must not infer a stuck command
from silence alone. The canonical authenticated export endpoint is
`GET /v1/metrics/events?since=<seq>`: request `Accept: text/event-stream` for stored
events and heartbeats, or JSON for bounded finite `{events,nextSeq,hasMore}` pages.
Continue finite export from `nextSeq` while `hasMore` is true.

`slipjay cancel <id>` requests queued-only cancellation and records the local
hostname as its actor. Running operations are refused; cancellation does not relax
the runner's kill safety.

