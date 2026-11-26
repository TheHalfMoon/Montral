# Unified probe audit timeline (2026-11-26)

## Gap

The MFA-gated platform timeline included workspace suspension and probe drain/undrain records. Probe credential-possession validations and activate/deactivate actions were already recorded durably and visible in the per-region history, but were absent from the cross-region timeline. Operators therefore had to inspect regions one at a time to review these existing actions.

## Change

- The read-only platform timeline now includes probe lifecycle events and the fixed validation outcome classes (`validated`, `identity_mismatch`, `credential_mismatch`, `unavailable`).
- Probe event IDs are prefixed by family in the result (`drain:`, `lifecycle:`, `validation:`), so different append-only tables cannot collide. The internal sort key preserves the old numeric drain key while giving lifecycle and validation records their own namespaced key, allowing pagination to remain stable for older clients while new event types share timestamp ties.
- The query returns only region, action, operator ID, timestamp and the existing workspace reason field. It does not read or return drain notes, endpoint URLs, capabilities, configuration fingerprints, signing keys, challenge data, or validation response bodies.
- The platform console identifies credential-possession history as non-attestation. It continues to use the existing operator session and fresh MFA gate.

## Verification

The added PostgreSQL E2E regression covers all four probe audit families, fixed-time keyset pagination with one row per page, distinct IDs, combined workspace/probe results, target-only filtering, and exclusion of synthetic private notes and configuration fingerprints. The browser journey displays lifecycle and validation entries using synthetic responses. Local API/web typechecks and builds passed; API cursor tests passed 19/19 and the web operator API tests passed 6/6. The PostgreSQL E2E is skipped locally because `TEST_DATABASE_URL` is unset, and the browser journey was not run locally. Hosted exact-head qualification is pending.

This change improves audit visibility. It does not prove that a probe binary or deployment is trusted, establish security clearance, or alter the Community HOLD or Cloud/BYOC NO-GO gates.
