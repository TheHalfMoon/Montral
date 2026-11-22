# Operator probe region validation

**Status:** the original public-health validation shipped in PR #196 (`d675cff394e7f134fa93a77c79ddc5d368be10f2`). Its behavior is superseded by the challenge-response implementation in PR #199. This document preserves the original design/evidence and is not a description of current behavior.

## Change

The MFA-protected operator API adds `POST /api/operator/probes/:id/validate` for an already configured region. It sends a bounded, redirect-disabled `GET` to the configured health endpoint with no signing key, monitor target, cookie or other credential. It accepts only an empty JSON object, applies the existing operator write rate limit, and returns only whether the endpoint's public health document reports the configured region ID plus the recognized capability names. It never returns the configured URL or remote response body.

The request is read-only. A different reported region returns `409 probe_identity_mismatch`; an unavailable, non-JSON, oversized or otherwise invalid health response returns the fixed `502 probe_validation_unavailable` result. The endpoint timeout is five seconds and its response body is capped at 4 KiB.

## Limits

The health document is public and self-reported. A matching region string does **not** prove control of the signing key, verify the probe's source or deployment, confirm that the probe can authenticate signed check requests, or register/revoke a probe. The original response marked `cryptographicAttestation` as `false`; PR #199 replaces that public self-report with HMAC proof of configured-key possession and still explicitly does not attest probe source or deployment. Existing `PROBE_REGIONS`, `PROBE_SECRET` and `PROBE_SECRETS` remain authoritative. No credentials were created, rotated or changed, and no probe was deployed.

## Authorization and tests

- The route inherits `requireOperator`: listed operator browser session, recent second-factor sign-in, and refusal of customer sessions and API-key/OAuth credentials.
- Local API TypeScript check: **PASS**.
- Focused PostgreSQL `probe-regions.e2e.test.ts`: **7/7 PASS**, including successful validation, region mismatch, malformed/unreachable endpoint responses, rejected body fields, and refusal before network access for a non-operator.
- `git diff --check`: **PASS**.
- PR #196 was merged. The later current-main qualification for PR #198 is recorded in `docs/evidence/2026-11-22-suspended-domain-notice-send-fence.md`.

No production endpoint, credentials, deployment, billing or release state changed. Community publication remains HOLD; Cloud and BYOC remain NO-GO.
