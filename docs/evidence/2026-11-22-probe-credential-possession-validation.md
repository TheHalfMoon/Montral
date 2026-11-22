# Probe credential-possession validation

Status: implementation is ready for review on `codex/probe-management-registration-audit`, based on `main@9381b35702e4fe37b655925f83f7bec916df5a2e`. Merged in PR #199 at `7f1bf0265108842bc513705766e0c5874ca859d0` after all 23 exact-head hosted checks passed. The 12 exact-main workflows on this SHA are running. This is a narrow validation improvement, not probe registration or release/security approval.

## Threat model and storage boundary

- **Protected assets:** the API's existing `PROBE_SECRET` / `PROBE_SECRETS` values, signed probe-request authority, and operators' ability to distinguish an endpoint that can use its configured key from a misconfigured endpoint.
- **Actors and boundary:** only the existing MFA-verified platform operator can call `POST /api/operator/probes/:id/validate`. The API contacts an already configured HTTPS endpoint from deployment-controlled `PROBE_REGIONS` and uses its existing private key configuration. The probe accepts the challenge only through its existing HMAC request-authentication path.
- **Controls:** the API sends a fresh 256-bit random challenge in a timestamped HMAC-signed body. The probe returns a response signature bound to the challenge, configured region label and capabilities. The API validates the response signature, then the requested region and nonce, with a five-second end-to-end timeout, manual redirect handling and a 4 KiB response cap.
- **Storage review:** this change adds no secret storage, key, credential provisioning, rotation configuration, database row or deployment setting. Existing environment-backed secrets remain authoritative. The challenge and proof are transient and are not logged or returned from the operator route.
- **Attacker cases:** unauthorized callers cannot invoke the operator route; a stale response cannot satisfy a fresh nonce; a wrong-key endpoint cannot make a valid response proof; malformed and oversized responses fail closed. Operators and deployment configuration are trusted boundaries. A compromised API or probe key remains outside this check's protection.

## Limits

A valid response proves that the configured endpoint can use the selected HMAC key and reported region label for this challenge. It does not verify the probe's source code, binary, operator, deployment or network location. When the API uses one shared key for several regions, any endpoint holding that shared key can produce a valid proof for a claimed region; per-region `PROBE_SECRETS` improves separation. The check does not add or remove a region, store a credential, provision/rotate/revoke a key, or persist a validation audit event. Those capabilities remain deployment-managed or open.

## Regression coverage

- Probe Node and edge handler tests: 28/28 passed.
- Real-PostgreSQL operator route suite: 7/7 passed. Coverage includes dedicated and shared keys, wrong-key response, wrong region, stale challenge, unreachable probe and refusal for non-operator/API-key callers.
- API and probe TypeScript checks passed.
- `git diff --check` passed.
- Hosted exact-head qualification passed 23/23 on PR #199. Exact-main workflows for `7f1bf02` are running.