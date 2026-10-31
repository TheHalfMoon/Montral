# Montral outbound-provider diagnostics privacy qualification — 2026-10-31

## Scope

Private Montral repository; authorized Mac only; Node v24.22.1, pnpm 10.0.0, local disposable PostgreSQL 17.9 and synthetic-only recipients. No customer data, public release, paid models, real checkout, external email, or hosted deployment.

## Exposure path and code changes

A failed outbound mail provider can echo recipient addresses, reset or unsubscribe credentials, request URLs, response bodies, or configuration details in its exception text. Before this change, several paths passed those raw exceptions to the application logs, and alert retries could store exception messages in the persisted delivery ledger. A custom-header rejection from the Cloudflare email binding could also print a provider error containing a bearer unsubscribe URL.

- `alerts.ts`: provider exceptions are now mapped to **bounded, allowlisted diagnostic categories** before writing retry/notification history. Routing-policy failures retain their operational marker, HTTP errors retain only their numeric status, and unrecognized failures become `notification delivery failed`. Generic log entries no longer include channel names, email addresses or raw exception bodies on the changed paths. Subscriber failures are likewise counted without persisting raw provider errors or recipients in diagnostic strings.
- `email.ts`: custom-header fallback still operates when the binding explicitly rejects headers, but no longer prints the binding's exception text. A synthetic test proves a token-bearing error is omitted from warning logs.
- `reports.ts`: ambiguous SMTP-provider exceptions remain nonretryable, but are logged as a static generic delivery failure rather than the full exception string.
- No changes to delivery authorization, SMTP transport, retry count/timing, critical alert quota fallback, user-facing messages sent on success, billing, or subscription tokens.

## Testing

- New focused synthetic tests inject error messages containing made-up provider/recipient credentials into a failed email alert retry, failed subscriber notification, and rejected List-Unsubscribe custom headers; verify they do not reach persisted ledger entries or logs. Updated monthly-report regression asserts provider exception content stays out of logs.
- Focused unit suite: **53/53 PASS**. A pre-existing routing-policy test was adjusted to verify safe generic logging instead of inspecting a raw provider exception. Final complete fresh PostgreSQL suite: **86/86 db-pg**, **589/589 API**, **20/20 probe**, **122/122 web**; **817/817 passed**. Exact Node **v24.22.1 / pnpm 10.0.0**. `pnpm -r typecheck` PASS; Node API, self-hosted Node web and edge probe builds PASS; real Node+PostgreSQL HTTP smoke PASS; all **638** third-party pinned source files verified unchanged. All test DBs are disposable.

## Limitations

- Deliberate diagnostic information loss: unknown exceptions no longer appear in ordinary alert logs, which may require secure, nonsecret server-side telemetry to diagnose external provider behavior. HTTP status is still available.
- This is **application-level logging and database-ledger hardening**, not an audit of reverse proxies, load balancers, CDN access logs, third-party provider logs, retained payload encryption, or database admin access. Neither hosted CI nor real provider deliverability is qualified. Repo remains PRIVATE and unlaunched.
