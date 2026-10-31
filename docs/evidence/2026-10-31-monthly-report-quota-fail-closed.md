# Montral optional monthly report quota failure isolation — 2026-10-31

## Scope and reason

Authorized Mac, private Montral source, no deployment, actual Node v24.22.1 / pnpm 10.0.0, and only synthetic `example.test` recipients. This wave hardens the *nonurgent monthly digest* path. The earlier `sendMonthlyReports` caught failures from `entitlements.spendEmails` by granting every owner, which could bypass an active email quota while the metering backend was unavailable.

## Fix

- `apps/api/src/reports.ts` now **fails closed for optional monthly reports** when quota authorization throws; it sends nothing from the affected workspace and emits a generic diagnostic without dumping exception strings, recipients or tenant context.
- Noninteger, negative, nonfinite, or larger-than-requested grants also fail closed. A valid partial grant still sends only to the first authorized number of recipients.
- **Critical outage and recovery alerts are unchanged.** Their existing quota-failure behavior is deliberately different because suppressing an outage notification due to a metering outage is an availability concern. Self-hosted `unmetered` mode remains operational.
- Monthly report claims occur before delivery. Consequently, if a metering outage causes a digest to be omitted, the current claim mechanism does not automatically retry that digest later. This behavior existed previously for other send failures; reliable requeue and operator visibility remain release work.

## Regression

- `reports.test.ts`: ten new synthetic unit assertions including quota error with secret-bearing exception, malformed grants (`NaN`, `Infinity`, `-1`, `1.5`, excess), partial grant, local self-hosted `unmetered` default out-of-window refusal, and isolation between an unavailable workspace and a healthy workspace. No external mail was sent.
- Verified on **Node v24.22.1 / pnpm 10.0.0**: API **584/584**, Probe **20/20**, Web **122/122** (Web rerun after production Node build to include its built-route test), **726/726 tests passed**. `pnpm -r typecheck`, Node API/SSR web/Edge probe builds, real Node+PostgreSQL HTTP smoke and **638/638** original donor hashes passed. The API suite was rerun again after the tenth test was added, using a fresh, disposable PostgreSQL database that was deleted afterwards.

## Release limitations

Local tests do not fix GitHub Actions runner provisioning, hosted SMTP deliverability, managed database resilience, genuine merchant callbacks, Cloudflare live regions, real bot-abuse testing or legal/privacy readiness. Do not release, deploy or enable paid billing.
