# Probe credential lifecycle: implementation design

## Current implementation boundary

The merged registration inventory persists non-secret region metadata only. The current credential-storage slice adds a PostgreSQL table for AES-256-GCM envelopes, version/algorithm/key-version metadata, and an append-only audit trail. Preparation accepts envelope bytes from an internal caller, serializes against registration state transitions, and commits the envelope and audit event atomically. The database limits each region to one `prepared` envelope and permits only a `prepared` → `revoked` transition; ciphertext cannot be updated or deleted through ordinary SQL operations. Audit reads return metadata only.

No operator endpoint, enrollment or delivery flow, KEK loader, credential retrieval/decryption path, probe authentication path, or scheduler integration is enabled by this storage slice. It does not prove that caller-supplied bytes are encrypted. Any future provisioning endpoint must compose generation/encryption and persistence behind one controlled service path and must never accept caller-supplied ciphertext. Prepared and revoked rows retain ciphertext; revocation is a database lifecycle state, not cryptographic erasure. Before credentials are used, qualify KEK rotation/rewrap, stale-backup recovery, bounded overlap, delivery acknowledgement, and replica-wide revocation.

## Decision

Keep the current configuration-managed lifecycle active. Do not enable API-created credentials, dynamic endpoint registration, or secret delivery until the enrollment and replica-revocation boundary below is implemented and qualified. The operator inventory, challenge-response validation, activation/deactivation, and configuration binding already present remain useful controls; they do not provision credentials or attest probe software.

## Ownership and threat boundary

- A platform operator owns region registration and the decision to activate, rotate, or revoke a region. Workspace administrators must never manage platform probe credentials.
- A probe credential authorizes HMAC-authenticated check requests to one configured region. It is not an identity for a human, workspace, customer, or source binary.
- Persistent region metadata is non-secret: stable region ID, display name, endpoint, enabled/deactivated state, credential version IDs, timestamps, operator IDs, and audit state. Secret values, bootstrap tokens, challenge bodies, raw signatures, and URLs must not enter audit records or API responses.
- The API process, its database principal, secret store, probe process, and operator browser are separate trust boundaries. Compromise of the API or its unwrapped key-encryption key can expose all credentials that API can use. Per-region keys limit a single probe compromise; a shared fallback does not.
- Registration must accept only an operator-controlled region identifier and endpoint. It must reject redirects and unsafe schemes, resolve and pin the destination for each connection, deny loopback/link-local/private/metadata ranges unless a separately reviewed self-hosted policy explicitly allows them, and prevent DNS rebinding. Do not accept arbitrary customer URLs.

## Generation and storage

Generate 32 random bytes with the platform CSPRNG (`crypto.randomBytes(32)`), encode only for transport, and assign a random non-secret version ID. Never derive keys from region names, UUIDs, passwords, or `BETTER_AUTH_SECRET`.

| Option | Cost and operation | Decision |
| --- | --- | --- |
| Deployment secret files / Docker secrets / systemd credentials | Zero license cost, self-hostable, supported by the existing environment-based setup. Rotation is operator-managed and coordinated across replicas. | Keep as the current compatible mode and fallback. Prefer file-backed deployment injection over command-line arguments or checked-in `.env` files. |
| PostgreSQL metadata plus application-side envelope encryption | Zero additional service cost and works with existing self-hosted PostgreSQL. Store ciphertext separately from metadata; use AES-256-GCM with a fresh nonce and associated data `(region_id, version_id, purpose)`. The 32-byte KEK must be injected to every API replica as an external secret file and must never be stored in PostgreSQL. | Viable first managed-storage adapter only after backup, KEK rotation, restore, and replica consistency exercises. Database-only backups must not decrypt credentials. Host compromise exposing both DB and KEK remains in scope. |
| OpenBao (self-hosted Vault-compatible secret service) | Zero software license cost, but adds a separately operated service, backup/unseal duties, availability requirements, and API workload authentication. | Optional adapter for operators who already run it; do not make it a required hosted dependency. Do not assume an external paid secret manager. |

