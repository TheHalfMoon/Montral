# Suspension check before claimed alert delivery

Status: Merged in PR #197 as `5cc1345b404dcfaeca170933a4d84fb27318a735`. Exact-head PR checks passed 23/23; the exact-main verifier passed all 12/12 required push workflows for that commit. No independent human/Qodo review was available: the Qodo trial had ended and no human reviewer was requested. The change received manual technical review. This does not authorize release or deployment.

## Behavior

Alert claims already exclude workspaces that are suspended at claim time. A suspension can still commit after a worker claims an alert and before it begins the provider call. The delivery path now performs a fresh, uncached Postgres lookup immediately before provider I/O. If suspension is present, it records the claimed row as skipped and does not call the provider.

The lookup fails closed: if it errors, the delivery path does not call the provider and follows the existing delivery failure/recovery path. The check adds one database read per claimed send. Meter allowance checks that already ran before this final check are not refunded.

## Regression coverage

- Unit regression: a claimed alert whose live suspension check returns true is skipped without calling the provider.
- Real PostgreSQL operator E2E regression: the test claims a due webhook retry, inserts the suspension row after the claim and before delivery resumes, then confirms the provider was not called and the delivery is marked skipped.
- Focused alert unit file: 77/77 passed.
- Operator PostgreSQL E2E file: 3/3 passed on a disposable PostgreSQL 18.7 database.
- API TypeScript typecheck passed; `git diff --check` passed.

## Limits

The live read narrows the claim-to-send race but cannot make an external network call atomic with the operator's suspension transaction. Suspension can commit after the final read while the provider request is starting. A request already started cannot be recalled; meter effects, older replica behavior and external cache invalidation remain separate limitations. This is operational suppression, not a security boundary or a release clearance.
