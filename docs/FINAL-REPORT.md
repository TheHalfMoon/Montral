# Montral release-readiness report

**Status: SELF-HOSTED RELEASE CANDIDATE TECHNICALLY READY — PUBLICATION HOLD.**
Nothing is released, deployed, packaged, published or tagged. That requires the owner's explicit authorization
(`GREEN LIGHT MONTRAL`). A public repository is not release authorization. No paid service was enabled and no cost
was incurred. Billing stays disabled by default and test-mode only.

**Candidate revision:** `main` at `c58c24a` (2026-11-09). Every claim below points to a merged pull request, a CI run
on its exact head, or an evidence file in `docs/evidence/`. Anything not demonstrated is listed as open. The
prioritised task list is [TASK-LEDGER.md](TASK-LEDGER.md); the competitor comparison is [GAP-MATRIX.md](GAP-MATRIX.md).

## 1. Decision

| Target | Decision | Why |
|---|---|---|
| **Self-hosted Docker release candidate** | **GO, once `GREEN LIGHT MONTRAL` is given** | Every release blocker in the ledger is closed with evidence. All seven CI workflows pass at the candidate revision on Linux (PostgreSQL 17 and the exact shipped 18.6 image) and macOS ARM64. The Docker image and compose stack are qualified as shipped. No critical or high security finding is open. |
| **Public hosted service (SaaS)** | **NO-GO** | No production host or deployment authorization. No external SMTP, APNs or payment provider qualification. No multi-node or multi-region capacity qualification, no managed backup/PITR, no third-party penetration test. |

Known limitations a self-hoster should accept are in section 8.

## 2. Work merged since the previous assessment (`12e9473`)

Each pull request passed an independent review (findings fixed) and every CI check on its exact head before merging.

| PR | Commit | Change |
|---|---|---|
| #31 | `80c84c4` | CI matrix: PostgreSQL 17 and the exact `postgres:18.6-alpine` compose image; failover on both; drift guard |
| #32 | `788f35f` | macOS 15 ARM64 qualification on PostgreSQL 18: full suite, browser, restore, crash recovery, SMTP |
| #35 | `95238e8` | Root cause of the billing checkout flake: no-op migration DDL deadlocking checkout (40P01); RED reproduced on unfixed main in #34 (closed unmerged) |
| #33 | `d384a45` | Periodic re-verification of custom domains; race-safe withdrawal with grace periods |
| #38 | `3367f75` | ICMP ping monitor (Node), SSRF-pinned, no secrets passed to the child process |
| #37 | `311da0a` | Docker image and compose qualification; PostgreSQL major-downgrade refusal |
| #41 | `fc5ee62` | Bounded manual "check now" per workspace and per process |
| #39 | `7535614` | Workspace audit log: append-only, API, CSV/JSONL export, MCP, UI, retention |
| #40 | `8fedf26` | Load, queue backpressure, webhook ingestion and DB pool exhaustion qualification |
| #36 | `c58c24a` | Cross-browser (Chromium, Firefox, WebKit, mobile) and WCAG 2.1 AA gate, plus the app bugs it found |

