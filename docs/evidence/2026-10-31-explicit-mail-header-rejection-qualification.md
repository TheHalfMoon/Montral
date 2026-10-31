# Montral Cloudflare email-binding duplicate-send safety — 2026-10-31

## Scope

Mac-only, private Montral project; supported Node v24.22.1 and pnpm 10.0.0, disposable local PostgreSQL 17.9. All tests use synthetic addresses and in-process fake mail providers. No externally delivered message, paid infrastructure, real payments or public deployment.

## Bug

`apps/api/src/email.ts` attempted one compatibility fallback, sending a second copy *without* custom List-Unsubscribe headers when a Cloudflare Email binding raised an exception containing the substring `header`, including an unrelated I/O timeout or a generic error code. An upstream error can be ambiguous after a provider has accepted an email; such a fallback may cause two actual deliveries.

## Change

- Preserve the existing one-time compatibility fallback when the provider **explicitly identifies schema/header rejection** with a recognized code (`E_HEADER_NOT_ALLOWED`, `INVALID_HEADERS`, `UNSUPPORTED_HEADERS`, `ERR_UNSUPPORTED_HEADERS`) or an anchored rejection message such as `unknown field headers`, `unsupported custom headers`, `header not supported`, or `invalid headers`.
- Refuse to replay ambiguous failures mentioning headers elsewhere in the error text (`timeout waiting for header response after upstream acceptance`, connection reset after header write, etc.), and do not treat arbitrary error codes merely containing `HEADER` as header rejections.
- Log only the already sanitized static diagnostic for actual fallback attempts, never the provider exception, email recipient, or bearer unsubscribe URL. Non-header failures continue propagating to callers so existing delivery ledgers and retry policies remain in charge.
- This is a **one-attempt-versus-two-attempt safety gate**, not exactly-once delivery and not a test of a real Cloudflare account. A true schema rejection can still be ambiguous if a provider mislabels it; safe default is not to retry unknown errors.

## Tests

- Focused binding tests passed, including four ambiguous provider errors whose messages mention headers, a generic error code containing HEADER, three explicit schema-rejection message variants, and the earlier known rejection-code and token-leakage coverage.
- Full regression on supported **Node v24.22.1 / pnpm 10.0.0** and a new disposable PostgreSQL 17 database: **86/86 db-pg**, **597/597 API**, **20/20 probe**, **122/122 web** — **825/825 passed**. `pnpm -r typecheck` PASS; production Node API, Node web SSR and edge probe builds PASS; real Node+PostgreSQL HTTP smoke PASS; **638/638** pinned third-party files unchanged. Test database automatically dropped.

## Outstanding production gates

GitHub-hosted Actions is enabled, requests `ubuntu-latest`, and the last available job failed before runner assignment (empty runner name and zero executed steps). This task does not cure account-level runner-provisioning failures. Live Cloudflare delivery, external SMTP, hosted DNS/egress, PostgreSQL PITR, real Lemon Squeezy merchant sandbox, legal/privacy/security and publication approval remain open. Keep Montral PRIVATE; do not deploy or enable paid services.
