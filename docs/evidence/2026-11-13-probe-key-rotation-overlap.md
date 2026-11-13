# Probe signing-key rollover with expiring overlap (proposed)

Status: PROPOSED, pending exact-head hosted CI, independent security review and merge. No probe or API was deployed; no production key was created or changed.

## Problem

All probe regions use the same `PROBE_SECRET`. Rotating it previously required synchronous probe/API redeploy or temporarily drained regions. An API replica still signing with an old key could be refused by a probe upgraded to the new key.

## Change

- Every Node, Docker, Vercel and Cloudflare probe accepts a *previous* HMAC signing key during a staged rollout, provided the probe also has a strictly formatted and still-future UTC `PROBE_PREVIOUS_SECRET_EXPIRES_AT`. A missing, malformed, impossible or expired timestamp rejects the older signature. A missing primary key still disables checking. Old signatures remain subject to the existing 60-second timestamp/skew check.
- The API keeps signing with only its current `PROBE_SECRET`, with **no** downgrade/fallback signing path. No new database tables or key storage.
- Probe Docker Compose env passthrough and Node/Vercel/Edge runtime env wiring include the optional previous-key and expiry settings. No secrets are printed by code, and old keys are never returned in health probes.
- Documentation provides explicit probe-first, API-second, remove-old-key-last rollout. Operators are responsible for validating every region, setting a suitably short expiry, removing the old key and checking rollback readiness. Key compromise during overlap remains an exposure until expiry or removal.

## Local qualification (2026-11-13)

- `pnpm --filter @montral/probe test`: **25/25 passed** after correcting a UTC ISO formatting bug discovered in the broader suite. Tests include signed previous/current keys in Node's actual HTTP adapter, probe handler and edge verifier; expired/missing/malformed/impossible UTC deadline and missing primary key refuse old signatures; an already valid current signature remains valid.
- `pnpm --filter @montral/probe typecheck`: PASS.
- `pnpm --filter @montral/probe build:edge`: PASS, browser-target ESM bundle.
- `pnpm --filter @montral/probe build:node`: PASS, Node ESM bundle.
- `pnpm --filter @montral/api typecheck`: PASS against the shared signing protocol changes (exit 0).
- `git diff --check`: PASS. Local Windows Node v24.19.0 is below repository-supported Node 24 minimum; GitHub Actions supported-runtime exact-head CI is authoritative.

## Non-goals and residual limits

No operator UI or API for registering probes, no per-probe credentials, no automatic generation or distribution of secrets, no externally authorized production rotation, and no production DNS/egress qualification. The old key is usable until expiry during overlap; setting an excessively distant expiry is an operator risk. Cloud and BYOC remain NO-GO for external release gates. No release/tag/deployment/payment is authorized.