Earlier work (#12–#30) is listed in the git history and the previous version of this report.

## 3. Defects found and closed

| Defect | Severity | How it was proven | Fix |
|---|---|---|---|
| Billing concurrency test got an unexplained 500 | P0 | CI log of run 42445399140: one unhandled error during concurrent checkouts. Deterministic two-connection test on unfixed main: PostgreSQL logged `deadlock detected`; a no-op re-migration held 5 blocking table locks | Migrations check the catalog first, so a current schema takes no table locks; genuine upgrades lock in checkout order and retry 40P01; 40P01/40001 answer 503 + Retry-After (#35) |
| Custom domain stayed verified after its TXT proof disappeared | P1 | Code review | Scheduled re-checks; withdrawal after 24 h missing (3+ checks) or 7 d unreachable DNS; writes bound to page, domain and token (#33) |
| Shipped PostgreSQL 18 image never tested | P0 | CI ran 17 only | Matrix with the exact compose image, guard against drift (#31) |
| Changing the PostgreSQL tag to another major would silently start an empty cluster | P1 | Reasoned from the images' data paths | `PGDATA` pinned; PostgreSQL 17 proven to refuse the 18 volume without touching it (#37) |
| Status page editor crashed for every page (React hook order) | P1 | Found by the cross-browser journey | Fixed (#36) |
| Unhandled fetch rejections when leaving a loading page | P2 | Mobile WebKit journey | Results tied to the mounted screen; load errors shown (#36) |
| Slug / ntfy-topic validation silently skipped (`pattern` invalid under the `v` flag) | P2 | Journey | Escaped (#36) |
| Dashboard skip link did nothing; text contrast 2.85–3.5:1 | P2 | axe, journey | Router leaves fragment links to the browser; colour tokens meet 4.5:1 (#36) |
| Manual checks unbounded | P2 | Ping review | 60 per workspace per 10 min, 32 in flight per process (#41) |

## 4. Test results at the candidate revision

GitHub Actions on `c58c24a` (Linux runners: `ubuntu-latest`, which was the ubuntu-26.04 image in these runs, 4 vCPU / 16 GB):

| Workflow | Result |
|---|---|
| App CI, PostgreSQL 17 and PostgreSQL 18.6-alpine: typecheck, API + real PostgreSQL E2E, probe, web, builds, CSP, smoke, backup/restore + negative control, Chromium journey, crash recovery, SMTP, branding | **Pass on both** ([run 42605420023](https://github.com/TheHalfMoon/Montral/actions/runs/42605420023)): API + E2E 1,128/1,128, probe 22/22, web 129/129 per leg; 75 inline scripts on 35 pages hashed; restore drill 48 tables with version-matched pg_dump 17.11 / 18.6; all markers (BROWSER_E2E, CRASH_RECOVERY, NODE_SIGTERM, SMTP_LOOPBACK, STATUS_PASSWORD, CUSTOM_DOMAIN_SMOKE, RESTORE_CATALOG_NEGATIVE, ACTIVE_BRAND_SCAN) |
| macOS 15 ARM64, PostgreSQL 18 (Homebrew): the same qualifications | **Pass** ([run 42605419981](https://github.com/TheHalfMoon/Montral/actions/runs/42605419981)): 1,128 / 22 / 129, same markers, pg_dump 18.6 |
| Failover: network partition and primary promotion on `postgres:17` and `postgres:18.6-alpine` | **Pass on both** ([run 42605419809](https://github.com/TheHalfMoon/Montral/actions/runs/42605419809)) |
| Docker Compose: image build, health, HTTP sign-up and writes, ping monitor up inside the image as `node`, persistence across stop/start and container recreation, PostgreSQL 17 refuses the 18 volume | **Pass** ([run 42605419880](https://github.com/TheHalfMoon/Montral/actions/runs/42605419880)) |
| Cross-browser: Chromium, Firefox, WebKit, Pixel 7, iPhone 14 × 5 tests; 45 axe WCAG 2.1 AA scans, 0 violations of any impact | **Pass**: 25/25 ([run 42605420371](https://github.com/TheHalfMoon/Montral/actions/runs/42605420371)) |
| Load: 4,000 monitors, backpressure, webhook ingestion, pool exhaustion | **Pass** ([run 42605420067](https://github.com/TheHalfMoon/Montral/actions/runs/42605420067)): 4,001 checks/min, lag p95 61.9 s, 77,712 results == target requests, backlog drained in 131 s, 338 webhooks/s, no 5xx |
| Source integrity (vendored snapshots) | **Pass** ([run 42605419908](https://github.com/TheHalfMoon/Montral/actions/runs/42605419908)) |

## 5. Reliability and recovery

Demonstrated on real processes and real PostgreSQL, not mocks:

| Scenario | Evidence | Measured |
|---|---|---|
| Graceful SIGTERM | NODE_SIGTERM_PASS | Queue drained, clean exit |
| SIGKILL mid-retry, DB outage, two workers | CRASH_RECOVERY_PASS (#16) | No duplicate incident or alert; recovery after outage |
| Network partition (45 s black-hole) | FAILOVER_PASS (#23, #31) | No writes or DB-backed answers during it; service resumes |
| Primary killed, synchronous replica promoted | FAILOVER_PASS on PostgreSQL 17 and 18 | No committed row lost |
| Migration interruption / concurrent migrators | Advisory lock + transactional migrations; four-replica drill (2026-10-30); deadlock retry (#35) | Interrupted migration rolls back |
| Backup and restore | RESTORE_DRILL_PASS + catalog negative control, Linux and macOS | 48 tables, row counts and SHA-256 content match |
| PostgreSQL major mismatch | DOCKER_COMPOSE_PASS (#37) | 17 refuses 18 data; data intact |
| Sustained load (#40) | LOAD_QUALIFICATION_PASS | 4,001 checks/min for 4,000 monitors at the candidate (4,001–4,016 across runs), lag p95 61.9 s; 0 lost or duplicated checks (results == target requests exactly) |
| Backpressure: slow target (10 s) | #40 | Queue bounded (≤ 80 in flight, ≤ 13,800 unstarted claims), RSS +45 MB, `/health` ≤ 17 ms (candidate run; 10–17 ms across runs), no false watchdog restart; backlog drained in 131 s (131–141 s across runs) |
| Duplicate / delayed events | #40, #17 | Webhook store == accepted (cap 250 per inbox); 429 beyond the rate limit; replay never mutates the stored event |
| Connection pool exhaustion (`DB_POOL_MAX=2`) | #40 | Never above 2 connections, 0 errors, every monitor still checked (lag p95 ~110–170 s) |

**Not demonstrated:** several app nodes behind a load balancer under real traffic; hosted or cross-region failover;
managed PITR; capacity beyond one 4-vCPU node; real network/DNS/TLS latency in the load test.

## 6. Security assessment

Each control has a regression test that runs in CI.

| Area | Control | Evidence |
|---|---|---|
| SSRF, DNS rebinding, redirects | netguard: every resolved address checked, connections pinned to the checked address, redirects re-validated; ping receives only the checked IP literal | `netguard.test.ts`, `ping-resolve.test.ts` |
| CSRF | Cookie-authenticated writes need a same-origin Origin | #14 |
| XSS / CSP | Hash-based script CSP on every page incl. landing; React rendering | #19, #22, CSP_PASS, 0 violations in 3 engines |
| Clickjacking, sniffing | Frame, nosniff, referrer headers | #15 |
| Status page access | PBKDF2 status-page passwords (account passwords via Better Auth), HMAC access cookies (≤ 12 h, versioned), hashed revocable share links, atomic unlock rate limits | #21 |
| Tenant isolation | Org/project scoping on every route; audit log isolation incl. forged cursors | e2e suites, #39 |
| Authorization | Owner/admin checks re-read membership from the database | #39 review |
| Secrets in logs and storage | Fixed log categories; audit log stores field names only for secret-bearing fields; ping child gets no server secrets | #20, #38, #39 |
| Append-only audit trail | Trigger refuses UPDATE/DELETE/TRUNCATE; prune only past a 30-day floor; `search_path` pinned against temp-table shadowing | #39 |
| Domain takeover | TXT proof per token; DNS owner takes over; withdrawal when proof disappears; unknown hosts 404 | #29, #33 |
| Rate limiting / abuse | Auth, unlock, webhook, manual checks | #21, #41 |
| SQL injection | Parameterised queries; LIKE escaping in audit filters | #39 review |
| Webhook replay | SSRF-guarded, private targets need an explicit opt-in | #17 |
| Supply chain | Vendored sources hash-verified; exact devDependency pins with lockfile integrity; actions pinned by tag | source-integrity workflow |
| Docker | Runs as `node`; PostgreSQL major pinned; synthetic-secret qualification | #37 |

**Open (none critical or high):** no third-party penetration test; GitHub Actions pinned by tag rather than commit
SHA; reverse-proxy access logs must redact bearer tokens in URLs (operator responsibility, documented); an owner who
deletes a workspace also deletes its audit trail (by design, documented).

## 7. Platform coverage

| Platform | Status |
|---|---|
| Linux x86-64 | Qualified on every PR: PostgreSQL 17 and 18.6 (Alpine, as shipped) |
| macOS 15 ARM64 | Qualified on every PR at the candidate revision (PostgreSQL 18.6, Homebrew) |
| Docker / Docker Compose | Qualified on every PR with the shipped Dockerfile and compose file |
| Windows | **Not supported as a server platform.** During this programme, development tooling ran there (unit tests, typecheck); the database suites and Docker were not runnable on that machine. On Windows, Docker Desktop (WSL 2) runs the same Linux image; that path is expected to work but was not tested |
| Browsers | Chromium, Firefox, WebKit (Playwright's Linux build), Pixel 7 and iPhone 14 emulation. Real Safari on macOS/iOS hardware is not covered |

## 8. Known limitations for a self-hosted release candidate

1. TLS certificate monitors, ping monitors and custom domains need the Node/Docker server; the Cloudflare Workers
   build refuses them with 400. Members-only status pages are not served on custom domains (sign-in lives on the
   main address), and share links point at the main address.
2. Not yet implemented: on-call schedules, SSO (OIDC/SAML), Terraform provider, browser checks, custom webhook
   responses, SMS/voice (paid provider). Ranked in the ledger.
3. External email deliverability, live APNs push and live payments are not qualified; billing is off.
4. Under a slow-target backlog a monitor can get several catch-up checks right after recovery (measured, harmless,
   tracked in the ledger).
5. Dark-mode contrast, screen readers and real Apple hardware are not tested.

## 9. Install and operations documentation

- Install, environment, reverse proxy and TLS, custom domains (incl. re-verification), ping in Docker, PostgreSQL
  version policy, APNs, GitHub sign-in, upgrades: `/docs/self-host` (served by every instance, en + zh).
- Backup and restore: `/docs/backup`. REST API incl. audit log and limits: `/docs/api`. MCP tools: `/docs/mcp`.
- Environment reference: `.env.docker.example`, `docker-compose.yml`.
- The Docker qualification script (`scripts/qualify-docker.sh`) reproduces a clean install, restart, upgrade-style
  container recreation and the downgrade refusal on any Docker host.
- Per-change evidence: `docs/evidence/`.

## 10. External approvals needed for a public launch

1. `GREEN LIGHT MONTRAL` from the owner, before any tag, image, package or deployment.
2. A hosting account, domain and TLS for a hosted service (paid infrastructure needs approval).
3. Email provider (SMTP/Resend), APNs credentials, and a live payment provider account, if those features are to be
   offered.
4. Commercial terms, privacy policy and legal review of the bundled `/terms` and `/privacy` text.
5. Optional: a third-party penetration test.
