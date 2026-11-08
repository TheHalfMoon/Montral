# Montral feature and competitor gap matrix

Maintained during development. Competitor facts were gathered on 2026-11-08 from
primary sources (official docs, pricing pages, GitHub READMEs); see the source list
at the end. **Y** yes, **N** no, **P** partial, **$** paid tier/add-on only,
**?** not verified. Montral's column reflects `main` plus the open pull requests
noted in brackets, verified against the code, not marketing copy.

## Matrix

| Capability | Montral | Uptime Kuma | Better Stack | OpenStatus | UptimeRobot | Gatus | webhook.site |
|---|---|---|---|---|---|---|---|
| HTTP(S) | Y | Y | Y | Y | Y | Y | N |
| Keyword assertion | Y (contains/absent) | Y | Y | Y | Y | Y | N |
| JSON body assertion | N | Y | Y | P | Y | Y | N |
| TCP | Y | Y | Y | Y | Y | Y | N |
| Ping / ICMP | N | Y | Y | ? | Y | Y | N |
| DNS | Y | Y | Y | Y | Y | Y | P |
| TLS certificate expiry | P (branch ready; Node only) | P | Y | ? | Y | Y | N |
| Domain expiry | Y | ? | Y | ? | Y | Y | N |
| Heartbeat / cron | Y | Y | Y | ? | Y | Y | N |
| WebSocket | Y | Y | ? | ? | ? | Y | N |
| Database (Postgres/MySQL/Redis) | Y | Y | N | N | N | N | N |
| Browser / multi-step | N | N | $ | N | N | P | N |
| Multi-region | Y (edge probes) | N | ? | Y | Y | P | n/a |
| Alert channels | 10 (email, Slack, Telegram, Lark, Discord, Teams, ntfy, webhook, PagerDuty, push) | 90+ | several | several | 21 | 43 | P |
| SMS / voice | N | via providers | Y | ? | Y | via providers | N |
| Manual incidents + timeline | Y | N | Y | Y | P | P | n/a |
| Acknowledge | Y | N | Y | ? | ? | N | n/a |
| Reminders / escalation | Y | N | Y | ? | N | N | n/a |
| On-call schedules | N | N | Y | ? | N | N | n/a |
| Postmortems | Y | N | Y | ? | P | N | n/a |
| Public status page | Y | Y | Y | Y | Y | Y | n/a |
| Members-only page | Y (#18) | N | $ (SSO) | $ | ? | P | n/a |
| Password page | Y (#21, in CI) | N | $ | Y | $ | P | n/a |
| Expiring share links | Y (#21, in CI) | N | ? | ? | ? | N | n/a |
| Custom domain | N (column only) | Y | Y | Y | $ | self-host | $ |
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
| Audit log | N | N | $ | ? | ? | N | N |
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
| Private status pages | `status-visibility.e2e.test.ts` (PR #18), `status-password-links.e2e.test.ts` (PR #21) |

## Prioritised gaps

Ranked by user value, reliability and security, then cost. Items marked done are
merged; "next" items are the planned order.

1. **TLS certificate expiry**: implemented on a branch, pending PR after #21.
2. **JSON body assertions** (JSONPath-style): expected baseline; low cost. Next.
3. **More alert channels** (Google Chat, Mattermost, Pushover, Gotify): low cost,
   high switching value from Kuma/Gatus users.
4. **Custom domains for status pages**: the column exists but nothing routes it.
5. **Ping / ICMP**: needs raw sockets or the system `ping`; not possible on
   Workers. Evaluate for Node only.
6. **Terraform provider / config-as-code**: valued by GitOps teams; large.
7. **On-call schedules**: large; escalation already exists.
8. **SSO (OIDC/SAML), audit log**: enterprise tier; large.
9. **SMS / voice**: requires a paid provider; out of scope without approval.
10. **Browser / multi-step checks**: large; needs a headless browser runtime.

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
