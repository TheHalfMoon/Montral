# Initial incident fanout and subscriber isolation — Mac qualification 2026-10-31

## Context and risk

In private `TheHalfMoon/Montral`, initial incident delivery attempts fan out to configured channels before notifying confirmed status-page subscribers. The previous implementation used a rejecting `Promise.all` for per-channel processing, propagated failures from channel-list or queue database access, and allowed disabled-channel audit writes to abort fanout. One transient database failure could therefore suppress or prematurely interrupt independent alert routes, notably status-page subscriber email. A subscriber-delivery summary persistence failure could also make the dispatcher throw after sending email, inviting duplicate outer retries.

## Narrow change

- Failed disabled-channel audit writes are logged using a constant non-secret message and no longer prevent enabled channels from being processed.
- Per-channel `Promise.allSettled` waits for **all configured live channel tasks** and logs only a fixed failure message for an interrupted task. A claimed or unknown-status delivery is **not resent immediately**: it stays pending/sending for the established timed delivery recovery and retry policy, to avoid duplicating provider-accepted alerts.
- `dispatchAlert` catches exceptions in channel listing or fanout/queue setup and still executes independent subscriber notifications. When the queue commit is ambiguous, channel fallback is **not** attempted without a durable record; a high-signal fixed error string warns that channel fanout could not be confirmed. This is availability improvement, not a guarantee of delivery when the channel database is down.
- A subscriber email summary write failure cannot turn accepted subscriber notifications into an exception; only a static diagnostic is logged, not raw provider/DB exceptions or token-bearing URLs.
- Existing routing authorization, email-credit enforcement, provider send timeouts and at-most-once claim semantics remain unchanged. These fixes do not make notification delivery exactly once.

## Tests and reproducible local evidence

Five new synthetic Vitest cases in `apps/api/src/alerts.test.ts`: (1) channel-list query exception leaves subscriber email intact and no leaked DB secret; (2) failing queue commit does not cause unsafe, untracked channel sending, but subscribers still receive email; (3) one channel claim failure does not starve another channel and subscriber, with secret-free logs; (4) disabled-channel audit write failure does not silence active channels; (5) subscriber email acceptance followed by a summary persistence failure does not cause a dispatcher exception or duplicate send. These tests use stubbed network and email sinks only.

- Focused alert/routing suites: **82 passed**, five database-only cases skipped in the focused run; the database cases subsequently ran in the full real-PostgreSQL suite.
- Full local Mac suite with a disposable PostgreSQL 17.9 database and supported **Node 24.22.1 / pnpm 10.0.0**: **643 API + 86 PostgreSQL + 20 Edge Probe + 122 Web = 871/871 passed** on the changed worktree.
- `pnpm -r typecheck` PASS; production Node API, Node web SSR and Cloudflare Edge Probe builds PASS; local Node/PostgreSQL smoke PASS (health, config, MCP discovery and HTML dashboard).
- Real headless Chromium test: `BROWSER_E2E_PASS` for synthetic signup, monitor, incident, webhook, disabled billing, reset-link privacy and anonymous access refusals. Loopback SMTP: `SMTP_LOOPBACK_PASS` for local SMTP verification, channel test, scheduler down/recovery and account recovery link; no external recipients.
- `pg_dump`/`pg_restore` drill: **42 tables**, normalized SHA-256 and per-table counts match, plus five business SQL functions; this drill has **one populated table and zero synthetic organizations**, so cannot qualify production PITR/load/scale. Richer historical local backup drills remain separately documented.
- All **638 pinned donor-source hashes** verify unchanged, independent of Montral application edits.

## Restrictions / remaining production gates

Repository must remain **PRIVATE** and **unreleased**. The GitHub Actions runner is still stopped before allocation by account payment or spending-limit state, so hosted CI has not run the new code. Production Cloudflare DNS/egress and geographic checks, external SMTP, hosted PostgreSQL PITR/failover/load, real merchant sandbox/refund workflows, security/privacy/accessibility/legal review and explicit publication approval remain open. Local synthetic passing tests are not a production release qualification. Do not enable paid infrastructure, handle real payments, or deploy.
