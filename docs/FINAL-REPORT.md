# Montral release-readiness report

**Status: ENGINEERING COMPLETE FOR THE AGREED CORE CAPABILITIES — PUBLICATION HOLD.**
Nothing is released, deployed, packaged, published or tagged; that requires the owner's explicit authorization
(`GREEN LIGHT MONTRAL`). A public repository is not release authorization. No paid service was enabled and no cost was
incurred. Billing stays disabled by default and test-mode only. The Terraform provider is built from source and is not
published to any registry.

**Candidate revision:** `main` at `0b93696` (2026-11-10). Every claim below points to a merged pull request, a CI run on
its exact head, or an evidence file in `docs/evidence/`. Anything not demonstrated is listed as open or blocked. The
prioritised task list is [TASK-LEDGER.md](TASK-LEDGER.md); the competitor comparison is [GAP-MATRIX.md](GAP-MATRIX.md).

## 1. Decision

| Target | Decision | Why |
|---|---|---|
| **Self-hosted Docker release** | **GO, once `GREEN LIGHT MONTRAL` is given** | Every release blocker in the ledger is closed with evidence. All ten CI workflows pass at the candidate revision on Linux (PostgreSQL 17 and the exact shipped 18.6 image) and macOS ARM64. The Docker image, compose stack, upgrade from the previous candidate, rollback and disaster recovery are qualified. No critical, high or medium security finding is open; open items are low severity and listed. |
| **Public hosted service (SaaS)** | **NO-GO** | No production host or deployment authorization. No external SMTP, APNs or payment provider qualification. No multi-node or multi-region capacity qualification, no managed PITR, no third-party penetration test. |

## 2. Work merged in this round (since `17f55c1`)

