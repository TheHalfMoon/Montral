# Montral local SMTP account recovery qualification — 2026-10-31

## Engineering scope

Private repository, Mac only, Node v24.22.1 with pnpm 10.0.0, PostgreSQL 17 on loopback and a deliberately constrained local SMTP sink. No hosted provider, DNS, customer account, public release, paid plan, or payment transaction was used.

## Added automated coverage

- `scripts/qualify-smtp.mjs` now requests password recovery from the actual built Node API after a synthetic registered account and real local SMTP verification/channel/incident delivery. The test verifies that exactly one password reset email reaches that synthetic address via the same production Nodemailer transport. It does not read, display, log or publish bearer links. The SMTP server accepts only `@example.test` recipients and listens on localhost.
- The real PostgreSQL `password-reset-mail.e2e.test.ts` now additionally requires that a used reset link cannot be reused, an old password cannot authenticate, the new password can authenticate, and the password-change notification is sent exactly once. A request to reset an unknown address must return a generic 200 response without creating mail. The existing assertions already cover session revocation and absence of reset credentials in the security notice.

## Verification

- Targeted PostgreSQL-backed password reset test PASS on supported Node. Local SMTP loopback qualification PASS: verified handshake, channel test delivery, cron-created down and recovery alert, one resolved incident, and exactly one recovery-link email to the synthetic account.
- The fresh disposable PostgreSQL run completed **574/574 API**, **20/20 probe**, and **122/122 web** tests (716 total), all passing. `pnpm -r typecheck` passed. The immutable donor manifest verified **638/638 files**.
- Both the production Node API build and Node SSR web build passed on the same supported runtime; the live synthetic SMTP qualification returned `SMTP_LOOPBACK_PASS`. A separate focused reset-password integration test also passed.

## Boundaries

The SMTP test verifies real transport delivery of a recovery message; the independent API integration test verifies redemption behavior and session invalidation. The SMTP test does not redeem a token from the delivered email, and neither test certifies external deliverability, host access-log redaction, genuine end-user inboxes, regional routing, or rate limits against a production service.

GitHub-hosted CI remains blocked before any runner is provisioned. Local PASS is not a release approval. Do not deploy or activate real billing.
