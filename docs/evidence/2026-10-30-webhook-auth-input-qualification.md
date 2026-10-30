# Montral — webhook text safety and unidentified-client authentication throttling

Date: **2026-10-30** (Asia/Riyadh). Source starting point: private GitHub `TheHalfMoon/Montral`, commit `8e9d6c771b9a8ab8a1cec53d1db01080a2a30aa4`. Work performed on the authorized Mac only; no Windows or public deployment.

## Problems closed

### Unrepresentable webhook bodies

Montral's endpoint streams at most 32 KiB of request data into a PostgreSQL `text` event-body column. Previously it decoded bytes through a permissive `TextDecoder`:
- an unescaped **NUL byte** passed decoding and then caused PostgreSQL to reject the inserted string, producing an internal error rather than a caller response;
- invalid UTF-8 was silently converted to replacement characters, making the captured payload unfaithful.

The receiver now rejects both **raw U+0000/NUL bytes and malformed UTF-8** before reaching PostgreSQL, returning **HTTP 422** with a stable JSON error. Normal, including multibyte, UTF-8 and the existing 32 KiB limit are preserved. The inbox receives no event for refused bytes. This is intentionally a **text-only webhook inbox** rather than a binary-archive service. No raw webhook bodies or receiver secrets are committed as evidence.

### Unidentified-client auth throttling

In Node self-host mode without a configured trusted reverse proxy, `clientIp()` correctly refuses to trust attacker-controlled forwarding headers and returns null. However, the auth middleware previously **skipped the per-IP database rate limit entirely** in that case. In particular, email signup had no separate per-email quota.

The fix:
- always counts auth attempts in PostgreSQL: a trusted, validated IP uses the existing per-IP thresholds, while unavailable IPs share a route-specific bounded **fallback bucket** (at least 300 attempts per configured window, using the existing quota database);
- limits repeat signup attempts targeting the **same normalized email** to 3/hour, even if the request carries forged `X-Forwarded-For` and `CF-Connecting-IP` headers;
- rejects overlong email identifiers before using them to construct database rate-limit keys;
- applies a fallback bucket to native GitHub sign-in initialization as well.

**Operational limitation:** a shared unknown-IP bucket can throttle legitimate clients behind an unconfigured ingress after many requests; it is a defense-in-depth fallback, **not** a substitute for a trusted proxy, CAPTCHA/anti-bot protection, or hosted abuse controls. Self-host operators must configure real reverse-proxy network isolation and append-only address forwarding before enabling `TRUST_PROXY`.

## Local verification

- Focused API unit and real PostgreSQL tests: **14/14 PASS** across webhook and request-hardening tests, including malformed UTF-8, NUL, valid multibyte UTF-8, sign-up from forged address headers, and four attempts against one email (fourth refused with 429).
- **Full API**: **564/564 tests PASS** (75 files), with isolated PostgreSQL 17 at 127.0.0.1:55449.
- **Web**: **122/122 tests PASS** (25 files) after rebuilding the Node-target Astro app.
- **Probe**: **20/20 tests PASS** (4 files).
- **Total: 706 passing tests**; all monorepo TypeScript/Astro typechecks and Node API, Node web, Edge Probe builds passed.
- Real Node+PostgreSQL smoke PASS: health, config, MCP discovery and rendered HTML dashboard.
- Real Chromium PASS: synthetic signup, authenticated inbox creation, event reception/inspection, secret disappearance after navigation, disabled billing and anonymous route denial.
- `pg_dump`/`pg_restore` PASS: **42 tables, 121 synthetic organizations, 5 essential SQL functions** recovered in a separate temporary DB.
- SHA-256 integrity PASS: all **638** source files in the three pinned upstream donor snapshots remain untouched.

## Reproduction and safeguards

```sh
pnpm install --frozen-lockfile
pnpm -r typecheck
TEST_DATABASE_URL='postgres://<local-user>@127.0.0.1:<temp-port>/montral_test_<suffix>' \
  pnpm --filter @montral/api test
pnpm --filter @montral/web test
pnpm --filter @montral/probe test
pnpm --filter @montral/api build:node
DEPLOY_TARGET=node pnpm --filter @montral/web build
pnpm --filter @montral/probe build:edge
TEST_DATABASE_URL='<same-disposable-url>' node scripts/smoke-node.mjs
TEST_DATABASE_URL='<same-disposable-url>' MONTRAL_CHROMIUM='<already-installed-headless-Chromium>' \
  node scripts/qualify-browser.mjs
TEST_DATABASE_URL='<same-disposable-url>' node scripts/qualify-backup.mjs
python3 scripts/verify_sources.py
```

All tests used local synthetic data. No email to actual recipients, no real checkout, no Cloudflare deployment, no payment provider connection, no public release and no paid resources.

## Remaining launch blockers

CI on GitHub Actions remains unqualified: previous runs failed before runner allocation, with **zero test steps** and no supported-Node hosted evidence. The authorized Mac runs Node v26.0.0, below the declared Node 26 minimum. Real Cloudflare regional operation, real merchant sandbox test, cross-browser accessibility, hosted rate-limit/abuse and payload redaction policy, at-rest encryption, customer data protection, production backup/PITR and legal/commercial launch decisions remain unverified.

**Outcome:** two local security/reliability defects corrected with passing tests; **Montral is still PRIVATE and NOT production-qualified**.