Persistent registration metadata belongs in PostgreSQL. Secret-bearing credential versions belong in an encrypted credential table or a configured secret provider, never in the region metadata row, logs, audit trail, or list/read API. Do not persist plaintext as an expedient. If the external KEK is missing or decryption fails, fail closed for the affected region and expose only a fixed operator error.

## Enrollment and delivery

The current model is manual out-of-band provisioning: deploy `PROBE_SECRET` to the probe and the matching `PROBE_SECRETS` value to the API. Retain it for compatibility. A future dynamic flow must not return a long-lived secret to the browser or place it in an audit record. Prefer a short-lived, single-use bootstrap exchange authenticated by a separately established channel (mTLS client certificate or an operator-run local enrollment command with a one-time token). Bind the exchange to region ID, endpoint, key version, nonce, and expiry; store only a hash of the one-time token; consume it atomically; refuse replay. A shared one-time bearer copied through ordinary UI or logs is not an acceptable replacement for secure provisioning.

Every later request remains HTTPS-only with redirects disabled and bounded timeouts/body sizes. HMAC input must bind method, exact path, body hash, region ID, key version, timestamp, and nonce; the probe must enforce a replay window and compare signatures in constant time. Do not send monitor target data during credential possession validation.

## Rotation, revocation, and replica behavior

Allow at most one previous credential version. Rotation is: create new version; provision it to the probe out-of-band or via the qualified enrollment channel; validate possession against that exact version and endpoint; atomically make it primary while accepting the previous version for a hard maximum of 15 minutes; wait for bounded in-flight requests; then remove the old version. The probe and API must both enforce expiry. Extending overlap requires a new audited rotation, not an indefinite grace period.

Revocation is an atomic PostgreSQL state transition plus append-only audit and an outbox/version bump. Every API replica must check current credential state before signing; a bounded cache must have an explicit short TTL (maximum 15 seconds, matching the existing lifecycle-state cache). Database/outbox read failure denies new signatures and registrations. A replica that cannot observe revocation within that bound is not qualified. Revocation cannot cancel an already-sent network request; bound its duration and record that limitation. Do not restore a revoked key by rolling application code back; recovery requires a new version and fresh proof.

## Audit, failure, recovery, and compatibility

Audit only region ID, operator ID, action, fixed outcome, key version ID, and time. Make audit append-only, commit it with lifecycle state, and fail the operation if audit persistence fails. Never include the secret, encrypted ciphertext, KEK fingerprint, full URL, raw probe response, challenge, or signature.

Backups of encrypted credential rows are useful only with a separately protected KEK backup. Restore rehearsal must prove old revoked versions remain revoked and that active credentials can be revalidated. If the KEK is lost, do not attempt plaintext recovery: provision new synthetic/test keys, invalidate old versions, and perform a fresh activation proof. Rollback must preserve schema compatibility and must not re-enable a revoked key or accept a previous key past its expiry.

Existing `PROBE_REGIONS`, per-region `PROBE_SECRETS`, shared `PROBE_SECRET` fallback, and probe-side expiring previous-key support remain readable during any future migration. A dynamic record must not silently override an environment-configured endpoint or credential. Require an explicit conflict error and staged operator migration; keep current configured probes enabled by default until their operator deliberately adopts managed registration.

## Safe next implementation gates

Before enabling any dynamic credential endpoint, require synthetic-only tests for malformed/duplicate region IDs, SSRF and DNS rebinding, one-time token replay, cross-region and cross-tenant authorization, secret non-disclosure, concurrent rotation, expiry boundaries, revocation visibility on multiple replicas, DB outage fail-closed behavior, append-only audit rollback, restore/rollback, and existing configuration compatibility. Run these against disposable PostgreSQL and simulated probes; test keys only. Until these pass and receive an independent technical review, retain the existing static configuration path and do not activate managed credentials.
