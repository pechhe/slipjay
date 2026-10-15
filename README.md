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
| Landing state, locks and post-integration records | `~/.slipjay/state` |
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
   post-integration run that a pre-v1.0.0 Slipway left is held or live. Nothing changes.
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
| `SLIPJAY_WORKSPACE_NAME`, `SLIPJAY_WORKSPACE_PATH` | The `workspaceTeardown` command. |
| `SLIPJAY_MIGRATION_CONTEXT` | Late-bound migration generation and verification commands. The same trusted JSON provenance record is bound before generation; see below. |
| `SLIPJAY_FINALIZATION_COMMIT`, `_KEY`, `_TARGET` | Post-integration finalization commands and target probes. A policy's `environmentKeys` may not start with `SLIPJAY_FINALIZATION_`. |
| `SLIPJAY_RESET_TARGET`, `_SOURCE`, `_REASON_FILE` | The runner's `reset` command and target probe (see [Reset](#reset)). A policy's `environmentKeys` may not start with `SLIPJAY_RESET_`. |

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
bun add -g github:pechhe/slipjay#v3.16.0
slipjay status
```

To upgrade, remove the installed tag first, since `bun add -g` (even with `--force`)
keeps it otherwise, and check the version:

```sh
bun remove -g @pechhe/slipjay && bun add -g github:pechhe/slipjay#<tag>
slipjay --version
```

Never clear Bun's package cache (`bun pm cache rm`) to upgrade: projects that set
`globalStore = true` link every checkout's packages into it, so clearing it breaks
their dependencies. When a workspace's dependencies are damaged that way, `slipjay start`
and landing say how to repair them.

From Slipway, remove it first (`bun remove -g @pechhe/slipway`) and run
`slipjay cutover` once after installing.

The repository is public, so the `github:` tag form needs no authentication.

## CLI

`slipjay <command>` offers the same commands and behaviour as the earlier `slipway`
tool, plus `cutover` and what a Claude Code `WorktreeCreate`/`WorktreeRemove` hook needs without library
imports (`start --integration --issue <n> --json`, `remove <path>`):

| Command | Effect |
| --- | --- |
| `status` | Mode, current workspace, integration checkout and landing state (JSON). |
| `mode [isolated\|direct]` | Read or write the checkout mode. |
| `list` | Workspaces with their state, Issue and retained material. |
| `pool [refill]` | Show ready spare workspaces, or provision one (up to `spares`). |
| `prune --empty` | Remove empty workspaces, empty workspaces of a closed Issue, and state left by workspaces that no longer exist. |
| `attach-issue <n>` | Bind the current workspace to Issue `n`. |
| `start "task"` | Assign an isolated workspace for a task and print its path. An empty, undescribed change is described `wip: <task> (#<n>)` so abandoned work is never anonymous; landing replaces exactly that generated text (recorded in the workspace metadata) with the Issue title or task, never publishing it; a description you write, `wip:` or not, lands as written, and a stack with the placeholder left on a lower commit is refused. A new workspace is based on the integration branch freshly fetched from the declared remote (best effort: offline, it starts from the local branch). |
| `start [--integration] [--issue <n>] [--refill] [--json] ["task"]` | `--integration` allocates from the integration checkout even inside a workspace; `--issue` creates or resumes that Issue's workspace (the task defaults to `Issue #<n>`); `--refill` then starts a background spare refill (a claimed spare is always refilled); `--json` prints one JSON object (`workspacePath`, `workspaceName`, `integrationRoot`, `issueNumber`, `created`, `reused`, `pooled`, `refill`) and sends all install output to stderr. |
| `preview` | Diffstat of what a landing would integrate. |
| `record-preview <port>` | Record a host's started workspace preview in the runner ledger. |
| `metrics [--since <ISO date>]` | Pipeline outcomes, causes, stage and queue percentiles, held integrations, attempts and flake candidates from the runner ledger. |
| `land [--direct]` | Send the current workspace (or, with `--direct`, the primary checkout) to the runner, which verifies, integrates and publishes it (see [Runner](#runner)); without a runner location it refuses. Afterwards it removes the landed workspace itself, as `cleanup` would: this process and the session that ran it do not keep it, but any other process with its working directory inside does, and is named with its pid and command (the shell's directory is gone once it is removed, so `cd` to the primary checkout). It also sweeps other delivered workspaces, saying why it kept any. |
| `promote [--confirm <commit>] [--migrations-ready]` | Plan a promotion of the integration branch to the declared release branch, or have the runner verify and publish the confirmed candidate (see [Release](#release)). |
| `deploy <environment>` | Have the runner deploy the integration branch's latest commit on the remote to a declared environment now, and follow it (see [Deploys](#deploys)). |
| `deploys [--environment <name>] [--json]` | Each deploy, newest first: environment, commit, outcome per project, and the commits it added since the previous deploy. |
| `reset` | Have the runner reset the repository's declared `reset` target now (or follow its open reset) and print the verdict as JSON; exits 0 once it is `reset` (see [Reset](#reset)). |
| `cleanup [path]` | Remove the current (or given) workspace once it has landed. The working copy is snapshotted once and judged; just before the workspace is forgotten it is snapshotted again, and if it changed in between, the workspace is kept (`working-copy-changed`) rather than orphaning the new commit. |
| `remove <path>` | Remove the workspace at `path` if it has landed or is untouched; otherwise keep it and exit 1. |
| `guard` | Claude Code PreToolUse landing guard (reads the tool call on stdin). It denies moving or pushing the integration branch outside `land`, and a declared release branch outside `promote`. In a SlipJay workspace it also denies `jj new`, `jj edit`, `jj checkout`, `jj next`/`prev` and `jj workspace forget` (of the current or any named workspace) while the workspace left or forgotten has a non-empty, unintegrated `@` with no description (or only the generated one), telling the agent to `jj describe`, `jj abandon` or land it; that check runs one jj query in each workspace it would leave, inside that workspace's checkout so its unsnapshotted edits count (by its last snapshot when that checkout is missing or unreadable), and allows the command if jj cannot be queried. Each command is judged by the repository it targets (`git -C`, `jj -R`, else the working directory). |
| `cutover [--check]` | Move state from `~/.slipway` to `~/.slipjay` once and retire the `slipway` CLI (see [State and cutover](#state-and-cutover)). |
| `runner <serve\|log <operation>\|kill [<operation>]\|pause\|resume>` | Run the landing runner on this host, print one operation's run log, or use the owner's controls (see [Runner](#runner)). |

## Runner

`slipjay land` sends the change to one long-lived runner; it is the only way a
change lands. The runner queues landings and takes each repository's one at a time
in arrival order by default. For each one it rebases onto the integration tip,
runs the repository's declared gate in its own warm checkout, then integrates and
publishes. A change that contains a merge, such as an upstream update merged into
the integration line, lands as a merge: only its first-parent line moves onto the
tip, and the merged-in history is kept rather than copied, so the integration line
must be the merge's first parent. The authoring machine runs none of the gate. Resets take turns in the
same repository's queue. A confirmed release verifies in a release queue and a
checkout of its own, beside the repository's landings, and takes a turn in the
repository's queue only to publish (see [Release](#release)). A release and a reset
of one repository never overlap, and a repository in a shared `lane` verifies its
releases in that lane, since its gates share external state.

Each gate command gets a temporary directory (`TMPDIR`) of its checkout's own, emptied
at each turn, so a lock or file a gate keeps there never makes another operation wait:
the runner's `limits` bound concurrent runs together.

- **Workers.** Different repositories share no checkout, branch, reset target or
  environment, so their queues run at once: at most `workers` of them (runner config,
  default 2; `1` is a single queue for every repository). Repositories whose gates do
  share external state (a database, a deploy environment, fixed ports) must share a
  queue: give them the same `lane` in the runner config's `repos` entries. When every
  worker is busy, the next operation of an idle queue waits, oldest first, and names
  what holds the workers (`a worker (landing …)`); one waiting behind its own queue
  names the running operation, or the release or reset holding it. A release holds a
  worker from verification until it has published.
- **Limits.** On a systemd host every run, deploys included, joins `slipjay.slice`, so
  the workers' gates and everything they start share one cap: `limits` in the runner
  config sets `memoryHigh` (throttled above, default `40G`), `memoryMax` (the hard
  ceiling, `48G`), `cpuQuota` (`1400%`) and `tasksMax` (`4096`). The runner sets them
  as runtime properties at its first run after each start; if systemd refuses, the
  run fails before its command starts. Dependency installation and post-integration
  commands use the same executor and budget as gates and deploys.

### Optional depth-two verification

A runner repository entry can set `verificationDepth: 2` (default `1`) only when
its gates are safe in independent checkouts, dependency trees and temporary
directories, without shared database writes or other mutable external targets.
This is an explicit configuration assertion about the gate, not an inference from
its repository name. A configured shared `lane` cannot use depth two. The executor
must enforce combined resource limits; an uncapped executor refuses this setting.
Each admitted operation holds one worker until its terminal outcome.

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
  (`{ "executable", "args"?, "cwd"? }`), run in the runner's checkout.
  A policy declaring its former name, `requiredLocalVerification`, is refused.
  A policy declaring `postLandVerification` (no longer run)
  is refused; move its checks into the gate or remove it.
- **Location.** One value: `SLIPJAY_RUNNER`, or `"runner"` in `~/.slipjay/config.json`.
  On the runner's host it is `http://127.0.0.1:7787`. Elsewhere it is
  `ssh://<host>`, and `land` opens an SSH port forward for the duration of the call
  (the host must be reachable with key auth). Without a location, `land` refuses.
- **Credential.** A bearer token: `SLIPJAY_RUNNER_TOKEN` in the environment, or else
  the Bitwarden Secrets Manager key of that name, read through `bws`. A request
  without it is refused. The runner binds loopback only.
- **What `land` prints.** One line per stage, naming the runner and the queue
  position. Then a summary: the verdict, the failing command's output verbatim on
  failure, and `slipjay runner log <operation>`, which prints retained operation events from any machine with the location. Interrupting `land` stops following but
  not the landing. Running `land` again in the same workspace reattaches to the same
  operation (or, if it landed meanwhile, finishes the workspace housekeeping, even when the working copy is left empty on integrated history); it never submits twice, and never submits a commit already on the integration branch. While an older commit of the change is running, `land` follows it instead of moving its bookmark, then asks you to land again. Set `SLIPJAY_RUNNER_VERBOSE=1` to see every
  progress line.
- **Transport.** The client publishes the change as the bookmark
  `slipjay/changes/<changeId>` and submits it by jj change ID. The runner fetches it
  on its turn and deletes it when the operation closes.
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
- **Owner controls.** From any machine with the location, `slipjay runner kill <operation>` stops
  that running landing or release while it is still fetching, rebasing, installing or
  verifying, and a reset while it is fetching or resetting: verification's and the
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
  commands go in their own systemd user scope when the runner has a user manager
  (`XDG_RUNTIME_DIR` set, as under the setup's unit), so a kill also reaches
  processes a gate tool started in a separate process group; the scope is cleared
  after every run, so a gate cannot leave processes behind. Elsewhere, such as macOS,
  only the run's process group is killed.
- **A release that breaks the runner.** The runner runs the SlipJay version
  installed on its host, so a broken release cannot land its own fix. Reinstall the
  previous tag there (`bun add -g github:pechhe/slipjay#v<previous>`), restart the
  runner unit, then land the fix.
- **State.** The runner's own state lives in `~/.slipjay/runner`:
  - `config.json`: the name, the listen port, the repositories, keyed `owner/name` with their git URL,
    and `jj`: settings set as repository config in every warm checkout. It must name `user.name` and
    `user.email`, the identity the runner commits as (use an email GitHub links to the owner);
    the runner also sets `snapshot.max-new-file-size` to 64MiB unless `jj` overrides it, so none of these depend on the host's jj config.
  - `operations.sqlite`: one append-only event log; operations, queue positions and runs are projections of it.
  - `logs/<operation>.log`: the run logs. A reset's step output goes to the owner-only
    `logs/<operation>.reset-output` beside it, never into the log.
  - `repos/<owner>/<name>`: the warm checkouts; `releases/<owner>/<name>`: each repository's release checkout.
  - Finalization receipts and target outcomes stay in
    `~/.slipjay/state/post-integration`. Held-integration retries rely on them; move them with the runner.

  On restart, queued operations resume. A landing that was running is recorded as
  landed if its commit already reached the remote, and as failed ("land again")
  otherwise. A release that was running is recorded as failed with the
  `slipjay promote --confirm` command that reruns it. A reset that was running is
  recorded as failed ("run slipjay reset again"); the schedule waits a full interval
  after it. A deploy that was running is
  recorded as failed, and the schedule deploys that commit again; a production
  deploy's failure names the `slipjay promote --confirm` that deploys it again. A
  restart can stop a promotion's deploy between activations: projects it already
  activated keep serving it, nothing moves them back, and its migrations may have been
  applied, so the rerun is not rolled back automatically if it carries non-additive
  ones (a deploy with no record cannot show the schema untouched).
- **Moving the runner to another host.** Run Setup on the new host with the same
  repositories, give it what their steps need (YardSmith: a logged-in `vercel`), and
  stop its unit. On the old host, `slipjay runner pause`, wait until no operation is
  running and none is held (the last one landed or failed before integrating), then
  stop its unit. Copy `operations.sqlite`, `logs/` and `~/.slipjay/state/post-integration`
  to the new host (warm checkouts are cloned again on first use), start its unit,
  point each machine's location at it (`"runner": "ssh://<new host>"`, or
  `http://127.0.0.1:7787` on the host itself), and `slipjay runner resume`: the pause
  moved with the log.
- **Setup.** On the runner host, with `slipjay`, `jj` and `bws` installed and the
  Bitwarden secret `SLIPJAY_RUNNER_TOKEN` saved:
  `scripts/setup-runner.sh pechhe/YardSmith=git@github.com:pechhe/YardSmith.git`.
  The commit identity comes from `SLIPJAY_RUNNER_USER_NAME` and `SLIPJAY_RUNNER_USER_EMAIL`,
  else git's global user. It writes the config and a systemd user unit that runs `bws run -- slipjay runner
  serve` with `Restart=always`, and enables lingering so the unit survives logout and
  reboot. Logs: `journalctl --user -u slipjay-runner`.
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
  demand (`slipjay deploy staging`) or by the next landing. Scheduling is rebuilt from
  the log at startup.
- **Where.** Deploys take turns in their own lane, so a deploy waiting minutes on its
  build never holds a landing. Each project's command runs, one after another, in an
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
  two commands run in the same source view and environment as its projects, after
  every project passed its check and before any activates. `verify` exits 0 when the
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
  and each project's outcome. A deploy that failed before its projects ran (the commit
  is not on the integration branch, or the runner restarted) records only its reason.
  `slipjay deploys` reads them back. The contract is `src/lib/runner-contract.ts`.

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
code only. The plan's `nonAdditiveMigrations` names migration artifacts that drop,
rename, retype, delete or rewrite something, or tighten what an existing table accepts
(a heuristic, `nonAdditiveSql` in `src/lib/release.ts`: it does not flag tables or
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
   `halfBuiltSpecs` lists each open Spec (the open, non-`programme` parent Issue of
   an Issue a commit in the range served, by its `Issue:` trailer or `(#N)`) with
   its closed and total Tickets, so the approver sees a partly delivered feature.
   It only warns. Without a GitHub remote, or when `gh` cannot answer, it reads
   `{ "checked": false, "reason": … }` and the release goes ahead; `--confirm`
   checks again.
2. After explicit human approval of that candidate, `slipjay promote --confirm
   <commit>` checks locally that the candidate is published on the integration
   branch (and, for a release that is not a promotion and carries migration
   artifacts, that `--migrations-ready` was given), then
   submits it to the runner (see [Runner](#runner)); a confirm needs a runner
   location. Releases take turns in their repository's release queue on the runner,
   beside its landings: the runner checks the exact candidate out in the release
   checkout, prepares its dependencies and runs the checks while landings go on.
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
`slipjay metrics [--since <ISO date>]` reads that ledger and prints outcomes, cause
classes, median and p90 stage and command durations, active and paused queue waits,
held integrations, attempts per change, and flake candidates. The default range
starts at midnight UTC today. Older operations retain their original evidence;
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

A source correction uses a durable repair claim:

```sh
# From the repair worker's assigned isolated checkout of the same repository:
slipjay runner repair-claim <failed-operation>
slipjay runner source <failed-operation> /path/to/new/recovery.bundle
# Import the bundle with importSourceBundle; edit the retained source revision,
# preserving its logical jj change ID. Fix and run focused checks, then:
slipjay land
```

The claim capability is stored and flushed in private workspace metadata **before**
the claim request; its confirmed identity is retained before CLI success. A new CLI
process retries the same capability after response loss. stdout and ledger events
never contain its token. Ordinary `land` carries the matching workspace capability
and records a new `repair_proposed` attempt linked to the original failure. The old
attempt, source and failure are immutable history. This command does not waive the
normal independent review/gate requirements.

`GET /v1/operations/:id/repair` reports whether the logical change has ever been
fenced and its public current claim. `POST` accepts `claim` with `workspace`, `by`
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

Cause rules in `src/lib/failure-classification.ts` carry their version on every
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
`src/` closure imports only itself, Node built-ins, `effect` and `proper-lockfile`,
with no runtime cycles (type-only imports are not edges). A host that brokers child processes injects its broker with
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
  test suite (`bun run test`) concurrently.
- **At release**, `bun run verify:release` runs the complete suite again
  against the exact commit to be tagged. It prints that commit and exits non-zero
  on failure. Tag only a commit it passed. To trace a release failure to its
  landing, bisect `<last tag>..main` and read the commit's `Issue:` trailer.

Every Vitest file runs under its own disposable `HOME`
(`scripts/vitest-hermetic-env.ts`). `scripts/hermetic-home-guard.ts` fails a test
that would otherwise write the real `~/.slipjay` or `~/.pi`. The cutover tests build
pre-v1.0.0 state in that disposable `HOME` and never touch the real one. Run a single file with
`bunx vp test tests/<file>.test.ts`.


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

### Native Mac menu bar

The SwiftUI app runs the installed `slipjay watch --json` CLI; it holds no credential,
SSH forward or HTTP client. Its direct CLI default is `~/.bun/bin/slipjay`; set
`SLIPJAY_CLI` to an explicit executable path when launching a different installation.
Its child environment includes `~/.bun/bin`, `~/.local/bin` and system tools.
The app persists its last applied cursor and supplies `SLIPJAY_WATCH_CURSOR` only
to its watch child. It queues notification proposals before saving the cursor,
retains pending notifications across restarts, and deduplicates accepted notices.
First install starts from the snapshot; later starts can notify for up to 100 recent
events that occurred while the app was stopped.
Launch and wake give the watcher a 60-second reconnect window before silence can
raise contact-loss attention or notifications. A never-connected app counts its
five-minute unreachable threshold from the current launch. Wake promptly replaces
the watcher while preserving the saved cursor and pending notification backlog.
The menu shows the queued and running landings, releases and resets (each repository
in order), the deploy lane, runner-owned timing, held and paused state,
staging attempts, the last three completed Production deploys and release outcomes,
and contact. The latest completed Production failure per repository affects the
needs-attention icon independently of releases; a successful retry clears it.
Landing rows show their change IDs, ages use seconds/minutes/hours/days, and
disconnected or stale lanes are labelled as the last known state.
The hourly suite remains unavailable
until its producer exists. Controls use existing CLI authority; queued cancellation
and kill each ask for confirmation naming the operation, a kill sends that operation's
id and nothing once it is past its killable stages, and a cancel that lost the race to
the runner says the operation already started. Unsafe kill stages are disabled. Logs open in a native
window through `slipjay runner log`, without a shell.

On the Mac with Command Line Tools (full Xcode is unnecessary):

```sh
bash scripts/menu-bar.sh build
bash scripts/menu-bar.sh test
bash scripts/menu-bar.sh install '<your signing identity>'
bash scripts/menu-bar.sh status
```

Installation verifies the signature, preserves the previous bundle and login plist
under `~/Library/Application Support/SlipJay/backups`, and registers a RunAtLoad
LaunchAgent with KeepAlive disabled so Quit stays quit. The stable bundle identifier
is `com.pechhe.slipjay-menubar`; use the same signing identity for upgrades. To recover,
boot out that LaunchAgent, restore the saved bundle and plist, then bootstrap the
restored plist. `SLIPJAY_SIGNING_IDENTITY` can supply the identity instead of argument 2.

Release and needs-attention notifications are on by default; landing failures are
opt-in. Delivered event-driven notices cover release verification, publication and
failure, Production deployment and rollback, and optional landing failures.
Release coalescing, fallback resubmission and hourly-suite notices remain deferred
under Spec #38: their runner producers are not implemented. A superseded landing
does not mean a release shipped. The notification fixture is generated by
`bun scripts/menu-notification-fixture.ts` from the typed runner ledger projection,
checked by TypeScript tests and decoded by Swift tests.
The app requests actual OS permission and shows denial in its menu. Dedup keys
persist across reconnect/restart and are saved only when the OS accepts a notification
request; the latest 2,048 accepted identities are retained in acceptance order.
Pending event notices expire 24 hours after their event time, including across
restarts and permission changes. Undated pending notices from older installations
are discarded. Lifecycle fixtures and Swift terminal-event constants are generated
from the TypeScript runner contract with `bun scripts/menu-lifecycle-fixture.ts`;
TypeScript drift checks and Swift decoder tests consume the generated output.
Clicking an operation notification opens its run log. Signature/build tests
prove neither OS notification delivery nor menu rendering: those need installed-Mac
acceptance. Linux landing gates do not run or claim these Swift checks.

For a static fixture launch (EOF does not reconnect), run the built executable with
`--fixture <absolute-jsonl-path>`. This exercises native menu/permission behavior without
controlling live work; never kill or cancel a real operation merely to test controls.
