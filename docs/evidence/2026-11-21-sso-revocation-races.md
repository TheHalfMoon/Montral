# SSO revocation race closure

**Status:** implementation and local qualification complete on `fix/montral-sso-config-revision-20261115`, rebased onto `main@9d5c20068728ba30f4ff0ed6655b24970d07c837` (including #149's callback session revision fence). PR/hosted CI, merge, and integrated-main verification are pending.

## Findings and changes

PR #149 already added an exact connection-revision check at the final callback session marker. This change preserves that implementation and also checks the locked revision before persistent link/JIT writes, preventing stale callbacks from leaving a new identity link or account behind when an owner changes the connection during provider exchange. A stale callback still fails closed before sending a session cookie. Instance-level environment SSO remains unchanged.

The Better Auth after-hook could read a live SSO session, race with owner revocation, and insert an API-key proof afterward. Proof creation is now a single statement that selects and locks the live, unexpired parent session while inserting the proof. Revocation either removes the parent first, preventing insertion, or waits for insertion and then deletes the child proof. The API-key creation itself can finish, but a key without a live proof is refused by protected routes.

Owner settings updates now compare the exact PostgreSQL `updated_at` revision read before provider discovery. The timestamp advances monotonically at microsecond precision. A stale concurrent update returns HTTP 409 (`settings_changed`) instead of restoring an old issuer/client with an invalidation decision based on stale state.

## Reproduction and validation

- Before the patch, a real Hono/PostgreSQL callback held at the synthetic identity provider's token response resumed after the owner replaced the client. It created one SSO session proof, and the protected API request remained authorized. Reproduced twice.
- Before the patch, a real Hono/PostgreSQL auth after-hook held immediately before the SSO credential insert resumed after owner revocation. It inserted one proof, and the protected API key remained authorized.
- Regression tests cover old callback refusal for an existing account, a new JIT account, and an identity-link flow; they verify no new proof/session, user, or link survives and the owner's break-glass session remains usable.
- A deterministic PostgreSQL regression holds the stale owner snapshot while a second owner update changes the client. The stale request receives 409 and cannot restore the old client.
- Focused final PostgreSQL race cases: pending rerun on the rebased main head.
- Complete SSO end-to-end and OIDC suites: prior branch run **59 passed, 0 failed**; final rebased-head rerun pending.
- API TypeScript check: passed. Node API production build: passed. `scripts/verify_sources.py`: passed. `git diff --check`: passed.
- Independent post-patch, read-only security review found no actionable issue. This review is not release approval or a full repository security audit.

## Scope and remaining qualification

All identity providers and email delivery in these tests are synthetic/local; no external identity provider was contacted and no real email was sent. This evidence does not qualify PostgreSQL 18, hosted CI, production identity providers, production session/key behavior under load, or the remainder of the managed source security audit. The security audit remains partial, and external security, provider, privacy/legal, infrastructure, and launch-authorization gates remain open.
