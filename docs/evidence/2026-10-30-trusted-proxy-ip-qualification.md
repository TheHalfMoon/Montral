# Montral — trusted reverse-proxy IP attribution security qualification

Date: **2026-10-30**, authorized Mac only. Private repository `TheHalfMoon/Montral`; base commit `37bb8fb588881a79470f85f11031cecf2a5ae5bf`.

## Security defect and correction

The existing `clientIp` helper in `apps/api/src/ratelimit.ts` previously preferred the `CF-Connecting-IP` request header over the final `X-Forwarded-For` hop whenever `TRUST_PROXY=true`. On a normal self-hosted **Node** backend behind a reverse proxy, a remote HTTP client can inject a fake `CF-Connecting-IP` header that the proxy might forward unchanged, while the proxy faithfully appends its observed peer address to `X-Forwarded-For`. In that configuration, Montral could incorrectly allocate per-IP authentication and reset-email rate limits to the attacker's chosen header rather than the real peer.

Montral now:
- **Keeps the Cloudflare Workers path unchanged**; its actual runtime provides `CF-Connecting-IP`.
- **On Node, never trusts `CF-Connecting-IP`**, even when `TRUST_PROXY=true`.
- Only with `TRUST_PROXY=true`, uses the **last** comma-separated address in `X-Forwarded-For`, which the configured trusted single reverse proxy must append from the actual peer connection. A maliciously prepended address cannot replace this final hop.
- Requires a valid literal IPv4 or IPv6 address before using it as a database rate-limit key. Rejects malformed text, overlong values, bad IPv4 octets, invalid IPv6 and supplied random identifiers.
- With no trusted proxy configuration, returns no derived IP rather than trusting a user-controlled request header; independent account/email quotas remain in place.

The `.env.docker.example` documents the precise deployment requirement: never enable `TRUST_PROXY=true` on a directly reachable Node backend, and configure the sole trusted reverse proxy to append its actual peer address.

## Local verification

- Existing `apps/api/src/secrets.test.ts` test now exercises spoofed `CF-Connecting-IP` combined with a real final `X-Forwarded-For` value, CF-only spoofing, well-formed IPv4/IPv6 literals, malformed IP text and invalid IPv4/IPv6; cases use the actual runtime `clientIp` implementation.
- Focused secrets/environment suite: **15 passing tests, 2 files**.
- A first full PostgreSQL suite reported 559 passing / 1 failing when two independent test files raced to create the same PostgreSQL composite table type (error 23505 on pg_type, not an application or client-IP error). Another attempt surfaced an existing strict production environment-contract guard when the test bootstrap was initially placed inside active source.
- Resolved without weakening the environment guard by moving the **test-only global Vitest setup** to apps/api/test/global-setup.ts, outside production source, and adding a one-time awaited schema bootstrap before parallel test files run. The bootstrap refuses any non-local URL or database not named montral_ci / montral_test_*. It does NOT change production migration semantics.
- On a **brand-new disposable database** the full API suite passed **560/560 in 74 files** with the existing OAuth, billing and environment-contract tests all green.
- Web **122/122 in 25 files** and Probe **20/20 in 4 files** passed. **702 local tests total**. All monorepo Astro/TypeScript typechecks passed, along with Node API/web and optional Edge bundle builds.
- Node+PostgreSQL health/config/MCP/HTML smoke, real Chromium signup/webhook event inspector/disabled billing, and pg_dump/pg_restore passed. Restore recovered **42 tables, 107 synthetic organizations and all 5 essential Montral SQL functions**.
- All test data and migrations used an isolated local PostgreSQL 17 database at 127.0.0.1:55447, not the owner's preexisting PostgreSQL service at port 5432.
- Source hash verification checks all **638 immutable donor files** from the three pinned originals.

## Limits and remaining gates

This change addresses Node request identity behind a **correctly configured** reverse proxy. It does not authenticate an incorrectly configured proxy that fails to append the true peer, nor does it add a network-layer firewall, WAF or remote penetration test. The `TRUST_PROXY` flag is an explicit operator contract; direct access to the Node backend must remain inaccessible when that flag is enabled. Hosted ingress configuration, Cloudflare regional operations, commercial checkout, account recovery, and real SaaS launch remain unqualified. Production migrations still require proper orchestration when multiple app replicas start simultaneously: the new Vitest-only barrier does **not** by itself ensure multi-replica deployment migrations are serialized. The project is private, with billing disabled by default and **no production deployment authorized**.
