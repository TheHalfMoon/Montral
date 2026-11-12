# Montral feature and competitor gap matrix

Maintained during development. Competitor facts were gathered on 2026-11-08 from
primary sources (official docs, pricing pages, GitHub READMEs); see the source list
at the end. **Y** yes, **N** no, **P** partial, **$** paid tier/add-on only,
**?** not verified. Montral's column reflects `main` at `b01e28e` (2026-11-11), with the
merging pull request in brackets, verified against the code, not marketing copy. The SaaS sections below reflect `main`
at `3fbc6e6` (after #74–#84).

## Matrix

| Capability | Montral | Uptime Kuma | Better Stack | OpenStatus | UptimeRobot | Gatus | webhook.site |
|---|---|---|---|---|---|---|---|
| HTTP(S) | Y | Y | Y | Y | Y | Y | N |
| Keyword assertion | Y (contains/absent) | Y | Y | Y | Y | Y | N |
| JSON body assertion | Y (#27; path + comparison) | Y | Y | P | Y | Y | N |
| TCP | Y | Y | Y | Y | Y | Y | N |
| Ping / ICMP | Y on Node/Docker (#38; system `ping`, runs in the image as `node`); refused on Workers | Y | Y | ? | Y | Y | N |
| DNS | Y | Y | Y | Y | Y | Y | P |
| TLS certificate expiry | Y on Node/Docker (#26); refused on Workers | P | Y | ? | Y | Y | N |
| Domain expiry | Y | ? | Y | ? | Y | Y | N |
| Heartbeat / cron | Y | Y | Y | ? | Y | Y | N |
| WebSocket | Y | Y | ? | ? | ? | Y | N |
| Database (Postgres/MySQL/Redis) | Y | Y | N | N | N | N | N |
| Browser / multi-step | Y on Node/Docker with the browser-runner (#52): declarative journeys (goto, click, fill, press, waitFor, assertText/Url/Status) and a page script step (#66) in isolated headless Chromium in a separate hardened browser-runner service (no app secrets, no database network, signed channel); secrets encrypted, egress policy; refused on Workers | N | $ | N | N | P | N |
| Multi-region | Y (edge probes) | N | ? | Y | Y | P | n/a |
| Alert channels | 14, 4 added in #28 (email, Slack, Telegram, Lark, Discord, Teams, Google Chat, Mattermost, ntfy, Gotify, Pushover, webhook, PagerDuty, push) | 90+ | several | several | 21 | 43 | P |
| SMS / voice | N | via providers | Y | ? | Y | via providers | N |
| Manual incidents + timeline | Y | N | Y | Y | P | P | n/a |
| Acknowledge | Y | N | Y | ? | ? | N | n/a |
| Reminders / escalation | Y (policies with step timeouts and repeats, people and on-call schedules as targets: #48) | N | Y | ? | N | N | n/a |
| On-call schedules | Y (#48; layered rotations in an IANA zone, restriction windows, overrides, iCal feed) | N | Y | ? | N | N | n/a |
| Postmortems | Y | N | Y | ? | P | N | n/a |
| Public status page | Y | Y | Y | Y | Y | Y | n/a |
| Members-only page | Y (#18) | N | $ (SSO) | $ | ? | P | n/a |
| Password page | Y (#21) | N | $ | Y | $ | P | n/a |
| Expiring share links | Y (#21; revocable) | N | ? | ? | ? | N | n/a |
| Custom domain | Y on Node/Docker (#29; TXT-verified, DNS takeover, periodic re-verification #33); not on Workers | Y | Y | Y | $ | self-host | $ |
| Subscribers | Y (email) | N | Y | Y | Y | N | n/a |
| Maintenance windows | Y (recurring) | Y | Y | Y | Y | Y | n/a |
| Badges / embed | Y | Y | ? | ? | ? | Y | n/a |
| RSS / ICS / llms.txt feeds | Y | N | ? | Y | ? | N | n/a |
| Webhook inspection | Y | N | N | N | N | N | Y |
| Webhook search / paging | Y (#13) | N | N | N | N | N | Y |
| Webhook replay / forward | Y (#17, SSRF-guarded) | N | N | N | N | N | Y |
| Custom webhook responses | Y (status, headers, text body, delay, per method; #47) | N | N | N | N | N | $ |
| REST API | Y | P | Y | Y | Y | P | Y |
| MCP server | Y (OAuth) | N | Y | Y | Y | N | ? |
| Terraform / config-as-code | Y, unpublished: build from source (`terraform-provider-montral/`) | N | Y | Y | ? | Y (YAML) | N |
| Self-hosting | Y (Docker/Node + Postgres; also Workers) | Y (MIT) | N | Y (AGPL) | N | Y (Apache) | P |
| 2FA | Y | Y | ? | ? | Y | n/a | ? |
| SSO (OIDC/SAML) | P (#49, #63, #67: OIDC per workspace + instance-wide, JIT, require-SSO incl. API keys/agents, userinfo fallback, SCIM 2.0 users; no SAML, no SCIM groups) | N | $ | ? | $ | Y | ? |
| Roles | P (owner/admin/member) | N | Y | ? | Y | N | $ |
| Audit log | Y (#39; append-only, API/CSV/JSONL export, MCP, retention) | N | $ | ? | ? | N | N |
| Mobile app | P (iOS push app) | N | Y | ? | Y | N | N |

## Reliability and security qualification (Montral)

| Area | Evidence |
|---|---|
| Graceful SIGTERM drain | `qualify-browser.mjs` NODE_SIGTERM_PASS (PRs #9-#11) |
| SIGKILL, DB outage, two workers | `qualify-crash-recovery.mjs` CRASH_RECOVERY_PASS (PR #16) |
| Network partition, primary promotion | `qualify-failover.mjs` FAILOVER_PASS on real primary + synchronous replica (PR #23) |
| CSRF on cookie writes | `session-origin.e2e.test.ts` (PR #14) |
| Clickjacking, security headers | `web-security-headers.test.ts` (PR #15) |
| Script CSP, app and landing pages | `verify-csp-hashes.mjs`, `landing-csp.mjs --check`, Chromium CSP_PASS (PRs #19, #22) |
| Webhook replay SSRF | `montral-hooks.e2e.test.ts`, three review rounds (PR #17) |
| Private status pages | `status-visibility.e2e.test.ts` (PR #18), `status-password-links.e2e.test.ts` and Chromium STATUS_PASSWORD_PASS (PR #21) |
| Custom-domain isolation | `custom-domain*.test.ts`, real-server CUSTOM_DOMAIN_SMOKE_PASS (PR #29) |
| TLS monitor, JSON assertions, channels | `certificate.test.ts`, `json-assertion*.test.ts`, `more-channels.test.ts` (PRs #26-#28) |
| ICMP ping monitor | `ping.test.ts` (incl. a real ping of 127.0.0.1), `ping-resolve.test.ts`, `ping.e2e.test.ts` (#38) |
| Custom-domain re-verification | `custom-domain-recheck.e2e.test.ts`: 24 h / 7 d boundaries, races, concurrent servers (#33) |
| Billing checkout deadlock | `montral-billing-lock-order.e2e.test.ts`, RED on unfixed main (closed #34), fixed (#35) |
| PostgreSQL 17 and 18, macOS ARM64 | CI matrix incl. the exact compose image, failover on both (#31); macOS 15 ARM64 full suite (#32) |
| Docker image and compose | `qualify-docker.sh` DOCKER_COMPOSE_PASS: health, persistence, recreation, ping as `node`, PostgreSQL 17 refuses the 18 volume (#37) |
| Load, backpressure, pool exhaustion | `qualify-load.mjs` LOAD_QUALIFICATION_PASS: 4,000 monitors, no lost or duplicated checks (#40) |
| Manual check abuse | per-workspace and per-process bounds, `manual-check-limit.e2e.test.ts` (#41) |
| Audit log integrity | `audit.e2e.test.ts`: tenant isolation, secret redaction, append-only trigger incl. temp-table bypass (#39) |
| Custom webhook responses | `montral-hook-response*.test.ts`: header injection, deny-list, text-only types, delay and concurrency bounds, manager-only, replay unaffected, no-op migration lock-free (#47, in review) |
| Scheduler claim margin | `repo.test.ts`: a late claim never leaves the monitor due again within the tick (#74) |
| Operator plane and suspension | `operator.e2e.test.ts`: keys/agents/no second factor/cross-origin refused; suspension blocks API, claims, webhooks, heartbeats, public pages; unsuspend restores (#76) |
| Fail-closed metering | `plan-catalog.test.ts`, `entitlements.test.ts`, `montral-metering.e2e.test.ts`: invalid catalog or ledger error refuses metered work; 8 concurrent captures against a limit of 3 store exactly 3 (#75, #81) |
| Billing lifecycle (sandbox) | `montral-billing.e2e.test.ts`: upgrade/downgrade, grace, recovered, refund, expired, reconciliation, stale and duplicate events; rolling-upgrade function compatibility (#77) |
| Multi-region confirmation, probe drain | `regions-confirm.test.ts`, `probe-regions.e2e.test.ts` incl. operator write-route negative tests with rows compared before and after (#82) |
| BYOC no-egress | `qualify-byoc.sh` `BYOC_PASS` on an internal Docker network, connection recorder in the server process only (not covered: child processes such as `/bin/ping`, the separate browser-runner container, the end user's browser), with canary (#79) |
| Replica restart coverage | `qualify-replicas.sh`: each restart window needs a successful read and webhook POST; negative control (#80) |
| Layout-shift-free clicks | `clickWithoutLayoutShift` in the journey and `cloud-usage.spec.ts` (#84, #83) |

## SaaS delivery models (Montral) at `3fbc6e6`

Community is self-hosted, free and unmetered; Montral Cloud is the multi-tenant SaaS with metering and billing
(sandbox only); Enterprise BYOC runs the reference overlay in the customer's infrastructure. Release decisions per model
are in `docs/RELEASE-GATES.md` §S. Commercial terms live in private operator configuration and are not part of the
repository.

| Capability | Community | Cloud | BYOC | Evidence / gap |
|---|---|---|---|---|
| Operator control plane (API) | Off by default | Y (API only) | Off (pinned empty) | #76, #82; no UI, no platform audit trail (ledger 63) |
| Workspace suspension | n/a | Y (server-side) | n/a | #76; SCIM/Better Auth org endpoints not gated (ledger 60) |
| Plan catalog (operator-supplied) | n/a (unmetered) | Y | n/a | #75, `docs/PLAN-CATALOG.md` (synthetic examples) |
| Metering: check credits, emails | n/a | Y, fail closed | n/a | #75 |
| Metering: webhook events, browser seconds | n/a | Y, fail closed | n/a | #81; replay and inbox count not metered (ledger 56) |
| Per-plan status-page counts and feature gates | n/a | N (only `hideBranding`) | n/a | ledger 57 |
| Plan interval below 60 s | n/a | N (API floor 60 s) | n/a | ledger 58 |
| Billing lifecycle | n/a (off) | P (sandbox only; no live provider) | n/a | #77; provider behaviour unverified, no reconciliation job (ledger 64); `past_due_since` backfill (ledger 61) |
| Multi-region confirmation and plan region cap | n/a (one region) | P (simulated probes) | n/a | #82; no deployed probes; credits for drained/unreachable regions (ledger 55); drain audit (ledger 54); digest gap (ledger 53) |
| Onboarding checklist | Y | Y | Y | #83 |
| Usage banner, meters, quota messages, suspended notice | n/a | Y (states mocked in e2e) | n/a | #83; late first-load banners (ledger 59) |
| No-egress reference deployment | n/a | n/a | Y (reference) | #79; server process only; browser-side external font requests removed in #90 (ledger 73, CI pending); child processes and the browser-runner container not covered |
| Production hosting, email provider, payment provider, legal terms, external pen test | n/a | N | N (pen test, legal) | external blockers, `docs/RELEASE-GATES.md` §S.4 |

## Prioritised gaps

Ranked by user value, reliability and security, then cost.

Done since the matrix was first written: TLS certificate expiry (#26), JSON body
assertions (#27), Google Chat / Mattermost / Gotify / Pushover (#28), custom domains
(#29) with periodic re-verification (#33), ICMP ping (#38), workspace audit log (#39), on-call
schedules with escalation policies (#48).

Remaining, in planned order (see `docs/TASK-LEDGER.md`):

1. ~~**SSO (OIDC; SAML if justified)**~~: OIDC done in #49; SAML deferred (XML-signature risk, no safe library on both runtimes; bridge through Keycloak/Authentik).
2. **Terraform provider / config-as-code**: implemented in `terraform-provider-montral/` (#50; unpublished, build from source).
3. **Browser / multi-step checks**: declarative journeys in #52 (merged; `docs/evidence/2026-11-10-browser-checks.md`). A page script step was added in #66 (owners and admins, in the page of the isolated runner, never with secrets). Still missing against Checkly-style products: full Playwright test scripts running outside the page.
4. **Custom webhook responses** (webhook.site parity): implemented in #47 (`docs/evidence/2026-11-10-webhook-responses.md`).
5. **SMS / voice**: requires a paid provider; out of scope without owner approval.
6. **SaaS follow-ups** (ledger rows 53–73): unchecked digest for non-browser monitors, drain audit, per-region credit
   refunds, metering of webhook replay and inbox count, per-plan status-page and feature gates, sub-60 s plan intervals,
   first-load banners, SCIM/SSO during suspension, `past_due_since` backfill, operator UI, live
   billing provider verification, probe registration and credentials.

Grafana OnCall and other incident-response tools named in the brief are not yet in
the table: their entries need the same primary-source verification before they are added.

## Sources

- Uptime Kuma: https://github.com/louislam/uptime-kuma ,
  https://github.com/louislam/uptime-kuma/wiki/Badge ,
  https://github.com/louislam/uptime-kuma/wiki/Maintenance
- Better Stack: https://betterstack.com/pricing ,
  https://betterstack.com/docs/uptime/monitor-types/ ,
  https://betterstack.com/docs/uptime/getting-started-with-oncall-v2/ ,
  https://betterstack.com/docs/getting-started/integrations/mcp/
- OpenStatus: https://github.com/openstatusHQ/openstatus ,
  https://www.openstatus.dev/docs/reference/status-page ,
  https://www.openstatus.dev/docs/reference/terraform
- UptimeRobot: https://uptimerobot.com/pricing/ ,
  https://uptimerobot.com/integrations/ ,
  https://help.uptimerobot.com/en/articles/11361463-password-protected-status-pages
- Gatus: https://github.com/TwiN/gatus
- webhook.site: https://docs.webhook.site/
