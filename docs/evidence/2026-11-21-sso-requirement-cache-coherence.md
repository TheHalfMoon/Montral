# SSO requirement cache coherence

**Finding:** a process-local negative SSO-policy cache could let a stale replica keep authorizing a credential after an owner enabled required SSO. The cached `null` caused `ssoAllowsPrincipal` to accept the request before checking its SSO proof. Session, API-key, and agent-token requests could be affected while that replica retained the old cache entry.

**Preconditions:** a member has a credential authorized before SSO was required; one app process cached that the workspace had no SSO requirement; the owner enables required SSO through another process; a request reaches the stale process before its 30-second cache expires. The settings route revokes non-SSO sessions, but derived API keys and agent tokens remain independently presented credentials.

## Reproduction and fix

The real-PostgreSQL regression primes the prior `null` cache by successfully using a member API key, then updates `sso_connection.require_sso` directly in the database to model a settings change committed by another replica. It also deletes the member's pre-SSO sessions, as the owner settings route does. Before the fix, the old key still accessed `/api/monitors` with HTTP 200; after the fix, the request is refused with HTTP 403.

Authorization now reads the current SSO requirement from PostgreSQL for every check. This removes the process-local stale-negative window across replicas. No migration or security-setting change is required. The deliberate tradeoff is one indexed `sso_connection` lookup on each protected authorization check; the repository's general load qualification does not specifically benchmark this SSO path.

## Verification

- Base: `main@9020318cad0779156b60e088c49529300d317544`, verified with 11/11 exact-SHA push workflows before this change.
- RED: focused real-PostgreSQL test failed as expected before the fix: expected HTTP 403, received HTTP 200.
- GREEN: focused regression passed against a newly created disposable PostgreSQL database.
- SSO end-to-end and OIDC suites: 62 passed, 0 failed on a fresh disposable PostgreSQL database.
- API TypeScript check and Node production build: passed on Node `v24.22.1`.
- `scripts/verify_sources.py` and `git diff --check`: passed.
- Read-only agent review of the patch: no new actionable issue found. This is a scoped review, not the managed independent audit or an external penetration test.
- Exact-head hosted PR checks and integrated-main qualification for this change: pending.

## Limitations

The regression models a remote process by writing the policy change directly to shared PostgreSQL; it does not start a second OS process. The original failure was nevertheless reproduced through the same process-local cache and the real API-key authorization path. Codex Security Deep Scan could not start because the host did not provide the required managed filesystem permission profile; this does not indicate a source-code scan result. No production traffic, external identity provider, or customer database was used.
