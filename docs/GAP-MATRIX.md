# Montral feature and competitor gap matrix

Maintained during development. Competitor facts were gathered on 2026-11-08 from
primary sources (official docs, pricing pages, GitHub READMEs); see the source list
at the end. **Y** yes, **N** no, **P** partial, **$** paid tier/add-on only,
**?** not verified. Montral's column reflects `main` at `8fedf26` (2026-11-09), with the
merging pull request in brackets, verified against the code, not marketing copy.

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
| Browser / multi-step | N | N | $ | N | N | P | N |
| Multi-region | Y (edge probes) | N | ? | Y | Y | P | n/a |
| Alert channels | 14, 4 added in #28 (email, Slack, Telegram, Lark, Discord, Teams, Google Chat, Mattermost, ntfy, Gotify, Pushover, webhook, PagerDuty, push) | 90+ | several | several | 21 | 43 | P |
| SMS / voice | N | via providers | Y | ? | Y | via providers | N |
| Manual incidents + timeline | Y | N | Y | Y | P | P | n/a |
| Acknowledge | Y | N | Y | ? | ? | N | n/a |
| Reminders / escalation | Y | N | Y | ? | N | N | n/a |
| On-call schedules | N | N | Y | ? | N | N | n/a |
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
| Custom webhook responses | N | N | N | N | N | N | $ |
| REST API | Y | P | Y | Y | Y | P | Y |
| MCP server | Y (OAuth) | N | Y | Y | Y | N | ? |
| Terraform / config-as-code | N | N | Y | Y | ? | Y (YAML) | N |
| Self-hosting | Y (Docker/Node + Postgres; also Workers) | Y (MIT) | N | Y (AGPL) | N | Y (Apache) | P |
| 2FA | Y | Y | ? | ? | Y | n/a | ? |
| SSO (OIDC/SAML) | P (GitHub sign-in) | N | $ | ? | $ | Y | ? |
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

## Prioritised gaps

Ranked by user value, reliability and security, then cost.

Done since the matrix was first written: TLS certificate expiry (#26), JSON body
assertions (#27), Google Chat / Mattermost / Gotify / Pushover (#28), custom domains
(#29) with periodic re-verification (#33), ICMP ping (#38), workspace audit log (#39).

Remaining, in planned order (see `docs/TASK-LEDGER.md`):

1. **On-call schedules** (rotations, overrides): escalation policies already exist; large.
2. **SSO (OIDC; SAML if justified)**: GitHub sign-in only today; large.
3. **Terraform provider / config-as-code**: REST API and Uptime Kuma import exist; large.
4. **Browser / multi-step checks**: needs an isolated headless runtime; large.
5. **Custom webhook responses** (webhook.site parity): medium.
6. **SMS / voice**: requires a paid provider; out of scope without owner approval.

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
