# Probe validation configuration binding (2026-11-23)

## Finding

Probe reactivation required a successful possession validation in the prior five minutes, but the persisted validation row identified only a region and outcome. If an operator changed that region's configured endpoint or HMAC key during that window, the old successful proof could satisfy activation for the new configuration.

## Change

- Compute a configuration fingerprint over the region ID, normalized configured endpoint URL and signing key. The fingerprint is HMAC-SHA-256 under the instance `BETTER_AUTH_SECRET`, with a domain-separated message. The raw key and URL are not written into the validation record.
- Persist the fingerprint with each validation outcome in the existing append-only audit table. Failed or unavailable attempts still become the latest outcome and therefore block activation.
- At activation, compare the latest successful, fresh validation fingerprint to the fingerprint for the current configuration in the same transaction that serializes the lifecycle change. A missing fingerprint or mismatch requires a new validation.
- Do not include the fingerprint in API or audit responses. The fingerprint is not source or binary attestation and does not make a shared probe key identify a particular deployment.
- Historical validation rows migrate with a null fingerprint; they cannot authorize reactivation. Rotating the instance authentication secret also invalidates prior proof fingerprints, requiring revalidation.

## Threat boundaries

The fingerprint protects against reusing a short-lived proof after the endpoint or HMAC credential changes. Database readers cannot test guesses against the fingerprint without the instance authentication secret. The instance authentication secret remains a high-value deployment secret; compromise of it is outside this binding's protection. Automated secret provisioning and storage remain unimplemented.

## Verification

- `apps/api/src/regions.test.ts`: fingerprints are stable for identical inputs and change when endpoint, key or application secret changes; no raw input is present in the fingerprint output.
- `apps/api/src/probe-regions.e2e.test.ts`: a mismatched fingerprint cannot reactivate a deactivated probe; successful current-configuration proof can. The audit response does not expose the fingerprint.
- Local focused test: `regions.test.ts` passed 18/18.
- Local PostgreSQL E2E could not run because `TEST_DATABASE_URL` is unset; the database-backed regression is included for hosted CI qualification.

This change improves activation proof freshness and configuration binding. It is not a security clearance, release authorization or evidence that a probe's source code or deployment is trusted.
