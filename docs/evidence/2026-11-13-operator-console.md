# Operator console with session-only platform controls (2026-11-13)

## Previously missing
The platform already had secured `/api/operator/*` endpoints for workspace lookup, suspension and probe drain, but operators lacked a UI.

## Scope
- Unlinked `/app/operator` route for workspace search, cursor paging, detail, suspension/unsuspension and probe-region health/drain/undrain.
- Browser-session-only, same-origin requests with `credentials: include`, `cache: no-store`, no bearer/API key, no local/session storage and no shared workspace API cache. Errors never echo the raw operator denial body.
- A workspace state change requires typing the exact workspace slug; a region drain change requires typing its exact region ID. Private notes are length-bounded.
- Operators can access the console even if their active customer workspace is suspended; workspace-specific usage/verification notices do not mount on this route.
- Existing server gate enforces operator allowlist, recent second-factor browser sign-in, CSRF, rate limits and transactional audit records for each write. The UI does not grant privileges by its presence.

## Qualification
Windows Astro: 164 files, 0 errors and 0 warnings (three existing/non-blocking diagnostic hints in the initial run). Focused operator API and routing Vitest: 11/11 PASS. `git diff --check` PASS. Hosted exact-head PostgreSQL 17/18, macOS ARM64, browsers, failover, load, restore and integrity checks required before merge.

## Limits
This does not add payment-suspension self-service, a unified platform audit UI, a provider sandbox or live billing. No production deployment, release, external spend or new API permissions. Physical-device and independent security assessments remain separate.
