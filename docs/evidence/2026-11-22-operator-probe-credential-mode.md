# Operator probe credential mode

The MFA-protected `GET /api/operator/probes` response now reports `credentialMode` for each listed region:

- `dedicated`: the active region is signed with its own `PROBE_SECRETS` entry.
- `shared`: the active region uses the deployment-wide `PROBE_SECRET` fallback.
- `unconfigured`: the region is stale or no active signing credential is configured.

This fills an operator inventory gap when migrating from a shared signing key to per-region keys. The response contains no signing keys, probe URLs or secret fingerprints. The value is derived from the API's validated runtime configuration and is available only behind the existing MFA-protected operator API.

This change does not add registration, secret generation or storage, deployment automation, source attestation, revocation, or any production credential change. Regions remain configured through deployment settings; a `dedicated` status does not prove that the remote probe has received the matching credential. `unconfigured` on a stale stored row means it is no longer active in this API's current configuration.

Validation includes unit checks for all three credential modes and secret absence, plus PostgreSQL operator-route integration assertions for a synthetic dedicated region and a synthetic shared region. This is operational inventory only, not security clearance or evidence of live cross-region probe qualification.
