# Operator probe validation audit

Status: implemented on `main@7979cf7d374ab37292ec44ccdd36b57e6747f310`; local PostgreSQL integration passed. PR exact-head and merged-main qualification are tracked separately in the pull request.

## Change

- Each MFA-protected `POST /api/operator/probes/:id/validate` attempt records one fixed result class: `validated`, `identity_mismatch`, `credential_mismatch` or `unavailable`.
- The event contains only the configured region ID, operator ID, result class and timestamp. It stores no endpoint URL, challenge, request/response body, capability list, signing key or fingerprint.
- `GET /api/operator/probes/:id/audit` returns the existing drain/undrain history and a separate, bounded `validationEvents` list for the region. The route remains behind the operator MFA gate.
- PostgreSQL rejects event updates, deletes and truncation. A missing audit writer returns 501 before contacting a probe; an insert failure returns 503 without reporting a validation result.

Validation still proves possession of the configured signing key at the configured endpoint only. It does not attest the probe source, binary or deployment. Shared keys still do not distinguish regions that use that same key.

## Tests

- Real PostgreSQL `probe-regions.e2e.test.ts`: **7/7 passed**, covering successful, mismatched and unavailable outcomes; customer-session denial; secret/URL/body omission; append-only update/delete refusal; and fail-closed 503 when the audit insert is deliberately rejected.
- Real PostgreSQL `migrate.test.ts`: **2/2 passed**.
- API, db-pg and repo TypeScript checks passed. `scripts/gen-migrations.mjs` embedded 64 migrations; `git diff --check` passed.
- Local runtime used Node 24.19.0, below the repository minimum `24.22.1`; hosted CI on the supported runtime remains the qualification gate.

No probe was registered or deployed and no production credentials were created, rotated or changed. Audit events are retained indefinitely like existing probe drain events; there is no operator-facing deletion or pruning route.
