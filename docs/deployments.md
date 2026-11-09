# Deployments, resets and audits

### Deploys

Deploy records add `startedAt` (ISO timestamp) and `durationMs` for overall elapsed
execution, measured by the runner from admission through any release-branch
compensation, including source preparation and cleanup. Each project's optional
`timings` maps `build` (build/prepare), `migrate`, `health`, `activate` and `rollback`
to `{ startedAt, durationMs, outcome }`, where outcome is `passed` or `failed`.
Only steps whose commands ran have intervals; a shared migration runs once and its same interval
appears on every project. Activation and rollback retain their serial order.
`slipjay deploys` prints these intervals and outcomes, and `--json` carries the
fields in `record`. Older records without timings remain readable and printable.

A repository can declare environments the runner deploys. `staging` follows the
integration branch; `production` takes a new commit only through a promotion (see
[Release](release.md#release)), never on a schedule. `slipjay deploy production` redeploys the
commit production serves, whatever the branch tip, so an environment change applies
without a code commit; it is refused while production serves nothing yet or a production
deploy of another commit is open, and fails without deploying if production serves another
commit by the time it starts. Any other environment
follows the integration branch as `staging` does and says so with
`"followsIntegrationBranch": true` (a misspelt `staging` is refused): YardSmith's `images`
builds each landing's container images this way, with a `minIntervalMs` of 0.

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
- **Where.** Deploys use their own admission budget, outside `workers`: at most one
  per repository and `deployWorkers` across the runner (default 1, a whole number
  of at least 1 in the runner config). Raising it allows different repositories to
  deploy together. Landings, releases, resets and pre-verifications keep their
  existing worker rules. All commands still share `slipjay.slice` CPU and memory
  limits; without enforced combined limits the runner serializes commands and
  refuses multiple deploy workers. Queue reasons name the operation holding a
  needed place. Deploys take turns within each repository, so a deploy waiting minutes on its
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
- **Prebuild.** Production with a `machine` may declare `prebuild`, a command that builds what the deploy
  will need. A batch check a release waits on (`slipjay promote --confirm`, or a scheduled slot's) starts it beside the
  check, on the fixed machine serving the pool, in a source view of the head, with the deploy's environment and machine
  variables. A landing waiting for a scheduled promotion starts it 15 minutes before the slot as well, for what the slot will
  promote (the newest pre-verified candidate, else the newest landing), so a slot whose candidate was already checked
  in the background deploys images that are built; nothing new to promote builds nothing. A build of a commit already
  running is not started twice. It keeps going after the check ends, so the deploy must tolerate it still running: the command takes its own lock, and
  running it twice must be safe. Nothing depends on it: a failure is only logged and the deploy builds what it did not. It
  never runs on boat, so a check nobody promotes never starts a VM, and a background check starts none.
- **Build machine.** An environment may name a `machine` pool (`"machine": "images"`). Its
  deploy then has the repository's build machine leased to it (a production redeploy of the
  commit production serves leases none, so it runs while boat is down). A fixed machine in the
  runner config whose `buildPool` names the pool goes first: it holds the commit in
  `~/.slipjay-builds/slipjay-<owner>-<name>-<pool>.git` and bills nothing. When it cannot be reached the deploy says
  so and leases from the runner's remote
  verifier (see [Remote verification on boat](runner.md#remote-verification-on-boat)): the boat VM
  `slipjay-<owner>-<name>-<pool>`, forked from the gate's image when missing and resumed when
  stopped, living for twice the environment's `timeoutMs` until its deploy ends and then fifteen idle minutes,
  after which boat stops it and keeps its disk, Docker build cache included. The runner first sends it the deployed commit as a Git bundle of
  what it lacks, into its own bare repository, and gives every command of the deploy
  `SLIPJAY_MACHINE_SSH` (an executable that runs ssh to the VM with the arguments it is
  given: options, then the remote command) and `SLIPJAY_MACHINE_GIT_DIR` (that repository).
  The VM holds no credential for this host: anything it must reach here goes through a
  tunnel the command opens (`-R`). Deploys take turns within a repository, so a machine
  serves one deploy at a time. The record carries the `machine` and what boat billed while
  it was leased. A machine boat cannot supply or reach fails the deploy before any command
  runs, with `Remote executor unavailable (boat): …`; so does a runner with no remote
  verifier. Restart recovery cleans only the gate's numbered slots, never a build machine.
- **Production migrations.** `production` may declare `migrations: { verify, apply }`,
  two commands run in the same source view and environment as its projects. For a
  promotion whose migration files are all additive they run before any project
  deploys, so the health checks run the new code on its own schema (the code production
  serves already fits an added schema); a failure there deploys nothing. Otherwise (a
  non-additive migration, see [`nonAdditiveMigrations`](release.md#rollback-and-non-additive-migrations) (a file declaring
  itself `-- slipjay:previous-release-compatible` counts as additive), or a rerun deploy that does
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

- **When.** Omit `intervalMs` for an on-demand-only target: `slipjay reset` still runs
  it, and the runner never schedules it. With `intervalMs` (one hour to 30 days), the
  next scheduled reset starts that interval after the latest reset that ran its
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
  not run. The command must finish within `timeoutMs` (at most an hour: a whole-database
  reset runs its migrations and then two seeders).
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
`timeOfDay` (24-hour `HH:MM`) and `timeZone` (an IANA name) default to 02:00 Europe/London. A command may also
declare `inconclusiveExitCodes`: exit codes that mean that command could not judge the suite (below). They may not
include 0, 1 or anything from 126 up; any other value refuses the policy. A command with no declaration behaves as
before, and an older runner ignores the field, safely leaving those exits as failures.

- **When.** Once for every scheduled time on the zone's clock, which follows daylight saving, not
  an interval after the last run. The latest time that has passed is covered once an audit for it
  reached a verdict, green or failing; until then an audit is submitted at once. So a time the
  runner missed (it was down, or the repository declared the audit only now) and a run that was
  cancelled or killed are submitted again at the next opportunity (a queued audit's cancellation
  is one), and several missed times are one run. A failing audit is a verdict: it is not retried before the next time. The schedule
  reads `audit` at the repository's integration head, so a repository audits without any landing
  in the ledger; it is rebuilt at startup and after every landing and every audit.
- **Where.** An audit takes its repository's lane like a landing and waits its turn behind queued
  work. It never runs beside a deploy on the runner: it waits while any deploy runs, naming it, and
  no deploy starts while it runs (the deploy names the audit instead), since a deploy's load fails
  tests that fit their bounds on a quiet host and the audit's verdict gates promotion. With the
  default single deploy worker it starts as soon as the running deploy ends; with several
  `deployWorkers`, deploys that keep overlapping can hold it back until they stop. Work queued
  behind it in its lane is not held back meanwhile. The runner fetches the
  integration branch, resolves the published head, records it (`audit_head`), checks that exact
  commit out and runs the commands in order, with the landing gate's bounds. It leaves the
  integration bookmark alone, so a held integration stays held. `runner kill` stops it while it
  verifies. A head that declares no audit ends the audit `cancelled`.
- **Green.** Only an audit whose commands all ran and passed counts: none skipped (a command
  whose capability is unavailable fails the audit rather than passing it) and none reused. It
  ends `audited` with its commit and commands. A failing command ends it `failed`, as for a landing.
  A runner restart mid-audit records it `cancelled` (interrupted) and the schedule runs it again;
  neither is a verdict.
- **Inconclusive.** An audit is inconclusive only when every failure in it is a non-zero exit from a command that
  declares that exit code in `inconclusiveExitCodes` — so a `verify:release` that exits 2 as `UNVERIFIABLE` on a dirty
  checkout, while exiting 1 for a real failure, makes the audit inconclusive, but a failing test, a red suite, a
  timeout, a failed install, another exit code, or an undeclared command failing alongside a declared one is an
  ordinary failure. Output text never decides; the result is fixed on the audit's `failed` terminal event when it
  ends, from the policy that ran, and old audits stay failures. An inconclusive audit is never green: it does not move
  the last green audit, does not clear or hide an open failure, is not one of its suspects, and does not stop the
  repository being reported overdue. It covers its scheduled slot like a failing audit, so the next one runs at the
  next scheduled time. Cancelled, interrupted and killed audits keep their treatment: they neither count towards nor
  break a run of inconclusive audits. One inconclusive audit after a green one leaves automatic promotion and
  `slipjay promote` free to proceed, and the ledger, `slipjay metrics`, `slipjay audit` and the watch snapshot show
  it as inconclusive with the last green audit unchanged. Two inconclusive audits in a row refuse promotion, naming
  both and stating what last judged the repository.
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
  Two inconclusive audits in a row refuse promotion the same way. `slipjay audit cause` accepts any of its cause
  kinds for that refusal too: the cause covers the inconclusive audits up to when it was recorded and the count then
  restarts, so one command cannot switch the bound off, and a green audit also clears it. With an open failure as
  well, the failure is answered first and the two are lifted separately. A lifted refusal takes effect at the next
  promotion trigger, including the promotion schedule; nothing new wakes promotion when an audit ends or a cause is
  recorded.
- **Overdue.** `slipjay audit` flags a repository overdue when its last green audit finished more
  than 26 hours ago (when it has never been green: since its first audit).

`GET /v1/audits?repo=<owner/name>` lists a repository's audits, newest first, with the summary
above; `POST /v1/audits/cause` records a cause (`src/lib/runner/runner-types.ts`). The ledger reads
are `auditSummary` in `src/lib/release/audit-ledger.ts`.
