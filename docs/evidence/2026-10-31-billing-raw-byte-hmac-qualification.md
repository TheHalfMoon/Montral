# Montral — byte-exact verification of signed merchant webhooks

**Date:** 2026-10-31 (Asia/Riyadh). **Repository:** PRIVATE `TheHalfMoon/Montral`. Source base `182bac4185ea4c05dd23760f70013cde3871c8ef`. Authorized Mac only, zero-cost local tools, synthetic Lemon Squeezy test-mode signatures only.

## Security issue confirmed

The sandbox billing webhook receiver previously buffered request **bytes** but called a permissive `TextDecoder()` before computing its HMAC-SHA256 signature and replay digest. Ill-formed UTF-8 is silently replaced with U+FFFD, so the code did **not** authenticate the exact HTTP request bytes as its documentation claimed. It also meant a correctly signed malformed raw byte payload could be incorrectly classified as a bad signature and silently conflate different byte strings through lossy Unicode decoding.

An added real-Hono + PostgreSQL regression proved the defect **before the fix**: a malformed-UTF-8 raw body signed with HMAC-SHA256 over its **actual original bytes** was returned as **HTTP 401** (invalid signature) rather than having its authentic signature verified and its undecodable JSON rejected as **HTTP 400**. The result was 12 passing + 1 failing test in the billing E2E test file.

## Fix

- `limitedBody` now returns a bounded **Uint8Array of the exact streamed request bytes**, instead of decoding early; the existing **64-KiB** limit still applies.
- `verifyLemonSignature` now accepts either the byte buffer or a string for existing unit callers. The signed merchant callback uses the original bytes, with the same constant-time HMAC comparison.
- Decode to text with a **fatal UTF-8 TextDecoder** only **after signature verification**. Incorrect signatures still return **401**; a correctly signed but malformed UTF-8 body (or invalid JSON) returns **400**, without being applied.
- Compute the billing event `digest` from those exact original bytes; replay/audit deduplication no longer aliases lossy-decoded strings.
- The signature validation, provider store/variant identity, test-mode-only safeguard, single-use checkout nonce, existing equal-timestamp state ordering, and absence of live billing remain unchanged.

## Regression

The new synthetic HTTP/PostgreSQL test sends:
1. Valid UTF-8 signed raw bytes containing U+FFFD in an ignored metadata field. It is **authenticated successfully**; because the synthetic provider ID has no existing subscription, it is correctly rejected as unknown with **409**.
2. The same bytes altered in place to contain a malformed `0xff` octet, **with the original signature**: **401** for byte-level HMAC mismatch.
3. Those malformed bytes with a **new correct HMAC signature over the malformed bytes**: **400**, with a safe `Invalid UTF-8 or JSON` response; no billing event ledger entries or subscription changes are created.

**RED before fix, GREEN after fix:** focused billing tests **17/17 passed**.

## Scope and unresolved gates

This is a local cryptographic input-invariant correction, **not a real merchant test**. No network calls to Lemon Squeezy, no live provider credentials, no payments and no SaaS publication. The project is still not commercially qualified: hosted GitHub Actions jobs previously failed before runner allocation; external merchant sandbox callbacks, real SMTP/Cloudflare environments, production privacy, payment reconciliation, costs and legal approvals remain unverified.

## Full qualification results

- **574/574 API tests** across **78 test files** passed, including the new real PostgreSQL byte-exact HMAC regression.
- **122/122 Web tests** across 25 files passed after Node-target web build; **20/20 Probe tests** across four files passed. **Total: 716 passing tests** with no skipped tests in the final suites.
- All package TypeScript/Astro checks and Node API, Node web and optional Cloudflare Edge Probe bundles built successfully.
- Real Node+PostgreSQL health/config/MCP/dashboard HTTP smoke passed. Real headless Chromium signup, synthetic heartbeat monitor, manual incident lifecycle, webhook event inspector and billing-disabled smoke passed.
- Real production Node SMTP to localhost-only synthetic server passed for channel tests plus automatic down/recovery alert delivery. **No external email was sent.**
- PostgreSQL 17 disposable `pg_dump`/`pg_restore` passed with **42 tables, 128 synthetic organizations and five** transactional Montral functions recovered.
- SHA-256 manifest integrity passed for **638 original source files** across the three pinned donor snapshots.
- Exact CI-declared **Node v24.22.1 and pnpm 10.0.0** were used from disposable Mac directories. Owner's PostgreSQL instance `127.0.0.1:5432` remained untouched; test database was isolated on port **55458**.

Hosted GitHub CI remains separately unqualified because earlier jobs failed **before allocating a runner (zero steps)**. Commercial merchant sandbox, hosted Cloudflare, provider SMTP, legal/privacy and release approval are still open.
