# Suspension check before claimed custom-domain notice delivery

Status: implemented on a focused engineering branch; hosted exact-head qualification is pending. This does not authorize release or deployment.

## Behavior

Custom-domain notices already remain unclaimed when their workspace is suspended at claim time. A suspension can still commit after a notice is claimed and before the email provider call. Delivery now performs a fresh PostgreSQL lookup immediately before provider I/O. If suspension is present, the delivery is marked skipped and the provider is not called. A lookup error also prevents provider I/O; the row stays in `sending` for the existing lease/sweep recovery path.

The final read narrows the claim-to-send race but cannot make an external email request atomic with the operator's suspension transaction. Suspension may commit after the read while provider I/O is starting. An already-started request cannot be recalled.

## Regression coverage

A real PostgreSQL test claims a pending domain notice, inserts the suspension after the claim returns, and verifies the provider transport is not called and the delivery is marked skipped. The full focused `domain-notice.e2e.test.ts` file passed 5/5 against disposable PostgreSQL 18.7. API typecheck and `git diff --check` passed.

## Limits

This is operational suppression, not an atomic revocation guarantee or release clearance. It does not change suspension behavior for workspaces without a committed suspension row, does not cancel provider requests already started, and does not claim whole-repository security clearance.