Each pull request passed independent review with every finding fixed and every CI check green on its exact head before
merging. Security-critical PRs (#49, #52) went through repeated rounds until a reviewer cleared them; for #47 and #48 the
fixes were verified by CI (and, for #48, by measurement) but not by a second reviewer — noted as a residual risk.

| PR | Commit | Change | Independent reviews (agent reviewers in this programme) |
|---|---|---|---|
| #44 | `18be31f` | Dark-mode WCAG 2.1 AA scans on 5 browser projects; documentation links distinguishable without colour | 1 (correctness/a11y) |
| #47 | `b4590a4` | Configurable webhook responses (status, allow-listed headers, text bodies, XML/CSV as attachments, bounded delay) | 1 (2 medium, 3 low fixed; fixes verified by CI, not re-reviewed) |
| #48 | `5c5adbb` | On-call: schedules, layers, DST-correct rotations, overrides, escalation policies paging the on-call person, iCal, MCP, UI | 1 (1 high, 3 medium, 4 low fixed; fixes verified by CI and measured, not re-reviewed) |
| #50 | `05f5468` | Terraform provider (6 resources, 2 data sources, 22 acceptance tests); single-maintenance-window API | 2 (1 medium, 3 low fixed) |
| #53 | `8c34eb7` | Product bug behind an e2e flake: a session's workspace could switch between requests | 1 (correctness; a GitHub comment from the parallel assistant asked for a separate security review, not done) |
| #56 | `cdc92ed` | Mobile tap targets on segmented controls (found as an intermittent browser-test failure) | 1 (correctness) |
| #49 | `cd40984` | OIDC single sign-on: per-workspace and instance-wide, verified and re-checked domains, require-SSO for every credential type (the workspace owner is exempt as break-glass) | 4 (1 high, 6 medium fixed; cleared) |
| #55 | `52bb319` | Upgrade from `17f55c1`, rollback and disaster recovery in CI; refusal of a newer schema with a clear message | 2 (1 medium fixed). **A later harness finding is unfixed:** the backup written by `scripts/qualify-upgrade.mjs` can be truncated (stream not awaited before restore); fix in draft #58 by the parallel assistant, not merged yet |
| #54 | `c1b7928` | Custom-domain withdrawal notices (transactional outbox); coalescing of stale queued checks after a backlog | 2 (1 medium fixed) |
| #52 | `0b93696` | Synthetic browser monitoring in a separate hardened browser-runner | 6 (1 high, 11 medium fixed; cleared) |

The previous round (#12–#43) is summarised in the git history and the earlier version of this report.

## 3. Capabilities

**Monitoring:** HTTP(S) with keyword and JSON assertions; TCP; DNS; ICMP ping; TLS certificate and domain expiry;
heartbeat/cron; WebSocket; PostgreSQL/MySQL/Redis; multi-region edge probes; declarative browser journeys (goto, click,
fill with write-only secrets, waitFor, assertions) run in an isolated browser-runner.

**Incidents and on-call:** automatic and manual incidents with timeline, acknowledgement (assigns if unassigned),
reminders, postmortems; on-call schedules with layers, restriction windows and overrides; escalation policies with
step timeouts and repeats, paging channels, named people and whoever is on call; iCal feed; 14 alert channels.

**Status pages:** public, members-only and password pages; revocable expiring share links; custom domains (Node) with
periodic re-verification and owner notices; subscribers; maintenance windows; badges, RSS, ICS, llms.txt.

**Webhooks:** capture, search, paging, delete, SSRF-guarded replay, configurable responses.

**Platform:** REST API, OAuth MCP server, API keys with project scopes, Terraform provider (unpublished), audit log
with export, OIDC SSO, 2FA, roles, Docker self-hosting, upgrade/rollback/DR procedures.

**Not implemented (ranked in the ledger):** SAML and SCIM, SMS/voice (paid provider — needs approval), scripted
(code) browser checks, custom monitor regions for browser checks.

## 4. Test results at the candidate revision

GitHub Actions on `0b93696` (Linux: `ubuntu-latest` image, 4 vCPU / 16 GB):

| Workflow | Result |
|---|---|
| App CI — PostgreSQL 17 and 18.6-alpine ([run 42787353318](https://github.com/TheHalfMoon/Montral/actions/runs/42787353318)) | Pass on both: API + real-PostgreSQL E2E 1,406 passed (22 real-Chromium browser-check tests skipped here by design; they run required in the browser-checks job), probe 22/22, web 129/129; restore drill 60 tables; Chromium journey, crash recovery, SMTP, CSP and branding markers |
| macOS 15 ARM64, PostgreSQL 18 ([run 42787353452](https://github.com/TheHalfMoon/Montral/actions/runs/42787353452)) | Pass: same suites |
| Browser checks — Chromium, egress policy, API, hardened runner stack ([run 42787353525](https://github.com/TheHalfMoon/Montral/actions/runs/42787353525)) | Pass: 118/118, BROWSER_RUNNER_PASS (default image has no browser; runner has no app secrets and cannot reach PostgreSQL) |
| Cross-browser and accessibility ([run 42787353400](https://github.com/TheHalfMoon/Montral/actions/runs/42787353400)) | Pass: 55/55 across Chromium, Firefox, WebKit, Pixel 7, iPhone 14, light and dark themes; 0 axe violations of any impact |
| Terraform provider ([run 42787353302](https://github.com/TheHalfMoon/Montral/actions/runs/42787353302)) | Pass: 22/22 acceptance tests against a real server |
| Upgrade, rollback, disaster recovery ([run 42787353428](https://github.com/TheHalfMoon/Montral/actions/runs/42787353428)) | Pass: every seeded entity kept from `17f55c1` to HEAD; exact rollback restore; RTO 1.9 s on the synthetic dataset |
| Load qualification ([run 42787353316](https://github.com/TheHalfMoon/Montral/actions/runs/42787353316)) | Pass: 4,000 monitors at 4,003 checks/min, lag p95 61.7 s, 63,327 results == target requests, backlog drained in 132 s, no 5xx |
| Docker Compose ([run 42787353295](https://github.com/TheHalfMoon/Montral/actions/runs/42787353295)) | Pass: health, ping monitor up inside the image, persistence, PostgreSQL 17 refuses the 18 volume |
| Failover on PostgreSQL 17 and 18.6 ([run 42787353304](https://github.com/TheHalfMoon/Montral/actions/runs/42787353304)) | Pass |
| Source integrity ([run 42787353707](https://github.com/TheHalfMoon/Montral/actions/runs/42787353707)) | Pass |

## 5. Reliability and recovery

Demonstrated on real processes and real PostgreSQL: graceful SIGTERM; SIGKILL mid-retry with no duplicates; database
outage recovery; network partition; primary promotion with no committed row lost; sustained load with 0 lost or
duplicated checks; bounded backpressure and pool exhaustion; coalescing of stale queued checks (at most 2 results per
monitor per minute after recovery, down from 6 per 2 minutes); upgrade from the previous candidate; rollback by
restoring the pre-upgrade backup; disaster recovery into a new database (RTO 1.9 s — a floor on a tiny dataset, not a
capacity figure); a newer schema refused at startup with a clear message.

**Not demonstrated:** several app nodes behind a load balancer under real traffic; hosted or cross-region failover;
managed PITR; capacity beyond one 4-vCPU node; real network latency in the load test.

## 6. Security assessment

Every control below has a regression test in CI. This round added:

| Area | Control | Evidence |
|---|---|---|
| Single sign-on | OIDC code flow with PKCE, state and nonce single-use; id_token validated with jose (asymmetric algorithms only); `email_verified` required; email never auto-links an existing account; verified domains re-checked; require-SSO enforced for sessions, API keys, agent tokens bound to the authorizing session, and auth-library endpoints, with the owner exempt as break-glass; removed members blocked from re-provisioning | #49, `sso.e2e.test.ts`, `sso-oidc.test.ts` |
| Browser checks | No user code; Chromium only in a separate runner with no database credentials or app secrets, off the database network, signed and replay-protected channel, sealed secrets, `cap_drop: ALL`, read-only root, custom seccomp; every request through an egress proxy that pins validated addresses; WebRTC and WebTransport proven not to leave the host; per-workspace fairness, time budget, credits reserved before launch; screenshots of secret-using runs restricted to managers | #52, browser-checks workflow |
| Webhook responses | Header allow-list, text bodies only, XML/CSV as attachments with sandbox CSP, privacy headers non-overridable, delay never refuses capture | #47 |
| On-call | Override limits and a single-sweep engine (paging cost under a millisecond), calendar links session-only and `no-store`, no member emails to API keys or agents | #48 |
| Session workspace | Deterministic active workspace (previously a request could switch workspace) | #53 |

**Open security findings: none critical, high or medium.** Low-severity follow-ups in ledger rows 26–29. Separately (not a product security issue), the upgrade/DR qualification harness can truncate its backup file — ledger row 32, fix in draft #58; no third-party penetration
test; GitHub Actions pinned by tag; reverse-proxy logs must redact bearer tokens in URLs (documented); OAuth dynamic
client registration is unauthenticated (pre-existing; clients get nothing without user consent).

## 7. Platform coverage

| Platform | Status |
|---|---|
| Linux x86-64 | Qualified on every PR: PostgreSQL 17 and 18.6 (Alpine, as shipped) |
| macOS 15 ARM64 (GitHub-hosted) | Qualified on every PR at the candidate revision |
| Docker / Docker Compose | Qualified on every PR, including the optional browser-runner stack |
| Browsers | Chromium, Firefox, WebKit (Playwright's Linux build), Pixel 7 and iPhone 14 emulation, light and dark themes |
| Native Safari on physical Apple hardware | **Blocked:** needs the owner to enable Safari "Allow remote automation" (system authorization); investigated in draft #45 by the Mac assistant |
| Windows | **Not supported as a native server platform.** Docker Desktop (WSL 2) runs the same Linux image but was not tested: Docker/WSL was unavailable on the development machine |

## 8. Known limitations for a self-hosted release

1. TLS certificate monitors, ping, custom domains and browser checks need the Node/Docker server; the Cloudflare
   Workers build refuses them with 400. Browser checks also need the optional browser-runner stack.
2. Members-only status pages are not served on custom domains; share links point at the main address.
3. SSO: no SAML, no SCIM deprovisioning, no userinfo fallback, one connection per workspace.
4. External email deliverability, live APNs push and live payments are not qualified; billing is off.
5. Low-severity follow-ups in ledger rows 26–29.

## 9. Install and operations documentation

- `/docs/self-host` (served by every instance, en + zh): install, environment, reverse proxy and TLS, custom domains,
  ping in Docker, browser-runner stack and sizing, SSO configuration, on-call, PostgreSQL version policy, upgrade and
  rollback, APNs, GitHub sign-in.
- `/docs/backup`, `/docs/api` (incl. audit log, on-call, SSO, webhook responses, Terraform), `/docs/mcp`.
- `terraform-provider-montral/README.md` for building the provider from source.
- Reproducible qualification scripts: `scripts/qualify-docker.sh`, `qualify-upgrade.mjs`, `qualify-load.mjs`,
  `qualify-failover.mjs`, `qualify-crash-recovery.mjs`, `qualify-backup.mjs`.
- Per-change evidence in `docs/evidence/`.

## 10. External approvals needed for a public launch

1. `GREEN LIGHT MONTRAL` before any tag, image, package, provider publication or deployment.
2. Hosting account, domain and TLS for a hosted service (paid infrastructure needs approval).
3. Email provider, APNs credentials and a live payment provider account, if those features are offered; an SMS/voice
   provider if wanted.
4. Commercial terms, privacy policy and legal review of the bundled `/terms` and `/privacy`.
5. Safari remote-automation authorization on the physical Mac for native Safari qualification.
6. Optional: a third-party penetration test.

## 11. Open pull requests not from this programme

Open drafts from the parallel assistant: #45 (physical Mac/Safari evidence — keep), #46 (on-call resolver, superseded by
#48 — recommend closing), #58 (fixes the upgrade-harness backup truncation; its one failing check is the cross-browser
job's Playwright install step, unrelated to the change — needs its own review and green CI before merge). #51 and #57
were closed when #54 merged. This programme did not push to or close any of them.
