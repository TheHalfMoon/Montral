# Montral engineering task ledger

Prioritised list of release work, kept in the repository. Each item links its pull request and evidence. **Done**
means merged after an independent review and green CI on the exact pull request head; nothing here is done on
intention or documentation alone. Publication stays on hold until the owner says `GREEN LIGHT MONTRAL`.

Severity: **P0** release blocker, **P1** high impact, **P2** important, **P3** later.

## Release blockers and defects

| # | Item | Sev | Status | Evidence |
|---|---|---|---|---|
| 1 | PostgreSQL 18 (shipped compose image) never qualified; CI ran 17 only | P0 | Done: CI matrix 17 + exact `postgres:18.6-alpine`, failover on both, drift guard (#31) | `montral-ci.yml`, `montral-failover.yml` |
| 2 | macOS never re-qualified at the candidate revision | P0 | Done: macOS 15 ARM64 runner, full suite on PostgreSQL 18 (#32) | `montral-macos.yml` |
| 3 | Billing concurrency test flake (one unexplained 500) | P0 | Done: root cause = no-op migration DDL deadlocking checkout (40P01); RED reproduced on unfixed main (closed #34), fixed (#35) | `docs/evidence/2026-11-09-billing-migration-deadlock.md` |
| 4 | Custom domain stays verified after its TXT proof disappears | P1 | Done: periodic re-verification with grace periods and race-safe withdrawal (#33) | `docs/evidence/2026-11-09-custom-domain-reverification.md` |
| 5 | Shipped Docker image and compose stack never run in CI | P0 | Done: image build, compose, persistence, container recreation (#37) | `montral-docker.yml` |
| 6 | Changing the PostgreSQL tag to another major silently starts an empty cluster | P1 | Done: `PGDATA` pinned; PostgreSQL 17 proven to refuse the 18 volume without touching it (#37) | `scripts/qualify-docker.sh` |
| 7 | Manual "check now" unbounded (sockets, ping processes) | P2 | Done: 60 per workspace per 10 min, 32 in flight per process (#41) | `manual-check-limit.e2e.test.ts` |
| 8 | Unhandled fetch rejection on the status page editor (seen in mobile WebKit) | P2 | Done (#36) | `lib/mounted.ts`, cross-browser journey |
| 8a | Status page editor crashed for every page (React hook order, error #310) | P1 | Done (#36): found by the cross-browser journey | journey spec |
| 8b | Slug and ntfy-topic `pattern` invalid under the `v` regex flag (validation silently skipped) | P2 | Done (#36) | journey spec |
| 8c | Dashboard skip link did nothing; text contrast below WCAG AA | P2 | Done (#36) | 45 axe scans, 0 violations |
| 8d | Qualification flakes: load phase-5 window rule, Chromium CDP start-up deadline | P1 | Done (#43); both seen on PRs that did not touch the app | run 42609831385, run 42616676193 |
| 8e | `oauth-scope.e2e` flake: agent listed no inboxes after the session created one | P1 | In review (#53): product bug. Sign-up sessions had no active workspace (Better Auth runs `user.create.after` after the session is created), and the fallback `anyWorkspaceOf` was an unordered `LIMIT 1`, so a user's requests could switch workspace when membership rows moved on disk. Fixed by ordering the fallback and storing the personal workspace on the sign-up session. RED reproduced on real PostgreSQL in #53 (run 42695712956) | `docs/evidence/2026-11-10-oauth-scope-flake.md`, run 42682311112 attempt 1 |

## Capabilities

| # | Item | Sev | Status |
|---|---|---|---|
| 9 | ICMP ping monitor (Node) | P1 | Done (#38); runs inside the Docker image as the unprivileged user (#37) |
| 10 | Workspace audit log (API, export, MCP, UI, append-only, retention) | P1 | Done (#39) |
| 11 | Cross-browser (Chromium, Firefox, WebKit, mobile) + WCAG 2.1 AA gate | P1 | Done (#36) |
| 12 | Load, backpressure and pool-exhaustion qualification | P1 | Done (#40); no application defect found |
| 13 | On-call schedules (rotations, overrides) | P2 | Implemented in #48; independent review (1 high, 3 medium, 4 low) fixed on the same PR, awaiting re-review: schedules with layers, DST-correct rotations, restriction windows, overrides, escalation policies paging whoever is on call, iCal feed, REST + MCP + UI; `docs/evidence/2026-11-10-oncall.md` |
| 14 | SSO (OIDC; SAML if justified) | P2 | Implemented in #49; independent review (4 medium, 4 low) and re-review (1 high, 1 medium, 3 low) fixed on the same PR: per-workspace OIDC with verified domains, JIT provisioning, require-SSO with owner break-glass, instance-wide `OIDC_*`; SAML deferred with reasons (`docs/evidence/2026-11-10-oidc-sso.md`) |
| 15 | Terraform provider / config-as-code | P2 | Implemented, in review (#50): `terraform-provider-montral/` (6 resources incl. `montral_escalation_policy`, 2 data sources), acceptance tests in `montral-terraform.yml`; unpublished, build from source (`docs/evidence/2026-11-10-terraform-provider.md`) |
| 16 | Browser / multi-step synthetic checks | P3 | Not started; needs an isolated headless runtime |
| 17 | SMS / voice alerts | P3 | Blocked: paid provider, needs owner approval |
| 18 | Custom webhook responses (webhook.site parity) | P3 | In review (#47); evidence `docs/evidence/2026-11-10-webhook-responses.md` |
| 19 | Owner email when a custom domain is withdrawn | P3 | In review (#54): owners and admins emailed once per withdrawal and once per failing streak (second failed re-check), en/zh, through the alert delivery log with retries; idempotent by a unique dedupe key; never blocks the withdrawal; `docs/evidence/2026-11-10-custom-domain-notices.md` |
| 20 | Merge stale queued check runs after a slow-target backlog (one monitor can get up to 6 catch-up checks in 2 min) | P3 | In review (#54): a queued run is skipped as superseded (not checked, not billed) when a check started after its claim (and is under half an interval old, or the run is stale), or while an earlier run is in flight; final load run 42751836174: at most 2 results per monitor in any 60 s after recovery (was up to 6 in 120 s), phase 1 unchanged, coalesced runs counted; `docs/evidence/2026-11-09-load-backpressure.md` |
| 21 | Dark-mode contrast scan, screen-reader testing, real Safari/iOS devices | P2 | Not started; WebKit coverage is Playwright's Linux build |
| 22 | Grafana OnCall and other incident tools in the competitor matrix | P3 | Not started; needs primary-source verification |
| 23 | Upgrade from the previous release candidate never qualified (data, sessions, keys, links after migrations) | P1 | In review (#55): `montral-upgrade.yml` seeds 17f55c1 through its API, upgrades to HEAD on the same PostgreSQL 18 database and reads every entity back; `docs/evidence/2026-11-10-upgrade-rollback-dr.md` |
| 24 | Rollback path undefined and unqualified | P1 | In review (#55): supported rollback = restore the pre-upgrade backup into an empty database and start the old build (exact SHA-256 match); the old build on the upgraded schema refuses to start and changes nothing; self-host docs (en/zh) "Upgrade and rollback" |
| 25 | Disaster recovery (database lost under a running server) unqualified, no RTO | P1 | In review (#55): live backups (snapshot `pg_dump -Fc` and the documented compose command), database dropped, documented restore into a new database, HEAD verified; RTO 2.0 s on the synthetic dataset (run 42736834472); a newer-schema database is refused at once with a clear message; `docs/evidence/2026-11-10-upgrade-rollback-dr.md` |

## External dependencies (cannot be closed in engineering)

- Real SMTP/Resend deliverability, live APNs push, live payment provider: need accounts and owner approval.
- Third-party penetration test and screen-reader usability testing with real users.
- Public hosting, DNS, TLS and multi-region infrastructure: deployment is not authorized.
