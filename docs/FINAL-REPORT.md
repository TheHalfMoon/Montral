# Montral release-readiness report

**Current integration status (2026-11-13): FULL PRODUCT NO-GO.** Current inspected `main` is `d660e62` (PRs #106–#111 merged). Both `main@5096fdc` and `main@8435564` passed 11/11 integrated push workflows; #111 passed 11/11 exact-head checks before merge. Integrated push checks for `main@d660e62` were still in progress at the last verification. Workspace suspension history is a separate follow-up PR pending CI. Previous candidate `3fbc6e6` remains historical, not current release authorization. The prior `3fbc6e6` candidate and its historical passing checks remain recorded below, not as current release authorization.

Montral Cloud and Enterprise BYOC remain NO-GO pending external provider validation, authorized production infrastructure, legal/privacy review, resilience testing and independent security assessment. No release, tag, live payment, deployment or spend is authorized.

**Status: ENGINEERING COMPLETE FOR THE AGREED CORE CAPABILITIES — PUBLICATION HOLD.**
Nothing is released, deployed, packaged, published or tagged; that requires the owner's explicit authorization
(`GREEN LIGHT MONTRAL`). A public repository is not release authorization. No paid service was enabled and no cost was
incurred. Billing stays disabled by default and test-mode only. The Terraform provider is built from source and is not
published to any registry.

**Candidate revision:** `main` at **`3fbc6e6`** (2026-11-11), superseding `b01e28e`: all ten workflows succeeded on that exact commit (§12, [RELEASE-GATES.md](RELEASE-GATES.md) §S.1). Sections 2–9 describe the `b01e28e` round and its runs; the SaaS round #74–#84 is in §12. Every claim below points to a merged pull request, a CI run on
its exact head, or an evidence file in `docs/evidence/`. Anything not demonstrated is listed as open or blocked. The
prioritised task list is [TASK-LEDGER.md](TASK-LEDGER.md); the competitor comparison is [GAP-MATRIX.md](GAP-MATRIX.md).

## 1. Decision

| Target | Decision | Why |
|---|---|---|
| **Self-hosted Docker release (Community)** | **GO-eligible, once `GREEN LIGHT MONTRAL` is given** | Ships from `3fbc6e6`. Every release blocker in the ledger is closed with evidence, and every mandatory gate in [RELEASE-GATES.md](RELEASE-GATES.md) §A passes. All ten CI workflows passed at `b01e28e` and again at the candidate `3fbc6e6` on Linux (PostgreSQL 17 and the exact shipped 18.6 image) and macOS ARM64. The Docker image, compose stack, upgrade from `17f55c1`, rollback and disaster recovery are qualified. No critical, high or medium security finding is open; open items are low severity and listed. |
| **Public hosted service (SaaS)** | **NO-GO** | No production host or deployment authorization. No external SMTP, APNs or payment provider qualification. No multi-node or multi-region capacity qualification, no managed PITR, no third-party penetration test. |

Per delivery model (SaaS stages #74–#84, requalified at `3fbc6e6`; see §12 and [RELEASE-GATES.md](RELEASE-GATES.md) §S):
**Community** GO-eligible, pending the owner's release decision; **Montral Cloud** NO-GO; **Enterprise BYOC** NO-GO —
reference qualified, not commercially released.

## 2. Work merged in this round (since `17f55c1`)

Each pull request passed independent review and every CI check green on its exact head before merging; review
findings were fixed before merge except the two GitHub comments described below, fixed afterwards (reviews are agent reviews run in the engineering sessions; most are not posted on GitHub). Security-critical PRs
(#49, #52) went through repeated rounds until a reviewer cleared them. **Process gap:** on 2026-11-10 two review comments
posted on GitHub by the parallel assistant (#63, #67) were not read before those PRs merged; both are fixed by follow-up
PRs (#71, #70) and every merged PR's GitHub comments were then checked. The previously open gaps — fixes of #47 and #48
not re-reviewed, the security review requested on #53 — were closed on 2026-11-10 by independent security re-reviews
of the current code (ledger row 33); their findings were fixed in #64, whose fix was reviewed again.

| PR | Commit | Change | Independent reviews (agent reviewers in this programme) |
|---|---|---|---|
| #44 | `18be31f` | Dark-mode WCAG 2.1 AA scans on 5 browser projects; documentation links distinguishable without colour | 1 (correctness/a11y) |
| #47 | `b4590a4` | Configurable webhook responses (status, allow-listed headers, text bodies, XML/CSV as attachments, bounded delay) | 1 (2 medium, 3 low fixed; fixes verified by CI, not re-reviewed) |
| #48 | `5c5adbb` | On-call: schedules, layers, DST-correct rotations, overrides, escalation policies paging the on-call person, iCal, MCP, UI | 1 (1 high, 3 medium, 4 low fixed; fixes verified by CI and measured, not re-reviewed) |
| #50 | `05f5468` | Terraform provider (6 resources, 2 data sources, 22 acceptance tests); single-maintenance-window API | 2 (1 medium, 3 low fixed) |
| #53 | `8c34eb7` | Product bug behind an e2e flake: a session's workspace could switch between requests | 1 (correctness; a GitHub comment from the parallel assistant asked for a separate security review, not done) |
| #56 | `cdc92ed` | Mobile tap targets on segmented controls (found as an intermittent browser-test failure) | 1 (correctness) |
| #49 | `cd40984` | OIDC single sign-on: per-workspace and instance-wide, verified and re-checked domains, require-SSO for every credential type (the workspace owner is exempt as break-glass) | 4 (1 high, 6 medium fixed; cleared) |
| #55 | `52bb319` | Upgrade from `17f55c1`, rollback and disaster recovery in CI; refusal of a newer schema with a clear message | 2 (1 medium fixed). A later harness finding (backup stream not awaited before restore) was fixed by #58 |
| #54 | `c1b7928` | Custom-domain withdrawal notices (transactional outbox); coalescing of stale queued checks after a backlog | 2 (1 medium fixed) |
| #52 | `0b93696` | Synthetic browser monitoring in a separate hardened browser-runner | 6 (1 high, 11 medium fixed; cleared) |
| #58 | `678c363` | Fail-closed Docker backup/restore transfer in the upgrade/DR harness: await exit and the full stream, never overwrite, remove partial files; truncated-dump negative control | 1 agent review in the session, not posted to GitHub (no correctness defect; 2 low fixed); recorded in `docs/evidence/2026-11-10-upgrade-rollback-dr.md` |
| #61 | `9d96ba6` | Regression test: 60/hour on-call override limit counts rejected attempts (by the parallel assistant) | 1 (this programme; the test fails without the limiter) |
| #62 | `fa275ec` | Physical Mac: native Safari 26.6.2 public landing 8/8 (WebDriver, not Playwright); stdlib harness (by the parallel assistant) | 1 (this programme); exact-head CI 13/13 |
| #63 | `b465ed3` | Credit refunds to the month they were spent in; OIDC userinfo fallback (same `sub`, literal `email_verified`); coverage comment | 1 (no medium+; 6 low fixed). **A review comment posted on GitHub before the merge (refund booked at a second timestamp) was missed; fixed afterwards in #71** |
| #64 | `f3165c4` | Security re-review follow-ups for #47, #48, #53: DB released before webhook delays on Workers; project-scoped on-call names; calendar-feed lockout; audit detail; keys pinned to a workspace revoked with the membership | 3 re-reviews (1 medium) + 1 review of the fix (1 medium, lows) — all fixed |
| #65 | `25c8c65` | Two replicas behind nginx: overlay, CI qualification (sessions, client attribution, webhooks once, rolling restart, no duplicate checks, single incident) | 1 (1 high, 4 medium fixed) |
| #66 | `3c1c67a` | Scripted browser-check step (`evaluate`, page context, returns `true`; owners/admins only; never with secrets) | 1 (1 medium, lows fixed) |
| #67 | `375e867` | SCIM 2.0 provisioning and deprovisioning (Users), JIT gate, UI, docs, migration 0057 | 1 (2 high, 2 medium fixed) + 1 re-review of the fixes. **A blocking review posted on GitHub before the merge (transitions not atomic) was missed; fixed afterwards in #70, closing issue #68** |
| #71 | `3e93722` | Charge and refund of a browser check booked at one instant (the missed #63 comment); a manual check that cannot be paid in full gives its partial grant back | 1 (1 medium pre-existing on main, fixed here) |
| #70 | `65dd117` | Atomic SCIM transitions (closes issue #68): one transaction per change with the record locked, audit inside; SSO first sign-in re-checks the gate under the record lock; retryable 503 on deadlock | 2 (no medium+ in the diff; 1 medium on the SSO side and 1 deadlock found in the follow-up, both fixed); real-PostgreSQL failure-injection and lock tests |
| #73 | `b01e28e` | Root causes of two intermittent load-qualification failures on main: memory overshoot was uncollected garbage (both servers now run with the 512 MB heap limit `docker-compose.yml` ships; RSS bound tightened 1024 → 850 MB; `/api/monitors` allocates about 40 % less); the post-recovery coalescing bound now applies to runs started after recovery, with in-flight results bounded separately (cause deduced, not observed) | 1 (1 high, 2 medium fixed); load passed 3/3 on the exact head |

The previous round (#12–#43) is summarised in the git history and the earlier version of this report.

## 3. Capabilities

**Monitoring:** HTTP(S) with keyword and JSON assertions; TCP; DNS; ICMP ping; TLS certificate and domain expiry;
heartbeat/cron; WebSocket; PostgreSQL/MySQL/Redis; multi-region edge probes; declarative browser journeys (goto, click,
fill with write-only secrets, waitFor, assertions, and a page script step for owners and admins) run in an isolated
browser-runner.

**Incidents and on-call:** automatic and manual incidents with timeline, acknowledgement (assigns if unassigned),
reminders, postmortems; on-call schedules with layers, restriction windows and overrides; escalation policies with
step timeouts and repeats, paging channels, named people and whoever is on call; iCal feed; 14 alert channels.

**Status pages:** public, members-only and password pages; revocable expiring share links; custom domains (Node) with
periodic re-verification and owner notices; subscribers; maintenance windows; badges, RSS, ICS, llms.txt.

**Webhooks:** capture, search, paging, delete, SSRF-guarded replay, configurable responses.

**Platform:** REST API, OAuth MCP server, API keys with project scopes, Terraform provider (unpublished), audit log
with export, OIDC SSO (with userinfo fallback), SCIM 2.0 user provisioning and deprovisioning, 2FA, roles, Docker
self-hosting with several replicas behind a load balancer, upgrade/rollback/DR procedures.

**Not implemented (ranked in the ledger):** SAML (deferred with reasons: every identity provider targeted supports
OIDC, and SAML's XML-signature handling would add a large attack surface; ledger row 37), SCIM groups and bulk
operations, SMS/voice (paid provider — needs approval), custom monitor regions for browser checks.

## 4. Test results at the candidate revision

GitHub Actions on `b01e28e` (Linux: `ubuntu-latest` image, 4 vCPU / 16 GB). All ten workflows ran on that exact commit (push to `main`):

| Workflow | Result |
|---|---|
| App CI — PostgreSQL 17 and 18.6-alpine ([run 42950068476](https://github.com/TheHalfMoon/Montral/actions/runs/42950068476)) | Pass on both: API + real-PostgreSQL E2E 1,427 passed, 23 skipped (1,450) per leg (21 real-Chromium browser-check tests and 2 browser e2e that need Chromium; they run required in the browser-checks job), 0 failed; probe 22/22; web 129/129; restore drill 62 tables with catalog negative control; pg_dump 17.11 / 18.6 |
| macOS 15 ARM64, PostgreSQL 18 ([run 42950068343](https://github.com/TheHalfMoon/Montral/actions/runs/42950068343)) | Pass: same counts (1,427 / 23 skipped, 22, 129); restore drill 62 tables |
| Browser checks — Chromium, egress policy, API, hardened runner stack ([run 42950068702](https://github.com/TheHalfMoon/Montral/actions/runs/42950068702)) | Pass: 122/122 (incl. the script step: pass on `true`, fixed failures, script fetches to loopback and metadata blocked), BROWSER_RUNNER_PASS |
| Cross-browser and accessibility ([run 42950068348](https://github.com/TheHalfMoon/Montral/actions/runs/42950068348)) | Pass: 55/55 across Chromium, Firefox, WebKit, Pixel 7, iPhone 14, light and dark; 95 axe scans, 0 violations of any impact |
| Terraform provider ([run 42950068326](https://github.com/TheHalfMoon/Montral/actions/runs/42950068326)) | Pass: 22/22 acceptance tests against a real server, 0 skipped |
| Upgrade, rollback, disaster recovery ([run 42950068346](https://github.com/TheHalfMoon/Montral/actions/runs/42950068346)) | Pass: transfer integrity tests 11/11; truncated dump refused; every seeded entity kept from `17f55c1` to HEAD (now including migration 0057); exact rollback restore; RTO 2.2 s on the synthetic dataset |
| Load qualification ([run 42950068456](https://github.com/TheHalfMoon/Montral/actions/runs/42950068456)) | Pass: 4,000 monitors at 4,000 checks/min, lag p95 61.2 s, 64,419 results == target requests, backlog drained in 133 s, 164 webhooks/s, no 5xx; memory bound 850 MB with the shipped 512 MB heap limit; post-recovery coalescing bounds held |
| Docker Compose and replicas ([run 42950068358](https://github.com/TheHalfMoon/Montral/actions/runs/42950068358)) | Pass: DOCKER_COMPOSE_PASS; REPLICAS_PASS — 2 replicas behind nginx, one session, client address attributed, 60/60 concurrent webhooks stored once, rolling restart lost 0 of 219 reads and 0 of 46 webhook posts (each stored once), 5–6 runs per 60 s monitor in 330 s with a minimum gap of 30 s, 1 incident from 6 failed runs |
| Failover on PostgreSQL 17 and 18.6 ([run 42950068372](https://github.com/TheHalfMoon/Montral/actions/runs/42950068372)) | Pass: FAILOVER_PASS on both |
| Source integrity ([run 42950068583](https://github.com/TheHalfMoon/Montral/actions/runs/42950068583)) | Pass |

Physical hardware outside CI (not at the candidate revision): native Safari 26.6.2 on an Apple Silicon Mac (macOS 26.6.2), public landing 8/8 at
`dc02d02` (#62, `docs/evidence/2026-11-10-physical-macos-native-safari-landing.md`).

## 5. Reliability and recovery

Demonstrated on real processes and real PostgreSQL: graceful SIGTERM; SIGKILL mid-retry with no duplicates; database
outage recovery; network partition; primary promotion with no committed row lost; sustained load with 0 lost or
duplicated checks; bounded backpressure and pool exhaustion; coalescing of stale queued checks after a backlog (asserted: at most 3 results per monitor per interval, and at most 2 within any 10 s from runs started after recovery; previously 6 per 2 minutes); upgrade from `17f55c1` (the previous release-candidate baseline); a truncated backup is refused by the documented restore (end to end), and partial writes, failed or killed `pg_dump` and broken streams are rejected by the harness (unit tests with a simulated Docker process); rollback by
restoring the pre-upgrade backup; disaster recovery into a new database (RTO 2.1 s — a floor on a tiny dataset, not a
capacity figure); a newer schema refused at startup with a clear message; two app replicas behind nginx on one
PostgreSQL (#65): one session across replicas, the client's address attributed, concurrent webhooks stored once, a
rolling restart under continuous reads and webhook posts with no failed request, no scheduled run executed by both
replicas (5–6 runs per 60-second monitor in 330 s, at least 30 s apart; the check rejects more than 8 or gaps under
15 s), a failing monitor opening exactly one incident.

**Not demonstrated:** replicas on different hosts; a rolling upgrade with old and new versions side by side; hosted or
cross-region failover; managed PITR; capacity beyond one 4-vCPU node; real network latency in the load test.

## 6. Security assessment

Every control below has a regression test in CI. This round added:

| Area | Control | Evidence |
|---|---|---|
| Single sign-on | OIDC code flow with PKCE, state and nonce single-use; id_token validated with jose (asymmetric algorithms only); `email_verified` required; email never auto-links an existing account; verified domains re-checked; require-SSO enforced for sessions, API keys, agent tokens bound to the authorizing session, and auth-library endpoints, with the owner exempt as break-glass; removed members blocked from re-provisioning | #49, `sso.e2e.test.ts`, `sso-oidc.test.ts` |
| Browser checks | Chromium only in a separate runner with no database credentials or app secrets, off the database network, signed and replay-protected channel, sealed secrets, `cap_drop: ALL`, read-only root, custom seccomp; every request through an egress proxy that pins validated addresses; WebRTC and WebTransport proven not to leave the host; per-workspace fairness, time budget, credits reserved before launch; screenshots of secret-using runs restricted to managers | #52, browser-checks workflow |
| Webhook responses | Header allow-list, text bodies only, XML/CSV as attachments with sandbox CSP, privacy headers non-overridable, delay never refuses capture | #47 |
| On-call | Override limits and a single-sweep engine (paging cost under a millisecond), calendar links session-only and `no-store`, no member emails to API keys or agents | #48 |
| Session workspace | Deterministic active workspace (previously a request could switch workspace) | #53 |
| Re-review of #47/#48/#53 | Workers: a delayed webhook response no longer holds a PostgreSQL connection (could exhaust `max_connections`); project-limited keys never see other projects' monitor or policy names; calendar feeds cannot be locked out with random tokens; deletes audited with their project; per-method response status and redirect host audited; API keys pinned to a workspace revoked with the membership, and pinning requires membership | #64, `montral-hooks.test.ts`, `oncall.e2e.test.ts`, `membership.e2e.test.ts` |
| OIDC userinfo | Used only when the verified id_token has no verified email; same `sub` (constant-time), literal `email_verified: true`, never swaps an unverified address; SSRF-guarded like every provider request | #63, `sso-oidc.test.ts`, `sso.e2e.test.ts` |
| SCIM | Per-workspace token (owner session only, SHA-256 stored, one active, revoked with the SSO connection); verified domains only; JIT admits only assigned people; deactivation ends the membership, sessions and pinned keys (owner refused); SCIM never adds an existing account; 64 KiB bodies; cross-workspace 404 | #67, `sso.e2e.test.ts` |
| Browser script step | Runs in the page (renderer) of the isolated runner behind the same egress policy, never in Node; only `true` crosses back; fixed error strings; owners and admins only; never in a journey with secrets | #66, `browser-check.integration.test.ts` |
| Replicas | Load balancer at a fixed, exactly trusted address (client addresses for rate limits and audit); only unsent connections are retried (nothing sent twice) | #65, `qualify-replicas.sh` |

**Open security findings: none critical, high or medium** (self-assessed by independent agent reviews; see ledger rows 33–41 for accepted lows). Residual: no third-party penetration
test; GitHub Actions pinned by tag; reverse-proxy logs must redact bearer tokens in URLs (documented); OAuth dynamic
client registration is unauthenticated (pre-existing; clients get nothing without user consent).

## 7. Platform coverage

| Platform | Status |
|---|---|
| Linux x86-64 | Qualified on every PR: PostgreSQL 17 and 18.6 (Alpine, as shipped) |
| macOS 15 ARM64 (GitHub-hosted) | Qualified on every PR at the candidate revision |
| Docker / Docker Compose | Qualified on every PR, including the optional browser-runner stack and two replicas behind nginx |
| Browsers | Chromium, Firefox, WebKit (Playwright's Linux build), Pixel 7 and iPhone 14 emulation, light and dark themes |
| Native Safari on physical Apple hardware | **Public landing qualified** (#62): Safari 26.6.2 on macOS 26.6.2 (Apple Silicon), real WebDriver session, 8/8 (four languages, light/dark, 390 px). **Not qualified:** the signed-in app with a database, VoiceOver, physical iOS Safari — the Mac has ~3.8 GiB free and incompatible Node/pnpm, so no app build was attempted there (ledger row 36) |
| Windows | **Not supported as a native server platform.** Docker Desktop (WSL 2) runs the same Linux image but was not tested: Docker Desktop is installed on the development machine but was not running and was not started (owner decision) |

## 8. Known limitations for a self-hosted release

1. TLS certificate monitors, ping, custom domains and browser checks need the Node/Docker server; the Cloudflare
   Workers build refuses them with 400. Browser checks also need the optional browser-runner stack.
2. Members-only status pages are not served on custom domains; share links point at the main address.
3. SSO: OIDC only (no SAML), one connection per workspace; SCIM covers users, not groups or bulk operations.
4. External email deliverability, live APNs push and live payments are not qualified; billing is off.
5. Several replicas: qualified on one host; per-process limits (delayed webhook responses, manual checks,
   `MAX_BROWSER_CHECKS`) multiply with replicas; rolling upgrades are not qualified (restarts are).
6. Low-severity follow-ups and accepted risks in ledger rows 26–41.

## 9. Install and operations documentation

- `/docs/self-host` (served by every instance, en + zh): install, environment, reverse proxy and TLS, custom domains,
  ping in Docker, browser-runner stack and sizing, several replicas behind a load balancer, SSO configuration, SCIM
  provisioning, on-call, PostgreSQL version policy, upgrade and rollback, APNs, GitHub sign-in.
- `/docs/backup`, `/docs/api` (incl. audit log, on-call, SSO, webhook responses, Terraform), `/docs/mcp`.
- `terraform-provider-montral/README.md` for building the provider from source.
- Reproducible qualification scripts: `scripts/qualify-docker.sh`, `qualify-replicas.sh`, `qualify-upgrade.mjs`,
  `qualify-load.mjs`, `qualify-failover.mjs`, `qualify-crash-recovery.mjs`, `qualify-backup.mjs`, and
  `qualify-native-safari-landing.py` (physical Mac only).
- Per-change evidence in `docs/evidence/`.

## 10. External approvals needed for a public launch

1. `GREEN LIGHT MONTRAL` before any tag, image, package, provider publication or deployment.
2. Hosting account, domain and TLS for a hosted service (paid infrastructure needs approval).
3. Email provider, APNs credentials and a live payment provider account, if those features are offered; an SMS/voice
   provider if wanted.
4. Commercial terms, privacy policy and legal review of the bundled `/terms` and `/privacy`.
5. A provisioned host (or more free space and pinned Node/pnpm on the Mac) for the signed-in native Safari journeys and
   VoiceOver, and a physical iPhone for iOS Safari, if those must be qualified.
6. Starting Docker Desktop on the Windows development machine (it is installed but not running) to qualify the
   Windows Docker Desktop / WSL 2 path.
7. A third-party penetration test: a blocker for Montral Cloud and Enterprise BYOC ([RELEASE-GATES.md](RELEASE-GATES.md) S7), not optional for them.

## 11. Open pull requests not from this programme

#72 (draft, by the parallel assistant) proposes wording that does not imply qualification of a head that was not requalified; this report now cites runs on the exact candidate `b01e28e`, so #72 is left to its author to close or rebase. #45 (blocked Safari preflight) was closed as superseded by #62 after its remaining checklist was moved to ledger
row 36; #61 and #62 from the parallel assistant were reviewed and merged; #46, #51 and #57 were closed earlier.

## 12. SaaS delivery models: real, sandbox, missing (`main` at `3fbc6e6`)

Stages merged on 2026-11-11: #75 (plan catalog, fail-closed metering), #76 (operator plane, suspension), #77 (billing
lifecycle, sandbox), #81 (webhook-event and browser-second metering), #82 (multi-region confirmation, probe health and
drain), #83 (onboarding and usage UX), #79 (BYOC reference), and fixes #74 (scheduler claim margin), #78 (slug
collisions), #80 (replica restart coverage gate), #84 (verification-bar layout shift). Ledger rows 42–52; follow-ups in
rows 53–65. Commercial terms live in private operator configuration and are not part of the repository.

**Requalification at `3fbc6e6`:** all ten workflows succeeded — app CI 43010585281, macOS 43010585268, browser checks 43010585116, cross-browser 43010585084 (60 passed), Terraform 43010585068, upgrade/rollback/DR 43010585124, load 43010585062, Docker Compose incl. replicas and BYOC 43010585390, failover 43010585122, source integrity 43010585138. Details in [RELEASE-GATES.md](RELEASE-GATES.md) §S.1.

| | What it is |
|---|---|
| **Real (qualified in CI)** | Operator plane gated by session and second factor; server-side suspension across API, scheduler, alerts, heartbeats, webhooks and public pages; operator-supplied plan catalog; metering of check credits, emails, webhook events and browser seconds that fails closed on catalog or ledger errors (self-hosted stays unmetered); plan region cap at check time; confirmation of a lone regional failure from the scheduler's location; probe health and drain; onboarding checklist, usage banner, quota messages and suspended notice; BYOC overlay on an internal network: the server process made no connection except to its database, loopback and the failing test monitor's own target (19 attempts: 7 database connects, 11 DNS lookups, 1 connect to the monitor's target, 0 elsewhere). Not covered: Google Fonts loaded by the end user's browser; child processes of the server (for example `/bin/ping`); the browser-runner, a separate container (off in the BYOC run) |
| **Sandbox only** | Billing lifecycle (checkout, plan changes, payment failure with grace, recovery, refund, expiry, reconciliation hook) against synthetic signed events in test mode. Provider behaviours assumed from public docs are unverified; no reconciliation job; chargebacks not handled |
| **Simulated, not deployed** | Multi-region: probes are simulated in tests; no probe is deployed and no cross-region run exists. Metered and suspended UI states are mocked API responses in the browser tests |
| **Missing (external)** | Merchant account and payment provider credentials; hosting provider and paid infrastructure authorization; legal terms and privacy (terms, privacy policy, DPA); external penetration test; email provider; support and incident-response organisation; owner commercial decisions pending; `GREEN LIGHT MONTRAL` |
| **Missing (engineering follow-ups)** | Unchecked digest for non-browser monitors; drain audit; per-region credit refunds; metering of webhook replay and inbox count; per-plan status-page and feature gates; sub-60 s plan intervals; first-load-per-tab late banners; SCIM/SSO behaviour during suspension; `past_due_since` backfill; SSO JIT slug retry; operator UI; probe registration and per-probe credentials (ledger 65); the further follow-ups in ledger rows 66–73 |

**Decision:** Community GO-eligible, pending the owner's release decision. Montral Cloud NO-GO. Enterprise BYOC NO-GO —
reference qualified, not commercially released. Nothing was tagged, released or deployed.
