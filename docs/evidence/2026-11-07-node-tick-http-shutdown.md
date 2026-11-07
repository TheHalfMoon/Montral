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
## Real Node SIGTERM follow-up qualification (separate draft)

The hosted Chromium fixture now verifies the actual self-hosted Node child's
SIGTERM exit code after its disposable PostgreSQL browser journey succeeds.
It allows the Node server's existing eight-second hard shutdown bound to run
(with an independent 10.5-second observation limit), and reports a fixed error
if the process is killed, fails or does not exit in time. Failed browser tests
still use the short cleanup fallback so the original browser error remains
visible. No secret values or live data are included in the result.

This extends test *coverage*, not a claim that actual hosted SIGKILL,
network outages, in-flight leased monitor recovery, long-running pruning,
HA failover, reverse proxy isolation or disaster recovery are qualified.
The real-process smoke must pass exact-head hosted app CI and source integrity
before this follow-up is merged. Public release remains NO-GO.
