# Montral subscriber quota validation and GitHub Actions billing root cause — 2026-10-31

## Context

Private repository `TheHalfMoon/Montral`; owner-authorized Mac only, synthetic email recipients and locally mocked email delivery. No real billing, external mail or publication.

## Defect and guard

The shared `withinEmails` helper used the raw numeric return from `entitlements.spendEmails` for array slicing and calculating skipped recipients. A malformed *successful* response like `-1`, `NaN`, `Infinity`, a fractional value, string or overgrant could silently send an unauthorized number of messages or persist invalid counts.

The helper now requires a **safe integer between 0 and the requested count**, inclusive. An invalid returned grant causes a generic error diagnostic, sends no recipients and marks all as skipped. The existing emergency availability rule remains unchanged: if the quota service **throws**, urgent notifications proceed fail-open, with a generic diagnostic. This is a deliberate emergency-availability versus billing-cap tradeoff, and is not a claim of strict quota enforcement during metering outages.

Nine focused synthetic cases cover seven malformed values, valid partial allocation and a metering exception carrying invented secret credentials. Their parent targeted test run passed **67/67 locally** after fixing a missing test import.

**Qualification limit:** Desktop Commander reached its monthly usage cap after the focused tests; its own message said not to retry or reconnect. Source and test changes were then replicated and committed using the connected GitHub app. The exact final remote revision has **not** been rerun through full TypeScript, PostgreSQL, API/web/probe suites or real Mac builds. This gate remains open. The temporary Mac workspace could not be cleaned after the access cap; do not claim it was removed.

## Verified GitHub Actions root cause

[Montral app CI run 41206285444](https://github.com/TheHalfMoon/Montral/actions/runs/41206285444) has a job annotation:

> The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings.

The job requested `ubuntu-latest`, GitHub Actions was enabled, the runner name was empty and zero steps ran. This is **GitHub account payment/spending-limit gating before runner provisioning**, not a failure of the Montral test code. No payment settings were changed or paid services activated.

GitHub account owner should inspect **Settings > Billing & plans** and decide whether or how to address the external blocker. Do not infer which of the two possible account conditions applies without further billing-account evidence. Maintain zero-cost project constraints.

## Production release state

Stay PRIVATE, no deployment or payments. Green hosted CI, final remote-revision test verification, Cloudflare real probe DNS/egress, external SMTP deliverability, managed database disaster recovery/PITR, merchant sandbox callbacks, browser/accessibility/security/privacy/legal reviews and explicit publication authorization remain open.
