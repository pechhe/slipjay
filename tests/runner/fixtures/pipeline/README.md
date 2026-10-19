# Captured pipeline logs

These event arrays were captured on 2026-10-14 from the actual SQLite operation
log used by the hermetic HTTP and runner queue integration tests. The runner
executed real JJ/Git transitions and bounded processes; verification commands and
publication outages were controlled test fixtures. These are observed test runs,
not Production evidence. Event sequences, operation/commit identities, timestamps
and measured durations are preserved. Only the temporary fixture root in command
text is replaced with `[FIXTURE]`.

Each file is one separate log; sequences must not be combined or renumbered.
The gate fixture reports `tests/fixture.test.ts > fixture > rejects the candidate`.
`held-recovered.json` includes failed publication, retries and eventual recovery.
`held-recovered-before-retry-attribution.json` preserves the earlier capture that
revealed a successful recovery retry was omitted from its counter. The later
capture distinguishes an executed retry from observing external publication.

Capture the source tests into a scratch directory with:

```sh
SLIPJAY_CAPTURE_PIPELINE_FIXTURES="$PWD/artifacts/pipeline-capture" bunx vp test run tests/runner/runner-queue.test.ts tests/runner/runner-api.test.ts -t 'queued candidates land|rebase conflict in the policy|gate failure preserves|owner.s kill stops a running gate|failed publication holds|unknown repositories|submissions create|migration-bearing change lands|cancel closes|cancelling queued'
```

Keep captured logs as historical fixtures; a new runner behaviour adds a new
capture rather than rewriting these observations to match it.
