# Private attribution for new workspace operator actions

Status: implemented on the engineering branch; hosted qualification and merge pending.

## Scope and invariants

Closes the executable new-action identity part of task-ledger row 63. A small private side table references the existing customer-safe audit event. A single data-modifying CTE inserts both records inside the suspension/unsuspension transaction. No note, email, request body, session or credential is copied. Only the existing allowlisted, recent-MFA browser operator timeline joins the private identity. Customer audit reads, exports and the per-workspace suspension history retain their existing role-only attribution.

The additive migration does not backfill historical actions. Old replicas continue writing customer events without a private identity; the timeline reports null. There is no operator-user foreign key, so account deletion cannot rewrite attribution. An append-only trigger refuses update, standalone deletion and truncation. The parent audit event controls retention and workspace-deletion cascades; no retention duration changes.

## Acceptance and evidence

- Baseline `main@93a00bb3b8e742422f70787d0c4a881aa87ece2b`: both new route failure-injection tests fail (HTTP 200 instead of 500) when the old implementation is restored temporarily. The working implementation was restored in a `finally` block. The test doubles exercise the mounted operator routes with valid synthetic MFA and transaction handling; this is not real PostgreSQL rollback evidence.
- Focused Windows API tests after implementation: 19 passed, PostgreSQL tests skipped without `TEST_DATABASE_URL`. Local API TypeScript passed. Embedded migration consistency, source identity and `git diff --check` passed. Node 24.19.0 / pnpm 9.12.0 are below repository requirements; hosted supported-runtime PostgreSQL 17/18 and complete CI are authoritative.
- PostgreSQL acceptance extends the real MFA operator flow: new identities on both actions; no identity/note in customer audit or narrow history; historical fixture stays null; guarded mutation/deletion; failed private identity insert rolls back the parent audit event; workspace deletion removes the private identity.
- Independent fresh-context correctness/product/parsimony and security reviews were requested through the `ps-review` skill. A fixture expectation conflict was found and corrected before CI. This is an engineering agent review, not an external penetration test.

## Supported local runtime follow-up

A portable Node 24.22.1 binary was downloaded from the official Node distribution and verified against its published SHA-256. A disposable PostgreSQL 17.7 cluster runs on loopback port 55441 on `D:`; no Docker daemon, production service or system-wide runtime setting was changed. On the implementation, `operator.test.ts` plus `operator.e2e.test.ts` passed **22/22** with no skips.

The broader API run exposed an existing audit test whose `TRUNCATE audit_event` now stopped at the new foreign key before reaching its append-only trigger. The test now requests `CASCADE` inside a transaction and forces rollback if truncation unexpectedly succeeds; it specifically requires the parent guard's `audit_event is append-only` error. The revised audit and operator tests passed **35/35** on Node 24.22.1 / PostgreSQL 17.7. Retention coverage also exercises the parent's transaction-local cutoff on one old fixture only, avoiding global pruning of other suites. The full API run is still in progress; no full-suite result is claimed here.

No publication, production deployment, paid resource, external email or billing activation is involved. Community publication remains HOLD; Cloud and BYOC production gates remain NO-GO.
