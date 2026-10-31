# Montral — email fallback privacy and unsent-alert integrity qualification

**Date:** 2026-10-31. **Repository:** PRIVATE `TheHalfMoon/Montral`. **Baseline:** `16746ce1c851fbf765c66d3cfb16e315c35a51ef`. Mac-only, isolated PostgreSQL, synthetic test accounts.

## Security / reliability defect

With neither SMTP nor Cloudflare Email binding configured, Montral's shared `sendEmail` previously wrote **the full recipient address, subject and plaintext body** to the application log and returned successfully. Account verification and password reset bodies can contain bearer links/tokens. This caused two distinct problems:

1. Log viewers and aggregators could inadvertently receive a credential-bearing email body (verification, password reset, invitations, subscriber unsubscribe tokens).
2. Production alert delivery, maintenance subscriber mail and monthly reports could be marked as sent even though **no email transport exists**.

## Changes

- `apps/api/src/email.ts`: when no provider is configured, prints only a fixed generic warning, **never the recipient, subject, HTML, text, URL or token**. Normal local signup-preview behavior remains nonblocking when no provider is configured, but the actual verification email is not delivered and the account is not thereby verified.
- Callers that require real outbound delivery must explicitly request the strict mode in `sendEmail(msg, true)`. Without SMTP/Email binding, it throws a **constant, non-sensitive error**, so channel test sends return an error and alert delivery ledger entries are not falsely recorded as sent. This applies to channel alerts, status-page subscribers, subscriber maintenance email, monthly reports and status-page confirmation notices. Provider-configured SMTP/Cloudflare binding behavior is unchanged.
- No provider connection, credentials or external email delivery was added.

## Dedicated regression tests

- `apps/api/src/email-binding.test.ts`: asserts that no body, password-reset/verification token, subject or email address appears in console output with a missing provider; strict sends reject with a safe error; configured mail transport still succeeds.
- `apps/api/src/unconfigured-mail.e2e.test.ts`: creates an actual synthetic account and email channel against **real local PostgreSQL**, attempts a test notification without SMTP, and verifies **HTTP 502 and `alert_delivery.status=failed`**, never `sent`. The tests also check that no verification bearer token or recipient appears in fallback logs.
- Focused email binding / PostgreSQL / automatic-incident checks **10/10 passing** across three suites.

## Qualification and release limits

The complete qualification **passed**:

- API **568/568 tests** in 77 files, Web **122/122** in 25 files, Probe **20/20** in 4 files. **710 total passing tests**, no skipped tests in the final respective suites.
- All package TypeScript and Astro typechecks passed (0 diagnostics); Node API, Node web and optional Cloudflare Edge Probe builds passed.
- Real built Node + PostgreSQL smoke passed (health, configuration, MCP discovery, HTML dashboard).
- Real Chromium signup, synthetic heartbeat monitor management, manual incident lifecycle, webhook capture and disabled billing passed, now additionally asserting that the signup **does not leak recipient address or verification token into the Node process log**.
- Real production Nodemailer/SMTP-to-loopback-sink integration passed, including automatic heartbeat failure and recovery emails, without external delivery.
- Disposable `pg_dump`/`pg_restore` passed: **42 tables, 111 synthetic organizations and 5 transactional Montral SQL functions** restored.
- Verified SHA256 integrity of **638 files** across the three pinned donor snapshots.
- Synthetic PostgreSQL 17 at **127.0.0.1:55454** was used; the owner's existing PostgreSQL on port 5432 was untouched.

This is a **local security hardening**, not production email onboarding. A tenant with no SMTP/email provider cannot actually receive account verification/password reset, alerts, or subscriber mail. That remains an explicit **production no-go** until configured and externally verified. The previous [local SMTP protocol drill](2026-10-31-local-smtp-cron-qualification.md) remains valid only for a synthetic loopback server. GitHub Actions runs have been failing before runner allocation with **zero steps**; the Mac Node v26.0.0 remains below Montral's declared supported Node 26 minimum.

The repository must remain PRIVATE. Do not deploy, publish, send live email or activate real payments.
