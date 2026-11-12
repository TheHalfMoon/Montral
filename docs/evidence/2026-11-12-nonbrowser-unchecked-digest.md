# Unchecked monitor digests for non-browser plan deferrals (2026-11-12)

## Problem
The scheduler's `notePlanDeferral` can mark a multi-region HTTP/TCP/etc. monitor unchecked after repeated attempts to read an unavailable workspace plan. The PostgreSQL `pendingUncheckedDigests` query selected `type = 'browser'` only. The unchecked flag was visible to users but the owners/admins received no notification about these non-browser monitors.

## Change
- Query every unpaused, unchecked, not-yet-notified monitor in an active workspace, with type and a fixed non-browser deferral reason. Browser monitors keep their existing recorded browser-runtime reason.
- Continue sending one grouped digest per workspace, within the existing e-mail allowance and shared `browser-unchecked-digest:<workspace>` rate-limit key. Retaining the key is deliberate: switching keys in a rolling upgrade could send an additional digest in the same hour.
- Preserve the existing browser-only message wording, while mixed and non-browser digests accurately say "monitors". Keep alert-log rows project-scoped, never disclosing monitor names from a different project.
- No new plan charges, external email provider, migration, production credentials or pricing changes.

## Evidence
- `@montral/repo`, `@montral/db-pg` and `@montral/api` TypeScript checks: PASS on the authorized Windows developer machine.
- `browser-unchecked.test.ts`: 20/20 PASS; new case covers mixed Browser + HTTP + TCP, grouped email subject/content, notification marking and project-level audit isolation.
- `operator.e2e.test.ts` adds real PostgreSQL assertions that the active workspace includes Browser and HTTP monitors together, suspended workspaces are excluded, and paused/already-notified HTTP monitors are excluded. **This database-backed case requires GitHub CI; not locally qualified without an isolated PostgreSQL instance.**
- The `notePlanDeferral` threshold behavior was already covered by `regions-confirm.test.ts` and remains unchanged.

## Scope
This addresses task ledger row 53. The separate issues of per-region credit refunds, billing reconciliation and customer-probe deployment remain out of scope.
