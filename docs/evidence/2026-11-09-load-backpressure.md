# Load, capacity and backpressure qualification (self-hosted Node)

## Gap
Crash, failover and queue backpressure were each qualified on their own, using
a few monitors. Nothing measured the self-hosted Node server
(`apps/api/dist/server.mjs`) under sustained load: scheduler throughput and lag,
the 512-message local queue actually filling up and draining, webhook ingestion
at volume, dashboard reads over a large project, or a small database pool.

## Qualification
`scripts/qualify-load.mjs` runs in CI through `.github/workflows/montral-load.yml`
(push to main, pull requests, manual dispatch). It runs the built Node server
against a PostgreSQL `postgres:18.6-alpine` service with a disposable
`montral_test_load_ci` database, and refuses any non-local or
non-`montral_test_*` database. Everything is synthetic and local: monitors
target an HTTP server inside the script, and the webhooks come from the script.
The JSON summary is uploaded as the `montral-load-summary` artifact.

Completion lag is measured by a test-only statement-level trigger, installed in
the disposable database after migrations. It logs each claim (the due time and
the new `run_generation`) and each release. Lag is
`monitor_observation.observed_at - due_at` for the same monitor and generation.
The trigger adds one small `INSERT ... SELECT` per `UPDATE monitor` statement
and does not change any app query.

Phases, in order, against one server (`DB_POOL_MAX` default 10), then a
restarted one:
1. **Throughput.** 4,000 HTTP monitors at the API's minimum 60 s interval,
   with due times spread over the interval, driven only by the server's own
   30 s tick. Run time: 90 s warm-up, then a 300 s measurement window.
