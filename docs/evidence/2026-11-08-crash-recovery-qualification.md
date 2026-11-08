# SIGKILL, database outage and two-worker recovery qualification

## Gap
Graceful SIGTERM shutdown was qualified (PR #9-#11), but nothing exercised
what a clean shutdown never covers: a process killed mid-check, PostgreSQL
connections dropped and refused, or two Node workers sharing one database.

## Qualification
`scripts/qualify-crash-recovery.mjs` runs the built self-hosted Node server
(`apps/api/dist/server.mjs`) against a disposable local PostgreSQL database
and a local HTTP target it controls (up, failing or hanging). It refuses any
non-local or non-`montral_test_*` database. CI runs it on every push.

- **A. SIGKILL with a check in flight.** The target hangs, a scheduled check
  reaches it, and the server is SIGKILLed. No result is recorded for the
  killed run. After restart, the abandoned claim (whose `next_check_at` was
  already advanced) is picked up by a later tick without operator action, a
  newer run generation starts, and the monitor reaches `up`.
- **B. SIGKILL during an outage.** An auto incident is open; the server is
  killed mid-check and restarted while the outage continues. The same single
  incident stays open, the monitor stays `down`, and recovery resolves it.
- **C. Database loss.** All server connections are terminated every 2 s and
  new ones refused (`ALLOW_CONNECTIONS false`) for 40 s, spanning a
  scheduler tick. The process stays up, `/health` and the API answer
  afterwards, checks resume, and no incident is opened for a healthy target.
- **D. Two workers.** A second Node process joins on the same database during
  an outage. Results recorded equal runs started (claims use `SKIP LOCKED`,
  starts are generation-guarded), and exactly one outage incident is open. A
  failure soon after a resolution reopens that incident by design.

## Observed behaviour and limits
- Recovery latency after a restart is bounded by one 30 s tick, the stable
  per-monitor queue slot delay (up to 40 s) and the monitor interval; the
  script derives its waits from these constants (100 s here). Local runs
  retried the killed check 63-71 s after restart.
- A check writes its result, then updates monitor status in a separate step;
  an interrupted step is redone by the next check. A crash between the two can
  leave status one interval stale. This is the documented design, so the
  script waits for the final state rather than reading between steps.
- A check killed mid-flight is lost, not replayed (at-most-once start, as
  documented in `processCheckMessage`); the next scheduled run replaces it.
- Infrastructure failover (replica promotion, network partitions between
  hosts) is not simulated here.
