# Self-hosted Node scheduler tick/HTTP shutdown boundary

## Failure mode
A SIGTERM could arrive while a scheduler tick was still executing
runDueChecks() or database-backed housekeeping. PR #9 had added correct
in-process check-worker draining, but only the queue was awaited; the tick
itself was not tracked. Likewise the Node HTTP listener was asked to close
without awaiting in-flight requests. The shared database pool could therefore
close while admitted work was still using it.

## Change
A dedicated non-overlapping Node tick gate keeps an awaitable reference to
the currently admitted tick. After the first shutdown signal, it refuses all
future ticks. The self-hosted server now waits for both that tick and actual
HTTP close, concurrently with the existing running-worker drain; then and
only then closes the shared database. The original eight-second hard
shutdown deadline still exits nonzero if a dependency stalls. Unexpected
errors are logged as a fixed, secret-free diagnostic. No live providers,
billing, API auth or upstream source snapshots are changed.

## Evidence and limits
Four deterministic unit tests cover non-overlap, a mid-tick shutdown,
shutdown immediately after admission but before task start, rejection of
future ticks, idle stop and redacted error recovery. The complete prior
queue/scheduler regressions and supported Node CI are mandatory before merge.

The tick gate does not turn the local queue into a durable broker and cannot
recover work after SIGKILL, power loss, or a database outage. The hosted
long-running pruning/crash/failover and real multi-replica gates remain OPEN.
No deployment, live billing, user data or paid service was used.