2. **Backpressure.** The target answers every request after 10 s (inside the
   monitors' 15 s timeout). The script waits until the queue refuses batches
   and releases claims, holds that state for 90 s, then makes the target fast
   again and measures the drain.
3. **Webhooks.** 5,000 POSTs at concurrency 50, spread over 50 inboxes in
   5 projects (100 per inbox, under the 120/min per-inbox limit). Then three
   200-request bursts at concurrency 50 against one inbox, each burst in a
   fresh 60 s window.
4. **API reads.** `GET /api/monitors` for the 4,000-monitor project (100
   requests, concurrency 10). The public status page summary (2,000 requests,
   concurrency 50). The full public board (500 requests, concurrency 20).
5. **DB pool exhaustion.** Graceful SIGTERM, then a restart with
   `DB_POOL_MAX=2` and `--max-old-space-size=512`. For 240 s the script runs
   all 4,000 monitors, 20 closed-loop readers (2 on `/api/monitors`, 18 on the
   summary) and 2,000 more webhooks.

Phases 3 and 4 run with all 4,000 monitors still checking in the background.
Afterwards both servers are stopped with SIGTERM, and the integrity checks run
on the idle database.

## Results (green run 42577788904, commit 979a583)
Runner: GitHub-hosted `ubuntu-latest`, 4 vCPU and 16 GB RAM (`nproc` 4,
15,983 MB total memory). Node 24.22.1. PostgreSQL 18.6 (Alpine) service
container on the same host.

| Measurement | Value |
|---|---|
| Checks completed (300 s window, 4,000 monitors at 60 s) | 20,042 = **4,008/min** |
| Completion lag p50 / p95 / p99 / max | 36.1 / 61.5 / 68.6 / 71.5 s |
| Results per monitor in the window (expected 5) | 4: 32, 5: 3,901, 6: 67 (min 4, max 6) |
| Server DB connections (pool 10) | max 10, no lock waits |
| RSS during throughput | 111 to 352 MB, levelled off at about 347 MB |
| Backpressure: queue full after | 170 s; 3,968 claims released, 4 refusal log lines |
| Checks in flight at the slow target | max 80 (4 messages x 20) |
| Checks/min and lag while slow | 289/min; lag p95 273 s |
| Claimed but unstarted runs | max 11,427 (bound 13,800 = 512 x 25 + one 1,000-claim round) |
| RSS while slow, then draining | 352 to 378 MB, then 378 to 393 MB |
| `/health` while slow (1 probe/s) | p99 4.6 ms, max 5.6 ms, 0 failures |
| **Recovery** (backlog drained, last-60 s lag p95 back under 90 s) | **131 s** |
| After recovery (120 s window) | 4,040 checks/min, lag p95 70.7 s, every monitor checked |
| Catch-up after recovery | up to 5 results for one monitor in the first 120 s |
| Webhook fan-out (5,000 at concurrency 50) | **259 accepted/s**, all 202; p50 / p95 / p99 175 / 303 / 471 ms; stored 5,000 (5,000 distinct ids) |
| Hot inbox (3 x 200) | exactly 120 x 202 + 80 x 429 per burst; 360 accepted; **stored 250** (retention cap) |
| `/api/monitors`, 4,000 monitors, 5.3 MB response | 6.1 req/s; p50 / p95 / p99 1,598 / 1,936 / 2,103 ms; 0 errors |
| Status summary (concurrency 50) | 142 req/s; p50 / p95 / p99 339 / 427 / 463 ms; 0 errors |
| Full status board (concurrency 20) | 205 req/s; p50 / p95 / p99 95 / 155 / 175 ms; 0 errors |
| RSS during reads and webhooks (pool 10) | max 689 MB |
| `DB_POOL_MAX=2`: server connections | max 2 |
| `DB_POOL_MAX=2`: monitoring | 2,694 checks/min (cannot keep up with 4,000/min), lag p95 168 s, every monitor still checked |
| `DB_POOL_MAX=2`: reads | summary p95 685 ms (10,370 requests), `/api/monitors` p95 1,491 ms (484 requests), 0 errors |
| `DB_POOL_MAX=2`: webhooks | 65 accepted/s, all 202, p99 1,583 ms; total stored 7,000 |
| `DB_POOL_MAX=2`: RSS (512 MB old space) | 287 to 446 MB, levelled off at about 440 MB; `/health` max 93 ms |
| Graceful SIGTERM under load | exit 0 both times (194 ms, 2,369 ms) |
| **Integrity** (idle DB, whole run) | 74,548 check results == 74,548 target requests; 0 duplicate run generations; results == observations == rollup totals for all 4,000 monitors; no watchdog exit, no scheduler or batch failures |

No response in any phase was a 5xx, and no request hit the 30 s client timeout.

## Pass/fail thresholds
The script fails if any of these does not hold. They are correctness
invariants or limits derived from design constants, not tuned timings.

- **Throughput:** each monitor has 4 to 6 results per 300 s window (none lost,
  none duplicated). No releases at nominal load. Lag p95 is at most 90 s (30 s
  tick + 40 s slot delay + 20 s margin).
- **Backpressure:** the queue must actually fill up (claims released).
  - Claimed but unstarted runs stay at or below 13,800.
  - At most 80 checks run at once.
  - RSS grows by at most 256 MB over the throughput phase.
  - `/health` answers every probe within 5 s.
  - No watchdog exit.
  - Recovery within 600 s, then every monitor is checked and lag p95 is at
    most 90 s.
- **Webhooks:** all fan-out POSTs return 202, and stored == accepted (by
  distinct request id). Each hot burst accepts exactly 120 and rejects 80 with
  429. Hot inbox stored == min(accepted, 250).
- **Reads:** every request returns 200 within 30 s.
- **`DB_POOL_MAX=2`:**
  - At most 2 server connections.
  - Reads and webhooks complete without errors or timeouts.
  - Stored == accepted, and every monitor is still checked.
  - `/health` answers within 5 s, and the process does not die (including from
    a heap OOM under the 512 MB cap).
- **All phases:** server connections stay at or below the pool size, and RSS
  stays at or below 1,024 MB.
- **Shutdown:** graceful SIGTERM exits with code 0.
- **Integrity:** no duplicate generations. Results == observations == rollup
  totals == target requests for every monitor. Generations stay in order.

## Findings
- **No application defect was found.** There were no crashes, lost or
  duplicated checks, 5xx responses or watchdog restarts, and no evidence of
  unbounded memory. No application code changed.
- **The first run (commit be2a8da, run 42575078934) failed one threshold.**
  The `DB_POOL_MAX=2` server reached 1,150.8 MB RSS, above the 1,024 MB bound.
  Every other invariant passed, including exact integrity. That server ran
  without a heap cap, and V8 sizes its old space from the 16 GB of host RAM and
  collects lazily. The heavy `/api/monitors` reads (5.3 MB responses built from
  about 120,000 sparkline rows) produce a lot of short-lived garbage. To tell
  garbage from retained memory, the rerun caps the old space at 512 MB: real
  retention would have ended the process with a heap OOM. The process stayed up
  and RSS levelled off at about 440 MB under the same load. The 1,024 MB bound
  was not loosened. Operators running very large projects with small containers
  should set `--max-old-space-size` to fit their memory limit.
- **Staleness under slow targets.** While every target is slow, the queue keeps
  accepted work (bounded by the 512 messages), so the checks that do run are
  minutes old: lag p95 was 273 s after about 4 minutes. With the target slow
  for longer, staleness grows toward queue depth / drain rate. Memory and
  in-flight work stay bounded.
- **Catch-up after recovery.** Runs queued while the target was slow still
  execute once it recovers. That gave up to 5 checks of one monitor within
  120 s: each is a distinct claimed run generation, not a duplicate of one run,
  and stale runs never overwrite newer state. Merging stale runs before they
  execute would reduce both effects; it is not implemented here.
- **A pool of 2 is under-provisioned for 4,000 monitors at 60 s.** Such a
  server reaches about 2,700 checks/min with growing lag. It degrades without
  errors or connection overrun.

## Limits
- This covers a single Node process and a single-host PostgreSQL on a 4 vCPU /
  16 GB GitHub-hosted runner. Both run on one machine, alongside the load
  generator and the synthetic target. It is **not** a multi-region,
  multi-replica or production-capacity claim. Numbers on other hardware,
  networks or databases will differ.
- Targets are local, so network latency to real endpoints, DNS and TLS
  handshakes are not part of check cost. Phase 2 models slowness with a fixed
  10 s delay.
- The database starts empty. Large tables (months of `check_result`, many
  tenants) and the hourly purge or maintenance windows are not loaded.
- Latency and throughput figures are measurements from one run, not
  guarantees. Only the invariants above are asserted.
- Alert delivery, external probes, SMTP and browser traffic are not part of
  this load test.
