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
`montral_test_load_ci` database. It refuses any database that is not on
127.0.0.1/localhost, any name not matching `montral_test_*`, and any URL with
query parameters (for example `?host=`). Everything is synthetic and local:
monitors target an HTTP server inside the script, and the webhooks come from
the script. The JSON summary is uploaded as the `montral-load-summary` artifact.

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

## Results
**Cited run:** [42589028478](https://github.com/TheHalfMoon/Montral/actions/runs/42589028478)
on commit `dc18b19`. This is the last commit that changed the script; later
commits on this branch change only this document. The run includes the
512 MB phase-5 heap cap and the non-empty-sample checks, and logged no
sampler errors.

**Ranges** are min-max over the three green runs of the current thresholds:
42577788904 (`979a583`), 42584647233 (`1c90d37`) and 42589028478 (`dc18b19`).
Correctness results were identical in all three. Speed and latency vary
between runs on shared hosted runners, by up to about 1.5x for HTTP latency.

Runner: GitHub-hosted `ubuntu-latest`, 4 vCPU and 16 GB RAM (`nproc` 4,
15,983 MB total memory). Node 24.22.1. PostgreSQL 18.6 (Alpine) service
container on the same host.

| Measurement | Cited run | Range (3 green runs) |
|---|---|---|
| Checks completed (300 s window, 4,000 monitors at 60 s) | **4,016/min** (20,081 results) | 4,008-4,016/min |
| Completion lag p50 / p95 / p99 / max | 35.2 / 61.3 / 68.3 / 70.3 s | p95 61.3-61.8 s |
| Results per monitor in the window (expected 5) | 5: 3,966, 6: 34 | min 4-5, max 6 |
| Server DB connections (pool 10) | max 10, no lock waits | max 10 |
| RSS during throughput | 111 to 350 MB, levelling off at 350 MB | max 349-352 MB |
| Backpressure: queue full after | 170 s; 3,972 claims released, 4 refusal log lines | 170 s; 3,968-3,995 |
| Checks in flight at the slow target | max 80 (4 messages x 20) | 80 |
| Checks/min and lag while slow | 289/min; lag p95 276 s | 289/min; p95 273-276 s |
| Claimed but unstarted runs | max 11,469 (bound 13,800 = 512 x 25 + one 1,000-claim round) | 11,427-11,491 |
| RSS while slow | max 390 MB (+40 MB) | 378-390 MB |
| `/health` while slow (1 probe/s) | p99 8.1 ms, max 10.4 ms, 0 failures | max 5.6-10.4 ms |
| **Recovery** (backlog drained, last-60 s lag p95 back under 90 s) | **131 s** | 131-141 s (141 s on the merged head, run 42593740378) |
| After recovery (120 s window) | 3,658 checks/min, lag p95 62.2 s, every monitor checked | p95 62.2-70.7 s |
| Catch-up after recovery | up to 6 results for one monitor in the first 120 s | 5-6 (with run coalescing, run 42767860622: max 3 in 120 s, max 2 in any 60 s; see below) |
| Webhook fan-out (5,000 at concurrency 50) | **336 accepted/s**, all 202; p50 / p95 / p99 140 / 216 / 262 ms; stored 5,000 (5,000 distinct ids) | 259-338/s; p99 246-471 ms |
| Hot inbox (3 x 200) | exactly 120 x 202 + 80 x 429 per burst; 360 accepted; **stored 250** (retention cap) | identical |
| `/api/monitors`, 4,000 monitors, 5.3 MB response | 8.5 req/s; p50 / p95 / p99 1,135 / 1,429 / 1,558 ms; 0 errors | p95 1,424-1,936 ms |
| Status summary (concurrency 50) | 170 req/s; p50 / p95 / p99 284 / 362 / 473 ms; 0 errors | p95 337-427 ms |
| Full status board (concurrency 20) | 233 req/s; p50 / p95 / p99 74 / 143 / 193 ms; 0 errors | p95 140-155 ms |
| RSS during reads and webhooks (pool 10) | max 733 MB | 689-733 MB |
| `DB_POOL_MAX=2`: server connections | max 2 | 2 |
| `DB_POOL_MAX=2`: monitoring | 3,322 checks/min (cannot keep up with 4,000/min); lag p95 132 s; no monitor starved (see thresholds) | 2,694-3,322/min; p95 111-168 s |
| `DB_POOL_MAX=2`: reads | summary p95 514 ms (13,185 requests); `/api/monitors` p95 1,190 ms (619 requests); 0 errors | summary p95 514-685 ms |
| `DB_POOL_MAX=2`: webhooks | 92 accepted/s, all 202, p99 861 ms; total stored 7,000 | 65-101/s |
| `DB_POOL_MAX=2`: RSS (512 MB old space) | 283 to 452 MB, levelling off around 445 MB; `/health` max 86 ms | max 446-469 MB |
| Graceful SIGTERM under load | exit 0 both times (229 ms, 1,349 ms) | exit 0 every time |
| **Integrity** (idle DB, whole run) | 77,098 check results == 77,098 target requests; 0 duplicate run generations; results == observations == rollup totals for all 4,000 monitors; no watchdog exit, no scheduler or batch failures, no sampler errors | identical (74,548-77,098 results) |

No response in any phase was a 5xx, and no request hit the 30 s client timeout.

## Pass/fail thresholds
The script fails if any of these does not hold. They are correctness
invariants or limits derived from design constants, not tuned timings.

A bound passes only for a real, finite measurement. An empty sample set (no
RSS, health or DB samples, no outstanding-run samples, a missing lag p95, or an
empty monitor list) fails the qualification. Any DB sampler error is also
recorded as a failure.

- **Throughput:** each monitor has 4 to 6 results per 300 s window (none lost,
  none duplicated). No releases at nominal load. Lag p95 is at most 90 s (30 s
  tick + 40 s slot delay + 20 s margin).
- **Backpressure:** the queue must actually fill up (claims released).
  - Claimed but unstarted runs stay at or below 13,800.
  - At most 80 checks run at once.
  - RSS grows by at most 256 MB over the throughput phase.
  - `/health` answers every probe within 5 s.
  - No watchdog exit.
  - Recovery within 600 s, then every one of the 4,000 monitors is checked and
    lag p95 is at most 90 s.
- **Webhooks:** all fan-out POSTs return 202, and stored == accepted (by
  distinct request id). Each hot burst accepts exactly 120 and rejects 80 with
  429. Hot inbox stored == min(accepted, 250).
- **Reads:** every request returns 200 within 30 s.
- **`DB_POOL_MAX=2`:**
  - At most 2 server connections.
  - Reads and webhooks complete without errors or timeouts.
  - Stored == accepted.
  - No starvation: every one of the 4,000 monitors gets a check from the
    phase-5 server within 360 s of its start (its 60 s interval plus the 300 s
    lag bound; only phase-5 observations count, and the script waits for
    stragglers up to that deadline), and the worst steady-state completion lag
    is at most 300 s. An earlier rule ("checked within the 180 s window") was
    wrong for an under-provisioned pool: run 42609831385 saw lag up to 216 s
    (within bounds) against a 181 s window, so 50 monitors were checked just
    outside it. That run does not prove or disprove starvation; the new rule does.
  - Lag p95 is at most 300 s. This is a deliberately generous "bounded, not
    fast" floor: it is the watchdog's 5-minute stall horizon.
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
- **The first run failed one threshold.** That run was
  [42575078934](https://github.com/TheHalfMoon/Montral/actions/runs/42575078934)
  on commit `be2a8da`. The `DB_POOL_MAX=2` server, running without a heap cap,
  reached 1,150.8 MB RSS, above the 1,024 MB bound. Every other invariant
  passed, including exact integrity. On this 16 GB runner, V8's default old
  space is large and it collects lazily. The heavy `/api/monitors` reads
  (5.3 MB responses built from about 120,000 sparkline rows) produce a lot of
  short-lived garbage. To tell garbage from retained memory, phase 5 now caps
  the old space at 512 MB: real retention would end the process with a heap
  OOM, which fails the run. In all three later runs the process stayed up and
  RSS levelled off at 446-469 MB under the same load. The 1,024 MB bound was
  not loosened.
- **What the phase-5 RSS bound does and does not prove.** With the heap capped
  at 512 MB, the 1,024 MB RSS bound is close to meaningless as a memory test:
  the cap keeps the heap far below it. The real phase-5 evidence is that the
  process did not die (no heap OOM, so no unbounded retention), together with
  the correctness floor above (connections at most 2, no errors, every monitor
  checked, lag p95 bounded). Phases 1-4 run uncapped, so their RSS figures are
  real.
- **Advice for self-hosters.** Under sustained load, Node may hold over 1 GB of
  RSS that is collectable garbage unless the heap is bounded. Node takes the
  host's memory, and in containers usually the cgroup memory limit, into
  account when it picks a default heap size. The exact behaviour depends on the
  Node/V8 version and cgroup setup, so check
  `v8.getHeapStatistics().heap_size_limit` in your image. If needed, set
  `NODE_OPTIONS=--max-old-space-size=<MB>` to roughly 75% of the container's
  memory limit, leaving room for buffers and native memory.
- **Staleness under slow targets.** While every target is slow, the queue keeps
  accepted work (bounded by the 512 messages), so the checks that do run are
  minutes old: lag p95 was 273-276 s after about 4 minutes. With the target
  slow for longer, staleness grows toward queue depth / drain rate. Memory and
  in-flight work stay bounded.
- **Catch-up after recovery.** Runs queued while the target was slow still
  execute once it recovers. That gave up to 5-6 checks of one monitor within
  120 s: each is a distinct claimed run generation, not a duplicate of one run,
  and stale runs never overwrite newer state. Merging stale runs before they
  execute would reduce both effects. (Implemented on 2026-11-10: see "Run
  coalescing" below.)
- **A pool of 2 is under-provisioned for 4,000 monitors at 60 s.** Such a
  server reaches about 2,700-3,300 checks/min with lag p95 of 111-168 s. It
  degrades without errors or connection overrun.

## Run coalescing (2026-11-10, #54)
`beginRuns` now skips a queued run as superseded: it is never checked or
billed. Two conditions trigger this:
- **Covered.** A check of the same monitor **started** after the run was
  claimed (stamped under the row lock that `claimDue` also takes), and either
  that check is less than half an interval old or the run is stale. A run is
  stale when its lease deadline, the next run's due time, passed more than
  70 s ago (one tick plus the slot delay). A manual check's start is stamped
  with the database clock.
- **In flight.** An earlier run that started **after this run was claimed** is
  less than its timeout + 15 s old and has not recorded yet. A run that started
  before the claim never holds it back.

A run claimed after the latest check started always starts.

### Variants measured before the final rule

| Rule | Run | Phase 1 results / 300 s | Post-recovery max in 60 s |
|---|---|---|---|
| none (before) | 42589028478 | 5-6 (min 4-5 over three runs) | up to 6 in 120 s |
| a result *recorded* after the claim | 42724447908 | **min 3** (a slow previous run swallowed the next interval) | - |
| a check *started* after the claim | 42736427688 | **min 3** (queue wait pushed starts past the next claim, so the schedule was thinned) | - |
| + half-interval window only | 42743694020 | 5-6 | **4** (queued runs of one monitor drain about 30 s apart) |
| + stale-run rule | 42751836174 | 4-6 | 2 |
| + review fixes (lease fence, DB clock) | 42763407865 | 4-6 | 3 (failed only the uncapped-heap RSS bound; see below) |

### Final run
[42767860622](https://github.com/TheHalfMoon/Montral/actions/runs/42767860622)
on `be8a63c`, the exact head of #54. Every threshold passed.

| Measurement | Result |
|---|---|
| Phase 1 throughput | 4,009 checks/min, lag p95 61.5 s, max 70.4 s |
| Phase 1 results per monitor per 300 s | 4-6 (20 at 4, 3,954 at 5, 26 at 6) |
| **No starvation, normal load** (new bound: at most 2 intervals + 1 tick = 150 s between results per monitor) | longest gap 89.5 s, over all 4,000 monitors |
| Recovery | 131 s |
| **No starvation, after recovery** (same 150 s bound) | longest gap 60.5 s |
| Catch-up after recovery | at most 2 results per monitor in any 60 s (3,857 at 2, 143 at 1); at most 1 in any 10 s; at most 3 in the first 120 s (before: up to 6) |
| Integrity | 68,326 results == 68,326 target requests; 0 duplicate generations |
| Claims accounted for | 86,888 claims = 68,326 results + 8,607 releases + 9,955 skipped before start (coalesced, never began) + 0 started without a result |
| Started runs without a result outside the two graceful stops | **0**, asserted |
| `/api/monitors` response (4,000 monitors) | 5.43 MB; the four scheduler columns are kept out of the API |
| RSS, reads and webhooks (uncapped heap) | max 790 MB and 676 MB (bound 1,024 MB) |
| DB_POOL_MAX=2 (overload) | 2,697 checks/min, lag p95 119.6 s; no starvation under the looser overload bound (interval + 300 s), which applies to this phase only |

Run classification comes from a test-only trigger, which logs every run start
next to claims and releases. A claimed run that never recorded is then either
**skipped before start** (coalesced: never checked, never billed) or **started
without a result** (lost: crash, inconclusive probe, rejected write). The
second kind must be zero outside the 30 s around each graceful stop.
`qualify-crash-recovery.mjs` logs starts the same way and still fails on a
lost non-latest run.

**RSS finding during review.** Run 42763407865 failed only the uncapped-heap
RSS bound in the read phases, at 1,244 and 1,396 MB (main at the time: 694 and
828 MB). The four new scheduler columns had grown the 4,000-monitor
`/api/monitors` response by 11 %, from 5.44 to 6.03 MB, and the read phase
builds ten of these at once. They are scheduler-only state and are no longer
returned. In the final run the response is 5.43 MB and RSS is back within the
range of main.

### Follow-up (2026-11-11): intermittent failures on main
- **`p4_reads` RSS above 1,024 MB** (1,027.7 / 1,038.5 / 1,077.9 MB in runs
  42879433274, 42921654043, 42776206602; passing runs 780-936 MB on the same
  workload). The peaks fell back within seconds (1,078 to 944 MB) and the
  heap-capped phase-5 server, which serves the same list continuously, stayed
  at 466-488 MB: garbage that the uncapped heap (4 GB on the 16 GB runner)
  had not collected, not retention. Both servers of the qualification now run
  with the same 512 MB old-space cap; a retention would end in a heap OOM and
  fail the run. `GET /api/monitors` also allocates less per request: the
  sparkline samples are aggregated in PostgreSQL (one row per monitor instead
  of up to 30) and the list is copied once instead of two to three times (in a
  local simulation, about 40 % less allocated per 4,000-monitor list).
- **3 results for one monitor within 10 s after recovery** (run 42921692743,
  1 of 4,000 monitors). Three runs that start after recovery cannot do this
  (their starts are more than 30 s apart under the rules above), so one was a
  check already in flight when the target recovered: a queued run claimed
  after it started is not covered by it ("a run that started before the claim
  never holds it back"), and the run claimed after that one started always
  starts. The per-10 s bound of 2 is now asserted on runs that start after
  recovery; results of runs in flight at recovery are counted apart (at most
  4 messages x 25 runs) and the timelines of monitors they push to 3 are kept
  in the summary. `run-coalescing.e2e.test.ts` reproduces the interleaving.
  The "at most 2 results per minute" in the final report is a measurement of
  one run: the asserted bound is 3 per interval (runs 42921654043 and
  42921692743 reached 3).

### Rejected alternative (#51)
Starting only the newest claimed generation. When a run starts after the next
claim, every run is superseded before it starts, and the monitor is never
checked. A run starts after the next claim whenever the tick (up to 30 s), the
slot delay (up to 40 s) and the queue wait add up to more than the 60 s
interval, as in the slow and pool-2 phases here. It also drops an
already-queued run when the queue refuses a newer claim.

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
- Latency and throughput figures are measurements from a few runs on shared
  runners, not guarantees. Only the invariants above are asserted.
- Alert delivery, external probes, SMTP and browser traffic are not part of
  this load test.
