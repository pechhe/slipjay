# SlipJay

Harness-neutral JJ workspace and landing tool. One tagged artifact is both the
`slipjay` CLI and a library, written in TypeScript and run by Bun (1.4 or later),
its only runtime.

SlipJay was extracted from `pechhe/peach-pi` at `37a32367` as `peach-workspace`,
became Slipway in v1.0.0, and is renamed to SlipJay in v2.0.0. It uses the
`slipjay` CLI, `slipjay.json` config, `SLIPJAY_*` environment names, and state
under `~/.slipjay`. See [CHANGELOG.md](CHANGELOG.md) and [State and cutover](#state-and-cutover).

## Read by task

For runner or promotion work, start here and follow the relevant contract below;
the README's CLI table remains the command index. The operational documents hold
the full contracts, including configuration, refusal conditions and recovery.

- **Land or follow a landing:** [CLI](#cli), then the runner's [landing contract](docs/runner.md#landing-contract).
  For a lost response, read [submission identity](docs/landing-evidence.md#local-preflight-and-submission-identity).
- **Diagnose a failed landing:** [diagnostics and artifacts](docs/landing-evidence.md#diagnostics-and-command-artifacts)
  and [outcomes and classification](docs/landing-evidence.md#outcomes-and-failure-classification).
  For a held integration, use [held integrations](docs/runner.md#held-integrations);
  for a source repair, use the [repair workflow](docs/landing-evidence.md#repair-workflow).
- **Pause, kill, restart or move the runner:** [owner controls](docs/runner.md#owner-controls),
  [state and restart recovery](docs/runner.md#state), and [host migration](docs/runner.md#moving-the-runner).
- **Plan or confirm a promotion:** [Release](docs/release.md), including
  [verification and approval coverage](docs/release.md#pre-verification-and-approval-coverage),
  [rollback and migrations](docs/release.md#rollback-and-non-additive-migrations), and
  [confirmation](docs/release.md#confirming-and-publishing). Development mode also uses
  [automatic promotion](docs/release.md#automatic-promotion) and, when configured,
  [batch checks](docs/release.md#batch-checks).
- **Configure a runner or verifier:** [Runner](docs/runner.md), starting with [setup](docs/runner.md#setup)
  and the [candidate Bun runtime](docs/runner.md#candidate-bun-runtime).
- **Deploy, reset or audit:** [Deploys](docs/deployments.md#deploys),
  [Reset](docs/deployments.md#reset), or [Audit](docs/deployments.md#audit).
- **Consume evidence or integrate a host:** [landing evidence](docs/landing-evidence.md),
  [Watching the runner](#watching-the-runner), and [Library](#library).

## State and cutover

| What | Location |
| --- | --- |
| Landing state, locks and post-integration records | `~/.slipjay/state` |
| Checkout mode (`slipjay mode`) | `~/.slipjay/mode.json` |
| New isolated workspaces | `~/.slipjay/workspaces` |
| Removed checkouts awaiting deletion | `~/.slipjay/trash` |
| Installed code, one directory per landed commit | `~/.slipjay/installs` |
| The install the `slipjay` command runs, and the one it replaced | `~/.slipjay/current`, `~/.slipjay/current.previous` |
| The install the runner service runs, and the one it replaced | `~/.slipjay/runner-install`, `~/.slipjay/runner-install.previous` |
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
  then skips staging and promotes by itself (see [Release](#release)). Any other value is refused, and an unreadable
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
- **`slipjay config [--json]`, `config set runner <location>`, `config set upgradeSource <path>`, `config set spares <0-8> [--repo <path>]`, `config unset <runner|upgradeSource|spares> [--repo <path>]`.**
  Reads and writes `~/.slipjay/config.json`, keeping its other keys. `upgradeSource` is this
  machine's integration checkout, which `upgrade` fetches and installs from (see [Install](#install));
  setting it resolves and checks the checkout the way `--repo` does, and without it `upgrade` refuses
  and automatic upgrades are off. `--json` reports `runner`
  (`value`, `source`: `environment`, `file` or `unset`, the `file` value, and whether
  `SLIPJAY_RUNNER` overrides it), `upgradeSource` (the path, or null) and, for the current repository and each one with a limit,
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

Optional `slipjay.json` fields for local workspace behaviour, the workspace pool and shared output:

| Field | Meaning |
| --- | --- |
| `spares` | Integer 0-8, default 1. How many prepared spare workspaces the pool keeps; 0 disables the pool. A refill tops the pool up one spare at a time, counting spares still being prepared, and holds the pool lock only to count and register a name, never during the dependency install, so a claim always takes any ready spare even while another is installing. Every new workspace `start` makes, a claimed spare or a fresh one after a miss, also starts a background refill, so a burst of starts finds the pool replenished and an empty pool fills itself. An idle spare costs nothing at landing. A machine can lower (never raise) a repository's count: `spares` in `~/.slipjay/config.json` maps integration checkout paths to counts, such as `{ "spares": { "/Users/me/Engineering/yardsmith": 2 } }`, and `0` disables the pool on that machine (the next refill retires spares beyond the count); `slipjay status` and `slipjay config` report the count in force with the declared and machine values and the `source` of the declared one: the integration branch and the commit whose committed `slipjay.json` was read. That is the integration bookmark as of the last fetch (every `start` fetches it before the refill it starts), never the primary checkout's working files, so an unlanded or stale local edit cannot change the allowance, and both hosts reach the same count once each has fetched. A machine limit applies to its checkout by real path, so a symlinked or differently spelled path still matches, and a spare whose record names a checkout path that no longer exists still counts against the allowance while it is one of the repository's workspaces. Retiring assigned workspaces never takes a spare. When the pool is short and no abandoned spare waits, retiring an assigned workspace instead makes the next spare from it: a new workspace, at its own path on the integration head, receives the retiring checkout's `node_modules` trees by rename once retirement's last checks pass (a checkout whose forget then fails gets them back), and the refill this starts installs over them in place, so a spare costs an incremental install rather than a full clone and install. One repository's refills run in turn, and refills of every repository on one machine install one at a time, holding that machine-wide lock only for each install, so repositories take turns between spares; claims never take either lock. Spares are not moved to each new integration head: a claim runs `jj new` on the head itself and keeps the spare's dependencies when the install inputs there are the ones they were installed for and its installed tree still has a usable `package.json` in every package directory (a fingerprint and a successful frozen install do not show that: pnpm exits zero over a package directory that lost its files). A damaged tree is never reused or cloned into another workspace: an install repairs it once from scratch, a refill reinstalls ready spares that fail the check, and damage that survives fails the preparation naming the paths. After topping up, a refill refreshes one spare only when no ready spare recorded the head's install inputs (read from the head's commit), so a landing that changes them costs one install per refill, not one per spare: that spare moves to the head and installs over its existing `node_modules` in place, which changes only what changed. The others are refreshed in place when claimed, or one at a time by later refills. A claim takes the most recently prepared spare first. A start's installs into one repository's checkouts run one at a time on a machine, so a second waits for the first and clones its result; a start never waits for a refill's install. |
| `landingPreflight` | Optional `{ "command": ["bun", "run", "check"], "timeoutMs": 120000 }`. A nonempty argv array (executable then arguments; no implicit shell), run in the submitting workspace root before `land` contacts the runner. `timeoutMs` is an integer from 1 to 2147483647, default 120000 (120 seconds); unknown fields are rejected. The declaration comes from the submitted commit's `slipjay.json`. Failure or timeout refuses submission and prints the output tail. Use seconds-cheap formatting or lint checks here; the runner gate remains authoritative. See `land --skip-preflight` below. |
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

For Bun, an exact-version “No version matching” failure naming a version in the
frozen `bun.lock` gets one retry in the same workspace with `--no-cache` replacing
`--prefer-offline`. This refreshes manifest lookup without deleting the global
cache or changing dependency pins. Other errors, cancellations and timeouts do
not trigger this recovery; an absent version still fails after that one retry.
Binary `bun.lockb` files have no automatic metadata recovery because SlipJay cannot
prove the reported version is locked from their text.

Install attempts retain bounded, redacted diagnostics in the workspace's
`preparedDependencies.installAttempts`, the `start --json` result's `installAttempts`
and the provisioning log. On failure the error carries all attempts and readiness
is not recorded. Runner candidate and release installs use the same recovery;
their existing command evidence records each original and retry command separately.
`steps.install` continues to measure the entire install, including recovery. A foreground
`slipjay start` still streams Bun's output live while keeping a bounded copy for this inspection.
Bun's frozen install also applies changed `patchedDependencies` over reused trees;
SlipJay preserves the candidate's patch files and lockfile.

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
unchanged provisions nothing, so it logs nothing here. A spare-marked checkout a live process is working in is held, not
a spare: the pool neither counts, adopts, refreshes, claims nor retires it, and each refill names it,
`{"held","holders"}`, until its holders exit. When the host's processes cannot be read, the pool takes no spare: a claim
installs a fresh workspace and the refill fails, saying why.

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
landing. On a runner whose repository verifies on a remote verifier (a boat VM),
the runner's own checkout skips that install unless the candidate generates
migrations there: the VM installs the candidate itself, and proves its tree
unchanged before and after the gate.

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

Nothing is published: SlipJay installs itself from a checkout of this repository, and
the first install is the one step done by hand.

```sh
git clone https://github.com/pechhe/slipjay ~/projects/slipjay
cd ~/projects/slipjay
bun src/launcher/workspace.ts config set upgradeSource ~/projects/slipjay
bun src/launcher/workspace.ts upgrade
```

`upgradeSource` names this machine's integration checkout: the checkout whose
integration branch it fetches to learn what landed, and whose landings it installs.
`slipjay upgrade` then:

1. fetches that checkout's integration branch and takes the commit the remote
   publishes;
2. builds that commit's tree into `~/.slipjay/installs/<commit>` — `git archive`, then
   `bun install --frozen-lockfile` — unless it is already built;
3. verifies the build by running its launcher: `--version`, then `status --json` in a
   temporary directory that is no repository;
4. swaps the `~/.slipjay/current` symlink onto it, keeping the install it replaced as
   `~/.slipjay/current.previous`.

An upgrade needs `git` and `tar` beside Bun: the install is a `git archive` of the
commit, unpacked.

Only then does anything point at the new code: a build or verification that fails
leaves the slot, and the `slipjay` command, where they were, and says why. An
`upgrade --json` reports `slot`, `from`, `to`, `action` (`upgraded`, `current`,
`rolled-back`, `busy` or `failed`), `reason` and the `command` the `slipjay` command
now runs. `busy` is the hourly pass finding another upgrade already building that
commit: it does not wait for it, and the rest of the pass runs.

The first upgrade also adopts the machine: `~/.bun/bin/slipjay` becomes a link to
`~/.slipjay/current/src/launcher/workspace.ts`, replacing the bun global package link
it may have been, so everything on `PATH` — agents, T3 Code, cron, launchd — runs the
current install. `bun add -g` no longer owns it. A later upgrade whose adoption failed
tries again, including one that finds the slot already current.

Adoption is refused, with the install still upgraded, on a host whose `slipjay-runner`
unit runs anything but the runner install — an existing runner unit runs
`~/.bun/bin/slipjay`, so adopting would make the runner follow the client slot too. The
outcome says so and names what to run; see [the runner host](#the-runner-host).

Clients keep themselves current:

- the hourly `maintain` pass upgrades first and reports the outcome as `upgrade`;
- a landing of this machine's `upgradeSource` starts one once it publishes;
- `start` starts one at most every ten minutes.

Each runs detached, so none delays the command that started it, and each logs to
`~/.slipjay/state/upgrade.log`.

`slipjay upgrade --rollback` returns the slot to the install it replaced
(`current.previous`), and leaves the one it left as the previous in its turn, so the
same command again undoes itself. Two installs are kept for the slots; older ones are
removed after 7 days.

### The runner host

The runner service runs its own slot, `~/.slipjay/runner-install`, which only a
deliberate upgrade moves:

```sh
slipjay upgrade --runner              # install the integration head, then restart the unit
slipjay upgrade --runner --rollback   # put back the install it replaced, then restart
```

`--runner` refuses on a host without a `slipjay-runner` unit, and it only restarts the
unit once the unit's own `ExecStart` runs the runner slot: a unit that runs anything
else is reported, naming `scripts/setup-runner.sh`, and nothing restarts. The restart
finishes any integration in flight first (see [Runner](#runner)). `scripts/setup-runner.sh`
writes the unit to run the runner slot, so a client upgrade never changes the code the
runner runs and never restarts it; `~/.slipjay/runner` stays the runner's own state
(`config.json`, `stop-runner.sh`, the corepack shims).

A host that already runs the runner — its unit still runs `~/.bun/bin/slipjay` — moves
in this order, because the client's adoption waits for the unit to stop following that
command:

```sh
slipjay upgrade --runner        # builds the runner install (reports that the unit still needs setup)
scripts/setup-runner.sh …       # points the unit at the runner install and restarts it
slipjay upgrade                 # adopts the client command, now that the unit no longer follows it
```

Never clear Bun's package cache (`bun pm cache rm`) to upgrade: projects that set
`globalStore = true` link every checkout's packages into it, so clearing it breaks
their dependencies. When a workspace's dependencies are damaged that way, `slipjay start`
and landing say how to repair them.

From Slipway, remove it first (`bun remove -g @pechhe/slipway`) and run
`slipjay cutover` once after installing.

## CLI

`slipjay <command>` runs the workspace and runner commands below. It also provides
what a Claude Code `WorktreeCreate`/`WorktreeRemove` hook needs without library
imports (`start --integration --issue <n> --json`, `remove <path>`):

| Command | Effect |
| --- | --- |
| `status` | Mode, current workspace and its Issue, integration checkout, landing state and this machine's spare count (JSON). |
| `config [--json]`, `config set\|unset <runner\|upgradeSource\|spares> …` | This machine's runner location, upgrade source and spare limits, each with its source (see [Settings](#settings)). |
| `upgrade [--runner] [--rollback] [--json]` | Install this machine's integration head into the client slot (`~/.slipjay/current`), or with `--runner` the runner slot, and point the `slipjay` command at it (see [Install](#install)). It fetches `upgradeSource`, builds and verifies the install, and only then swaps the slot, keeping what it replaced as `previous`; `--rollback` swaps back. A machine with no `upgradeSource` is refused, naming how to set it; `--runner` is refused without a `slipjay-runner` unit, and otherwise restarts it. `--json` prints one object (`slot`, `from`, `to`, `action`: `upgraded`, `current`, `rolled-back`, `busy` or `failed`, `reason`, `command`), exiting 1 on `failed`. Two upgrades racing for one commit leave the install the slot ran as the rollback; the other reports `current`. |
| `policy show [--json]`, `policy set --base <revision> …` | Read the integration branch's policy, or land a change to its settings fields without running the landing checks (see [Settings](#settings)). |
| `landed <path>` | The landing recorded for the workspace at exactly that path, even after it was removed, as one JSON line (`workspaceName`, `workspacePath`, `artifactCommitId`, and `operationId`, `issueNumber`, `landedAt` when recorded), or `null`. Read-only. |
| `mode [isolated\|direct]` | Read or write the checkout mode. |
| `list` | Workspaces with their state, Issue and retained material. |
| `pool [refill]` | Show ready spare workspaces, or provision one (up to `spares`). |
| `prune --empty` | Remove empty workspaces, empty workspaces of a closed Issue, and state left by workspaces that no longer exist. A registered workspace whose checkout is gone from disk is forgotten when its revision holds no unlanded work; one whose working copy JJ cannot read is kept, with how to recover it. Directories in workspace storage that no repository lists (a forgotten checkout, one whose repository is gone, one with no JJ identity) are removed only when they hold nothing but reproducible output, are over an hour old and no live process uses them; any other is kept and named. |
| `prune [--empty] --plan [--json]` | Change nothing; list every workspace of the repository with its path, state, Issue, task, assignment time, landing (and whether it is published, as of the last fetch), live processes, unique files and size, and whether the automatic sweep (or, with `--empty`, `prune --empty`) would remove it now and why not. It shares the sweep's decisions but snapshots no working copy, fetches nothing and finishes no landing, so an edit since a checkout's last snapshot, a checkout missing most of its tracked files (see `remove` below), a landing's pending housekeeping and an unreadable fact (an Issue state the tracker cannot report, metadata that cannot be parsed) each keep the workspace, with that reason. States are `integration`, `spare`, `unlanded`, `landed`, `empty`, `missing` (registered, checkout gone from disk), `broken` (JJ cannot read its working copy) and `orphan` (a directory in workspace storage no repository lists; its `repository` is the one it names, or null). |
| `attach-issue <n>` | Bind the current workspace to Issue `n` (a Forge number in a Forge-tracked repository; see `tracker`). |
| `attach-project <owner/name> \| --clear` | Name the Forge project this workspace's chores file in, for a repository several Forge projects deliver into. `land` carries it in the chore's statement and says which project the chore files in; Forge files it in the repository's own project when none is named or the named one cannot apply. `start` clears it, so a reused workspace never files under the project it served before; T3 Code sets it each time it gives a thread a workspace. |
| `start "task"` | Assign an isolated workspace for a task and print its path. An empty, undescribed change is described `wip: <task> (#<n>)` so abandoned work is never anonymous; landing replaces exactly that generated text (recorded in the workspace metadata) with the Issue title or task, never publishing it; a description you write, `wip:` or not, lands as written, and a stack with the placeholder left on a lower commit is refused. A new workspace is based on the integration branch freshly fetched from the declared remote (best effort: offline, it starts from the local branch). The fetch runs before the start takes the repository's allocation lock, and starts within 30 seconds of a fetch, or arriving while one runs, share it, so concurrent starts never queue behind each other's fetch. |
| `start [--integration] [--issue <n> \| --base <revision>] [--attempt <id>] [--refill] [--json] ["task"]` | `--integration` allocates from the integration checkout even inside a workspace; `--issue` creates or resumes that Issue's workspace (the task defaults to `Issue #<n>`), except that `--integration --issue <n>` run from the caller's own isolated workspace, when it has no Issue, holds no work and the Issue has no workspace to resume, is refused and names `slipjay attach-issue <n>`: a host such as T3 Code allocates each session's workspace when the session starts, so an Issue attaches to that workspace rather than taking a second; `--base` (implies `--integration`, no `--issue`) starts a new workspace, a claimed spare or a fresh one, on that revision of the current checkout instead of the integration head, so a helper sees a lead's unlanded work; it must name one commit other than the caller's working copy (`jj new`, then pass `@-`), and dependencies are reused unless that revision changed the install inputs; `--attempt <id>` records the start as that allocation attempt (see `attempt`); `--refill` then starts a background spare refill (a new workspace always does); `--json` prints one JSON object (`workspacePath`, `workspaceName`, `integrationRoot`, `issueNumber`, `created`, `reused`, `pooled`, `refill`, `steps`, and `attemptId` when given; `steps` gives the milliseconds spent in each step this start took, each exclusive of the others: `fetch` the integration fetch, after which a primary checkout with nothing of its own moves onto the fetched head, as `maintain` moves it, unless a landing holds it, `claim` taking a spare, `jjNew` moving it to its base, `fingerprint` computing install inputs, `install` making dependencies ready, absent when a claimed spare's are reused, `describe` the working-copy description) and sends all install output to stderr. With a runner configured, the start's metrics (`workspace_start`, `pool_claim`) are posted to its ledger by a detached process, so a slow or unreachable runner never delays the start; a failure is one line in `pool-refill.log`. |
| `attempt show <id>` \| `attempt release <id>` | Recover a start a caller never got the result of. `start --attempt <id>` (an id the caller chose, such as a UUID, used once) records the attempt before anything is allocated: its status (`allocating`, `preparing`, `ready` or `failed`, with the error), the checkout once assigned, whether the attempt created or claimed it (`owned`) or bound or resumed an existing one, and the start's process, so `show` reports a start whose process died as `interrupted`. That survives a failed dependency install, a lost or malformed receipt, a timeout and a restart of either process. `release` reconciles it: it removes the checkout only when this attempt created or claimed it, no later start has bound or resumed it since, and it has no live process or owner, unlanded work, unique files or undelivered runner facts; a bound or resumed checkout (a resumed Issue's) or one that has gone is kept and the attempt forgotten, any other refusal keeps the attempt so the caller can retry, and a start still running is refused. It prints one JSON object (`released`, `removed`, `reason`) and exits 1 when it refuses. Housekeeping forgets an attempt once its start has ended and its checkout is gone. |
| `repair <failed-operation> [--json]` | Set up a repair of a failed landing from the runner's retained evidence: claim it, restore the exact candidate into a fresh workspace and write a repair brief (see [Repairing a failed landing](#repairing-a-failed-landing)). `--json` prints `operationId`, `workspacePath`, `workspaceName`, `claimId`, `source`, `changeId`, `issueNumber`, `briefPath` and `resumed`. |
| `preview` | Diffstat of what a landing would integrate. |
| `record-preview <port>` | Record a host's started workspace preview in the runner ledger. |
| `metrics [--since <ISO date>] [--repo <owner/name>] [--json]` | Pipeline outcomes and causes; stage, queue and command percentiles per repository and operation kind; each repository's landing verify time against its budgets, and its slowest, growing and over-budget test files; held integrations, attempts and flake candidates, from the runner ledger. |
| `land [--direct] [--skip-preflight]` | Send the current workspace (or, with `--direct`, the primary checkout) to the runner, which verifies, integrates and publishes it (see [Runner](#runner)); without a runner location it refuses. Afterwards it moves the primary checkout onto the new integration, carrying its uncommitted edits along when they apply cleanly; edits that would conflict there, a conflicted checkout and unlanded commits under it stay where they are (`status` reports the outcome as `landing.primaryCheckout`). It removes the landed workspace itself, as `cleanup` would: this process and the session that ran it do not keep it, but any other process with its working directory inside does, and is named with its pid and command (the shell's directory is gone once it is removed, so `cd` to the primary checkout). It also sweeps other delivered workspaces, saying why it kept any. |
| `land --no-wait`, `land --follow` | `--no-wait` submits as `land` does and returns as soon as the runner holds the landing (admitted, where Forge admits it), printing `{"ok":true,"verdict":"submitted","operationId":…}` on stdout. A submission whose outcome is unknown, or whose Forge admission is deferred, exits as without the flag and is never reported as submitted. It leaves a detached `land --follow` in the workspace, logging to `state/landing-follow.log`, which follows the landing and then does everything `land` does after an outcome: on publication it records the landing, releases the workspace and, for SlipJay's own landing, upgrades the machine; on a failure it keeps the workspace for repair. `--follow` follows this commit's submitted landing, or reports its last outcome, and never submits. `--no-wait` refuses `--direct`, since the primary checkout is no workspace to follow from. If the follower is lost (the machine restarts, say), the workspace is kept and rerunning `land` there finishes the landing. In T3 Code, a thread that lands this way is woken when the landing fails, is declined or is cancelled, and not when it publishes. |
| `land [--session <id>] [--ticket <n>]...` | In a Forge-tracked repository (`tracker`), a landing without `--handoff` writes its own Forge handoff, so Forge always learns of it. A workspace with no Forge item lands as a chore (`build: { "unassociated": true }`, titled by the description's first line), and its output says so, naming Forge's number for the chore, the landed revision and `weave_forge_associate_landing` (see [Forge receipts](#forge-receipts)); with `--session` or `WEAVE_FORGE_SESSION_ID` (formerly `HQ_FORGE_SESSION_ID`, and before that `HQ_BUILD_SESSION_ID`; both are still read) it is refused before submitting, naming `attach-issue <n>`, since a session says the landing is a Spec's. One started with `--issue <n>` (or `attach-issue <n>`) lands as delivery of item `n`'s Spec: `n` itself when it is a Spec, else the Spec of Ticket `n`, which it lists with each `--ticket <m>` of the same Spec. The binding takes the Spec's body revision and its current bind's generation from Forge, and the lead's open Forge session from `--session` or `WEAVE_FORGE_SESSION_ID` (formerly `HQ_FORGE_SESSION_ID` and `HQ_BUILD_SESSION_ID`). Land refuses before submitting when the session is missing (start one with `weave_forge_start_session`), the Spec has no current bind (`weave_forge_bind`), or the item is neither a Spec nor a Ticket; Forge's admission then checks the session and bind itself. A workspace whose item's Spec Build takes no delivery of — it is Landed, Accepted, dropped or imported closed, so a delivery bind would be refused (`bind_status_invalid`) — lands as a chore instead, with or without `--session`, so a fix found in a Landed Spec's own workspace reaches Build there: its output says the Spec took no delivery and names `weave_forge_associate_landing`, which attaches the published revision to that Spec. A source review fix that should land as the Spec's own delivery uses Build's `fix` route first: `weave_forge_dispose_finding` with decision `fix` creates the review-origin Ticket and returns the Spec to In progress, after which the Spec binds again and `--session <id> --ticket <n>` lands it as delivery. A `--ticket` named for such a Spec is refused before submitting, naming both routes. The handoff is written only for a new submission: rerunning `land` to follow a submitted landing needs neither the session nor Forge, and a retry of a submission still unacknowledged or awaiting Forge admission replays the handoff first written, so Forge changing meanwhile cannot make it unreconcilable. `--session` and `--ticket` cannot be combined with `--handoff`, and need a Forge-tracked repository. |
| `promote [--candidate <commit>] [--confirm <commit>] [--migrations-ready]` | Plan a promotion of the integration branch (or of an older staging-green `--candidate`) to the declared release branch, or have the runner verify and publish the confirmed candidate (see [Release](#release)). |
| `deploy <environment>` | Have the runner deploy the integration branch's latest commit on the remote to a declared environment now, and follow it (see [Deploys](#deploys)). |
| `deploys [--environment <name>] [--json]` | Each deploy, newest first: environment, commit, outcome per project, and the commits it added since the previous deploy. |
| `runner release <owner/repo>` | Release an unpublished held integration only when the runner proves its finalization never started the target command (see [Held integrations](#runner)). Records the requester and `integration_released`; exits 1 on refusal. |
| `reset` | Have the runner reset the repository's declared `reset` target now (or follow its open reset) and print the verdict as JSON; exits 0 once it is `reset` (see [Reset](#reset)). |
| `audit [status]` | The repository's nightly audits and what they say: the last green audit, the latest verdict (green, failed or inconclusive), whether the last green one is overdue, the open failure with its suspects and recorded cause, the uncovered inconclusive run, and the escapes counted (see [Audit](#audit)). |
| `audit cause <landing...\|--flake\|--infrastructure\|--unresolved> [--audit <id>] [--note <text>]` | Record why the repository's failing audit failed, or why two inconclusive audits in a row refused promotion: one or more culprit landings (a landing's operation id, or its published commit in full or by 12 or more hex digits), or exactly one of `--flake`, `--infrastructure`, `--unresolved`. It covers the whole open failure, or the inconclusive audits up to when it was recorded, or the failing audit `--audit` names, and lifts the promotion refusal. |
| `evict [--plan] [--json] [--idle-hours <n>]` | Shed what a checkout can rebuild — the `node_modules` beside each tracked manifest and at its root, plus every directory the repository declares in `generatedPaths` — from workspaces nobody is using, keeping the checkout, its commits and its binding. It refuses the integration checkout, a live process, unreadable process boundaries and a pool spare, and it never touches a path the repository declares in `evidencePaths`. An unknown activity time starts the clock rather than reading as idle for ever, so the first pass on an established machine evicts nothing. `--idle-hours` defaults to 24, the threshold `maintain` applies. `--plan` changes nothing and prints both sets it would take, and, for each idle checkout nobody is using, whether `retire` would refuse it (`retirementRefusal`). |
| `archive [path]` | Preserve the current (or given) workspace before it is removed: its commit is kept as a `slipjay-archive-<id>` bookmark the store cannot collect, and every file outside history is packed into a payload beside a manifest naming the commits, the base, the inventory and the payload hash. The payload is described by extracting it, and the manifest is written and fsynced last, so an archive a reader can find is one whose payload landed. It refuses a nested repository, an unresolved conflict its own change carries, unreadable files, and an archive over its size or file limits, and a refusal removes the bookmark it made; a conflict inherited from its base is history the archive already keeps, so a checkout whose own commits since its recorded start base are all empty archives and retires. |
| `restore <archive-id> [--name <name>] [--path <path>]` | Recreate a workspace from an archive on its recorded commit and unpack the payload, refusing a missing or altered payload rather than restoring something incomplete. `--name` and `--path` put it where a resumed thread expects it; the answer is one JSON line naming what it made, and the pass records a `restored` outcome. |
| `restore --latest --path <path> [--name <name>]` | Restore the newest archive of that checkout, which is what a harness resuming a thread can name: it knows where its workspace was, not which attempt archived it. |
| `archives` | List archived workspaces with their time, name, commit and inventory size. |
| `maintain [--json]` | The hourly pass: upgrade this machine's client (as `upgrade`; `--json` reports it as `upgrade`, and a failure never fails the pass), honour pending release requests, move the primary checkout onto the integration head, then evict idle checkouts past eviction's default 24 hours (as `evict` without `--idle-hours`). The move is the one `land` makes, but only for a checkout that holds nothing of its own: an empty working copy whose parents are integrated. Uncommitted edits, unlanded commits and conflicts leave it exactly where it is, so the pass never rebases a checkout someone is editing, and `--json` reports the outcome as `primaryCheckout` (`moved`, `current`, or `left` with a reason). It reads the integration head as of the last fetch, which every `start` makes. Every outcome is appended to `state/archive-outcomes.jsonl`, a request that cannot be read or honoured is kept and retried, and the pass never removes a workspace it has not archived. A repository the pass cannot read, such as one whose `jj` is missing from the invoking `PATH`, fails the pass with that reason rather than reporting nothing to archive or evict, and an eviction failure after a request was honoured still reports each request's outcome and exits 1. It also names every idle checkout `retire` would refuse, with the refusal reason — `cannot retire\t<name>\t<reason>` on stderr, or `evictions.unretirable` with `--json` — so a settled thread's refused retirement is visible in `maintain.log` instead of piling up unnoticed. |
| `retire <path> --operation <id>` | The one release operation a harness calls: snapshot the working copy, archive it, re-check that the archive still describes the checkout — its commit and every file outside history by bytes, mode and link target, again after the teardown and immediately before the forget — then retire it. The intent is written and fsynced before anything is removed, so a crash is reconcilable, and the result is durable at `state/retirements/<id>.json`. A replay answers the recorded result and acts on nothing. A refusal means nothing was removed; `uncertain` means a removal may have half-finished and must be reconciled. Exit codes: 0 retired, 1 refused, 2 uncertain. |
| `retire-result <operation-id> \| --path <path>` | Read one retirement record, or the newest record for a checkout — the form a resumed thread can use, since it cannot recompute the id. Exit codes match `retire`. |
| `retirements` | List recorded release operations with their state and workspace. |
| `cleanup [path]` | Remove the current (or given) workspace once it has landed or all its unintegrated work has archived published adoption coverage. The working copy is snapshotted once and judged; just before the workspace is forgotten it is snapshotted again, and if it changed in between, the workspace is kept (`working-copy-changed`) rather than orphaning the new commit. |
| `adopt <helper-path> [--json]` | From the lead workspace, duplicate the helper's non-empty commits after its recorded start base onto the lead and squash them into the lead's working copy, keeping its description. Records `{ workspaceName, base, revisions }` in lead metadata (printed with `--json`). Refuses unsnapshotted helper edits, merge commits, a base outside the lead's ancestry, changing helper revisions, conflicts (with paths and rollback), or more than 32 adopted revisions per landing. The start base is fixed when the helper starts, so rebasing a helper never changes it: when that base is rewritten or lands under another commit id (a stacked parent), the refusal names it and gives the recovery. That is a fresh helper from `slipjay start --base @-`, the original's changed paths restored into it with `jj restore --from <helper tip>`, its diff checked against the original's, and an ordinary `adopt`, keeping the original helper until the landing publishes (SJ-88). A live helper process does not block adoption. |
| `remove [--discard] <path>` | Remove a delivered or untouched workspace with no unique files; otherwise keep it and exit 1. Published adoption coverage also counts as delivery, including for an Issue-bound helper. `--discard` explicitly confirms deletion of uncovered unlanded work and Issue attachment, including new work after a previous landing. It never overrides pending runner facts, live processes or unique files. A landing record naming another workspace's archived artifact counts as no landing. A checkout missing most of the tracked files its sparse patterns include (an interrupted checkout looks like this, and so does deliberate mass deletion) is named as a partially written checkout, with the missing and expected counts, and is neither snapshotted nor removed by `remove`, `cleanup`, the sweep or `prune --plan`: inspect its last snapshot with `jj --ignore-working-copy -R <path> diff -r @`, restore it with `slipjay start --base <workspace>@` after copying out anything you need, run from another checkout (inside it JJ would snapshot the checkout), or delete it with `remove --discard`. Files outside a sparse checkout's patterns are never counted as missing or edited. |
| `guard` | Claude Code PreToolUse landing guard (reads the tool call on stdin). It denies moving or pushing the integration branch outside `land`, and a declared release branch outside `promote`. In a SlipJay workspace it also denies `jj new`, `jj edit`, `jj checkout`, `jj next`/`prev` and `jj workspace forget` (of the current or any named workspace) while the workspace left or forgotten has a non-empty, unintegrated `@` with no description (or only the generated one), telling the agent to `jj describe`, `jj abandon` or land it; that check runs one jj query in each workspace it would leave, inside that workspace's checkout so its unsnapshotted edits count (by its last snapshot when that checkout is missing or unreadable), and allows the command if jj cannot be queried. Each command is judged by the repository it targets (`git -C`, `jj -R`, else the working directory). |
| `cutover [--check]` | Move historical state from `~/.slipway` to `~/.slipjay` once (see [State and cutover](#state-and-cutover)). |
| `runner <serve\|log <operation>\|kill [<operation>]\|pause\|resume>` | Run the landing runner on this host, print one operation's run log, or use the owner's controls (see [Runner](#runner)). |

## Runner

The [runner contract](docs/runner.md) covers queueing, gates, held integrations,
owner controls, setup, restarts and moving hosts.

### Optional depth-two verification

See [Optional depth-two verification](docs/runner.md#optional-depth-two-verification).

### Remote verification on boat

See [Remote verification on boat](docs/runner.md#remote-verification-on-boat).
A repository can replace its runner-host gate place with a named SSH machine using
`gateMachine`, with boat as the fallback. See [Named SSH gate places](docs/runner.md#named-ssh-gate-places)
for configuration, attempt ownership and recovery.

### The runner host's gate place

See [The runner host's gate place](docs/runner.md#the-runner-hosts-gate-place).

### Independent screening lanes

See [Independent screening lanes](docs/runner.md#independent-screening-lanes).

### Deploys

See [Deploys](docs/deployments.md#deploys), including production migrations and activation.

### Reset

See [Reset](docs/deployments.md#reset).

### Audit

See [Audit](docs/deployments.md#audit), including promotion refusals and recording a cause.

## Release

The [release contract](docs/release.md) covers candidate selection, verification,
approval coverage, automatic and batched promotion, migrations, rollback and confirmation.
[Landing evidence and recovery](docs/landing-evidence.md) covers submission identity,
metrics, diagnostic artifacts, handoffs, Forge, repairs and retention.

<a id="forge-reads"></a>**Forge reads.** See [Forge reads](docs/landing-evidence.md#forge-reads).

<a id="forge-check-access"></a>**Forge access for checks.** See [Forge access for checks](docs/landing-evidence.md#forge-check-access).

<a id="forge-receipts"></a>**Forge receipts.** See [Forge receipts](docs/landing-evidence.md#forge-receipts).

<a id="repairing-a-failed-landing"></a>**Repairing a failed landing.** See [Repair workflow](docs/landing-evidence.md#repair-workflow).

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
  version-1 `slipjay-test-reports.json` manifest there, naming the selection it made;
  command exit status remains authoritative when a report is missing. `bun scripts/test-landing.ts --replay`
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

The snapshot's `repositories` lists every configured repository, its configured screening
places and landing/screen-failure counts since the runner host's local midnight. A
release entry reports the latest published candidate, the last **successful** production
deploy separately from its newest unsuccessful or open attempt, recorded health checks,
the next audit slot and the candidate's current hold. `release.staging` reports the same
`{ live, latestAttempt }` shape as `release.production`: `live` is the last successful
deploy (`commitId`, `deployedAt`, `healthy`), while `latestAttempt` is a newer running,
failed or rolled-back attempt (`commitId`, `status`, `at`, `reason`). Each is null
when there is no such ledger fact. `release.staging` itself is null when staging is
skipped or the repository declares no staging environment. Repository policy is recorded by
the queue's existing policy discovery and landing/deploy scheduling; until that first
successful read, its release entry is unknown and reported as null. Watch operations
carry the landing description's first line once fetched (or the submitted chore title),
and a one-based screening `lane` until that screen is admitted to authoritative work.

This reporting runs on the runner, not the watch client. Testing a new CLI against an
older runner does not add snapshot fields: the runner must also run the new source.
Snapshots use ledger data only, with no git or network calls. A declared deploy
environment named `images` supplies image-build status: the candidate's latest attempt
is preferred, otherwise the latest image deploy is shown. A candidate with no image
attempt yet, or one queued/running, waits on images. Repositories without that
environment report null.
Health is null on successful deployments that recorded no health-check timing. The
reported audit hold uses the same `promotionRefusal` as promotion itself: development
mode does not currently require a fresh green nightly audit before each promotion.

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

