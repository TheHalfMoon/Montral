# Operator probe validation audit

Status: implemented on `main@6b19bdf661caad4fa3b21de23ae9239c4e9ad078` via PR #201. All 23 exact-head checks passed on `015dc71d9df5659b319fc69f3d4142fe2e42ac51`; all 12 required exact-main push workflows passed on the merge SHA. CI is integration qualification, not security clearance.

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
- Focused local tests used Node 24.19.0, below the repository minimum `24.22.1`. Hosted exact-head qualification used the supported runtime; all 23 PR checks passed. The 12 exact-main push workflows were verified on the merged SHA with `scripts/verify-main-workflows.py`.

No probe was registered or deployed and no production credentials were created, rotated or changed. Audit events are retained indefinitely like existing probe drain events; there is no operator-facing deletion or pruning route.
