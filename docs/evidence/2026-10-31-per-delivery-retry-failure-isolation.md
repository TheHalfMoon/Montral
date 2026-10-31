# Montral per-delivery retry isolation — 2026-10-31

## Safety and change scope

Private GitHub `TheHalfMoon/Montral`, authorized Mac only. Node v24.22.1, pnpm 10.0.0 and local PostgreSQL 17.9. Zero paid inference/services, no external SMTP, real merchant transactions, production data, publication or deployment.

## Failure mode

`retryDeliveries()` previously claimed a batch of pending alert deliveries, then processed the entries in a single `for` loop without per-item exception isolation. A transient exception from history lookup (`repo.incidentDeliveries` for a reopened incident), a database write (`repo.finishDelivery` for an obsolete alert), or another pre-send lookup could reject the entire function and leave later **already-claimed** alerts unprocessed. The scheduler's outer catch would log the error and move on, but the unprocessed rows could only recover after the DB delivery-lease sweep, increasing notification latency during partial outages.

## Fix

Wrap each claimed retry in its own `try/catch` and continue with remaining claimed entries on failure. A failed item remains in `sending`: the existing timed `sweepStuckDeliveries` mechanism then recovers it after lease expiry, with the established maximum-attempt policy. **Do not immediately resend or rewrite it as a failed attempt** because a notification might have reached the provider before `finishDelivery` failed; blindly resending could duplicate an alert. The catch logs a fixed diagnostic string rather than a potentially secret-bearing PostgreSQL or provider exception. Existing routing authorization, per-event push deduplication, email quota, retry delay and policy windows are unchanged.

Two new synthetic cases prove: (1) when the first stale alert cannot be marked skipped, a later alert in the same claimed batch is sent and no exception string leaks; (2) when a reopened incident history read fails, another due alert is processed and the token-bearing error is not logged. The interrupted first rows are deliberately left for the sweeper and are not immediately retried.

## Qualification completed on Mac

- Targeted alerts/routing test selection: **77 passed, 5 skipped** (the skipped PostgreSQL cases were not enabled in the first focused run); full real-PostgreSQL API suite subsequently executed.
- Full local test suites: **638 API + 86 PostgreSQL + 20 Edge Probe + 122 Web = 866/866 passed** on the changed worktree and a newly created disposable `montral_test_` PostgreSQL database.
- `pnpm -r typecheck` PASS; production API Node, web SSR and Edge Probe bundles PASS; Node + PostgreSQL HTTP health/config/MCP/dashboard smoke PASS.
- `scripts/qualify-browser.mjs` PASS: real offline Chromium signup, synthetic monitor/incident/webhook, disabled billing, reset-link privacy and unauthenticated refusals.
- `scripts/qualify-smtp.mjs` PASS: real Node SMTP connected to a loopback-only synthetic mail sink, scheduler incident open/recovery and account reset link delivery. **No externally delivered email was tested**.
- `scripts/qualify-backup.mjs` PASS: 42 local PostgreSQL tables and five business SQL functions restored, all per-table row counts and SHA-256 normalized content fingerprints matched. This particular quick drill had **one populated table and zero synthetic organizations**; it cannot establish production-scale recovery/PITR. Earlier richer local drill evidence remains separate.
- All **638 hashed source files across three pinned donor snapshots** verified unchanged. `git diff --check` and remote Git SHA/visibility checks must pass before temporary worktree cleanup.

## Remaining release blockers

Hosted GitHub Actions currently rejects jobs before runner assignment with an account payment or spending-limit message. Production Cloudflare DNS/egress and region checks, external deliverability, managed database failover/PITR, authenticated merchant sandbox events, security/privacy/accessibility/legal reviews and explicit owner publication authorization remain open. Local passing suites are **not** equivalent to hosted CI or permission to deploy. Repo must remain private.
