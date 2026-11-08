# Montral release-candidate assessment

**Status: ENGINEERING COMPLETE FOR THIS PHASE — PUBLICATION HOLD.**
Nothing is released, deployed, packaged or launched. That requires the owner's explicit
authorization (`GREEN LIGHT MONTRAL`). A public repository is not release authorization.
No paid service was enabled and no cost was incurred.

Assessed revision: `main` at `9db0d3d` (PR #29 merged, 2026-11-08). Every claim below
points to a merged pull request, a CI run on that pull request's exact head, or an
evidence file in `docs/evidence/`. Anything not tested is listed as open.

## 1. Recommendation

| Target | Decision | Reason |
|---|---|---|
| Public hosted service (SaaS) | **NO-GO** | No production host, no external SMTP/APNs deliverability, no load or multi-region qualification, no managed backup/PITR, billing is test-mode only. |
| Self-hosted Docker release candidate (`v0.x-rc`) | **GO, once authorized** | Feature set and qualification are complete for a self-hosted RC, subject to the known limitations in section 7. Cutting the tag still needs `GREEN LIGHT MONTRAL`. |

Before tagging, two items should be closed (section 7, items 1 and 2): qualify the
shipped PostgreSQL 18 image, and run the suite once on macOS at the RC revision.

## 2. Work merged in this programme

All 18 pull requests passed exact-head CI (app CI, source integrity and, from #23, the
failover workflow) and an independent review before merging.

| PR | Commit | Change |
|---|---|---|
| #12 | `cc00d3b` | Incident status draft survives delayed detail reloads |
| #13 | `4e675f7` | Paging, filtering and search across all retained webhook events |
| #14 | `8f87431` | Cross-origin writes authenticated by the session cookie are refused |
| #15 | `952a17d` | Framing, CSP baseline and nosniff headers on self-hosted pages |
| #16 | `89917f1` | SIGKILL, database outage and two-worker recovery on real Node |
| #17 | `5a2c888` | Delete single webhook events; SSRF-guarded replay to dev endpoints |
| #18 | `6c3d52c` | Members-only status pages |
| #19 | `629887e` | Hash-based script CSP on every web page |
| #20 | `d9773dd` | Safe error class logged for unhandled API errors |
| #21 | `5741558` | Password-protected status pages and revocable, expiring share links |
| #22 | `940fd22` | Strict script CSP for the landing pages |
| #23 | `b7b483d` | Network partition and primary promotion on real PostgreSQL containers |
| #24 | `00582ce` | CI runs branch builds once and cancels superseded runs |
| #25 | `2738144` | Feature and competitor gap matrix |
| #26 | `f6b997e` | TLS certificate expiry and validity monitor |
| #27 | `79ccc1f` | JSON response-body assertions for HTTP monitors |
| #28 | `6b4ff75` | Google Chat, Mattermost, Gotify and Pushover alert channels |
| #29 | `9db0d3d` | Verified custom domains for status pages (self-hosted Node) |

## 3. Features: implemented and remaining

The full comparison with Uptime Kuma, Better Stack, OpenStatus, UptimeRobot, Gatus and
webhook.site, with sources, is in [GAP-MATRIX.md](GAP-MATRIX.md).

**Implemented:** HTTP(S) with keyword and JSON assertions; TCP; DNS; TLS certificate
(Node); domain expiry; heartbeat/cron; WebSocket; PostgreSQL/MySQL/Redis checks;
multi-region edge probes; 14 alert channels; manual and automatic incidents with
timeline, acknowledgement, reminders/escalation and postmortems; public, members-only
and password status pages; expiring share links; custom domains (Node); email
subscribers; recurring maintenance; badges, RSS, ICS and llms.txt feeds; webhook
inboxes with search, paging, delete and replay; REST API; OAuth MCP server; 2FA;
GitHub sign-in; owner/admin/member roles; Docker self-hosting.

**Remaining** (ranked in the gap matrix): ping/ICMP, periodic custom-domain
re-verification, Terraform/config-as-code, on-call schedules, SSO (OIDC/SAML) and
audit log, SMS/voice (paid provider, needs approval), browser/multi-step checks,
custom webhook responses.

**Platform limits by design:** TLS certificate monitors and custom domains need the
Node/Docker server; the Cloudflare Workers build refuses them with a 400.

## 4. Test results

Exact head of PR #29, `289b311`, on GitHub Actions `ubuntu-24.04`, Node 24.22.1,
PostgreSQL 17 service:
[app CI 42519866193](https://github.com/TheHalfMoon/Montral/actions/runs/42519866193),
[source integrity 42519866033](https://github.com/TheHalfMoon/Montral/actions/runs/42519866033),
[failover 42519866143](https://github.com/TheHalfMoon/Montral/actions/runs/42519866143).

| Suite | Result |
|---|---|
| API unit + real PostgreSQL E2E | 1,017 / 1,017 passed (118 files) |
| Probe | 22 / 22 passed |
| Web, against built production routes | 124 / 124 passed |
| Typecheck and production builds (API Node, web Node, edge probe) | passed |
| Real Chromium journey (signup, monitor, incident, webhook, disabled billing, reset link) | BROWSER_E2E_PASS |
| Script CSP: 75 inline scripts on 35 pages hashed; enforced in Chromium with 0 violations | CSP_HASHES_PASS, CSP_PASS |
| Landing CSP: 4 pages | LANDING_CSP_CHECK_PASS |
| Password page: locked form, wrong and correct password, access cookie | STATUS_PASSWORD_PASS |
| Custom domain routing through the real server | CUSTOM_DOMAIN_SMOKE_PASS |
| Graceful SIGTERM drain | NODE_SIGTERM_PASS |
| SIGKILL mid-retry, no duplicate incident, DB outage recovery, two workers | CRASH_RECOVERY_PASS |
| Backup/restore: 47 tables, row counts and SHA-256 content | RESTORE_DRILL_PASS |
| Restore negative control: a disabled trigger must fail the drill | RESTORE_CATALOG_NEGATIVE_PASS |
| Loopback SMTP: channel test, cron down/recovery, account mail | SMTP_LOOPBACK_PASS, SMTP_ERROR_LOG_PRIVACY_PASS |
| No donor branding in active code | MONTRAL_ACTIVE_BRAND_SCAN_PASS |
| Network partition and primary promotion | FAILOVER_PASS |

## 5. Reliability and failover

Qualified on real processes and real PostgreSQL, not mocks:

- **Graceful shutdown** (PRs #9-#11): SIGTERM drains the check queue and closes HTTP and
  the database pool.
- **Crash recovery** (#16, `qualify-crash-recovery.mjs`): SIGKILL during an in-flight
  alert retry resumes without a duplicate incident or alert; a database outage is
  survived and recovered; two workers do not double-process.
- **Network partition** (#23, `qualify-failover.mjs`, scenario A): a 45-second
  black-hole between the app and the primary, via Toxiproxy. Negative controls prove no
  writes and no database-backed answers during the partition. Service resumes after it.
- **Primary promotion** (#23, scenario B): the primary is killed, the synchronous replica
  is promoted, and the proxy is repointed. The app recovers with no lost committed write.
  A negative control proves replication was really synchronous: with the replica paused,
  a commit waits.
- **Duplicate prevention:** advisory locks for migrations and checkout, row locks for
  webhook capture, idempotent alert and email quota reservation (earlier evidence files).
- **Webhook delivery and replay** (#17): replay is SSRF-guarded and never mutates the
  stored event.
- **Health reporting:** `/health` for the container healthcheck; the failover
  qualification uses a database-backed public endpoint to tell "process up" from
  "database reachable".

**Not qualified:** multi-node app replicas behind a load balancer under real traffic;
hosted or cross-region failover; managed PITR; sustained load and capacity.
Single-host Docker topologies are what the evidence covers.

## 6. Security audit

| Control | Evidence |
|---|---|
| SSRF guard on checks, alerts, replay, RDAP and TLS (DNS-resolved address checks, redirect re-validation) | `netguard.ts` tests, #17, #26 |
| CSRF: cookie-authenticated writes need a same-origin Origin header | #14 |
| Clickjacking, nosniff and referrer headers | #15 |
| Script CSP on app, SSR status and landing pages | #19, #22 |
| Password pages: PBKDF2-SHA256 at 100k iterations, constant-shape 401, timing-safe dummy hash | #21 |
| Access cookie: HMAC-signed, bound to page, access version and link, expiry of at most 12 h; revoke-all bumps the version | #21 |
| Share links: only a SHA-256 token hash is stored; cap enforced under a row lock; revocable | #21 |
| Unlock rate limits: per-IP limits (20 and 8 per page per 15 min, never refunded) and an atomic per-page failure limit refunded on a correct password | #21 |
| Subscriber mail respects page visibility and access version | #21 |
| Custom domains: TXT proof, no app, sign-in or cookies on status domains, unknown hosts 404 | #29 |
| Log privacy: unhandled errors log only a safe class; provider errors are categorised | #20, earlier evidence |
| Mattermost mention injection neutralised | #28 |

**Open security items:**

1. Billing-test flake: a billing E2E once got a status other than the expected 409 on
   main. #20 added safe error-class logging to diagnose it. The root cause was not
   reproduced and remains **unresolved**.
2. A custom domain stays verified until another page proves it or the owner removes it;
   there is no periodic TXT re-check yet.
3. Members-only pages are not served on custom domains (by design, 404), and share links
   point at the main address.
4. Reverse-proxy access logs must redact bearer tokens in subscriber, unsubscribe, share
   and webhook receiver URLs. This is documented, and the operator's responsibility.
5. No third-party penetration test, full WCAG audit or cross-browser (Firefox/WebKit)
   test has been done.

## 7. Known limitations and open items before an RC tag

1. **PostgreSQL version mismatch:** `docker-compose.yml` ships `postgres:18.6-alpine`,
   but all CI qualification runs on PostgreSQL 17. Either qualify 18 in CI or pin
   compose to 17.
2. **Platform coverage:**
   - **Linux:** fully covered in CI on every PR.
   - **Windows:** used only for local development during this programme. Docker/WSL was
     broken on the development machine, so database and browser suites were not run
     there. No Windows qualification is claimed.
   - **macOS:** the full suite last passed on a supported Mac at an earlier revision
     (1,041/1,041 on 2026-11-02; see `CURRENT-STATUS.md`). Not re-run at `9db0d3d`.
3. External email deliverability (real SMTP/Resend), live APNs push and live payment
   provider: not qualified. Billing remains off and test-mode only.
4. The items in section 6, "Open security items".

## 8. Install and operations documentation

- Docker install, environment, reverse proxy, TLS, custom domains, APNs, GitHub sign-in
  and upgrades: `/docs/self-host` (`apps/web/src/pages/docs/self-host.astro`), served
  by every instance.
- Backup and restore: `/docs/backup`.
- REST API: `/docs/api`. Embeds and badges: `/docs/embed`.
- Environment reference: `.env.docker.example` and `docker-compose.yml`.
- Release gates and history: [RELEASE-GATES.md](RELEASE-GATES.md),
  [CURRENT-STATUS.md](CURRENT-STATUS.md). Per-change evidence: `docs/evidence/`.

The custom-domain docs were corrected in this pull request to match the merged
behaviour: DNS ownership decides takeover, and unknown hostnames get a 404.
