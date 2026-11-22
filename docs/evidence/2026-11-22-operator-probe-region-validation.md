# Operator probe region validation

**Status:** implementation proposed from `main@7839fb77f54c3bd77643261c2c8dd661d593edb4`; hosted exact-head and integrated-main checks are pending. This is a narrow configuration check, not a probe registration or security approval.

## Change

The MFA-protected operator API adds `POST /api/operator/probes/:id/validate` for an already configured region. It sends a bounded, redirect-disabled `GET` to the configured health endpoint with no signing key, monitor target, cookie or other credential. It accepts only an empty JSON object, applies the existing operator write rate limit, and returns only whether the endpoint's public health document reports the configured region ID plus the recognized capability names. It never returns the configured URL or remote response body.

The request is read-only. A different reported region returns `409 probe_identity_mismatch`; an unavailable, non-JSON, oversized or otherwise invalid health response returns the fixed `502 probe_validation_unavailable` result. The endpoint timeout is five seconds and its response body is capped at 4 KiB.

## Limits

The health document is public and self-reported. A matching region string does **not** prove control of the signing key, verify the probe's source or deployment, confirm that the probe can authenticate signed check requests, or register/revoke a probe. `cryptographicAttestation` is explicitly `false`. Existing `PROBE_REGIONS`, `PROBE_SECRET` and `PROBE_SECRETS` remain authoritative. No credentials were created, rotated or changed, and no probe was deployed.

## Authorization and tests

- The route inherits `requireOperator`: listed operator browser session, recent second-factor sign-in, and refusal of customer sessions and API-key/OAuth credentials.
- Local API TypeScript check: **PASS**.
- Focused PostgreSQL `probe-regions.e2e.test.ts`: **7/7 PASS**, including successful validation, region mismatch, malformed/unreachable endpoint responses, rejected body fields, and refusal before network access for a non-operator.
- `git diff --check`: **PASS**.
- Hosted exact-head checks and post-merge main workflows: **pending**.

No production endpoint, credentials, deployment, billing or release state changed. Community publication remains HOLD; Cloud and BYOC remain NO-GO.
