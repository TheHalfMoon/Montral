# Hosted CI bridge versus disposable localhost retention rehearsal

**Date:** 2026-11-01 Asia/Riyadh. **Scope:** private repository and a **test-only** correction. The staged production retention policy and automatic purge remain NOT approved or enabled.

## Hosted failure and root cause

The first 2026-11-01 GitHub-hosted app CI run, [41293675097](https://github.com/TheHalfMoon/Montral/actions/runs/41293675097), actually started and passed checkout, source-integrity, dependencies and TypeScript/Astro checks, but then failed the API test phase on `monthly-content-retention.e2e.test.ts` (five related failures). A GitHub Actions PostgreSQL 17 service lives in a Docker container and is reached over port forwarding. Although the application `TEST_DATABASE_URL` has host `127.0.0.1`, PostgreSQL's **server-side** `host(inet_server_addr())` correctly reveals the container bridge address rather than 127.0.0.1. The dangerous local-only synthetic retention DELETE is deliberately constrained to a true loopback PostgreSQL socket, a database matching `montral_test_*`, and a separately written synthetic attestation marker. The hosted port-forwarded service is **not** eligible. Its error `Disposable localhost database required for retention rehearsal` is the expected secure refusal, not an invitation to broaden the destructive guard.

## Narrow correction

Changed only `apps/api/src/monthly-content-retention.e2e.test.ts` (not the production purge method). After setting up the isolated synthetic fixture, tests inspect the address reported by PostgreSQL itself. If it is an actual 127.0.0.1 / ::1 server-side connection, they run the complete real deletion, concurrency and 3-second lock-contention tests. Otherwise **each previously destructive scenario** asserts that the guarded purge rejects with the exact non-loopback error, and that all seven original synthetic content snapshots remain in the database; no destructive mutation or artificially successful deletion is claimed. The read-only aggregate/validation test and explicit non-disposable database refusal still run in both environments.

This preserves the deliberate security boundary and provides CI coverage of negative refusal while leaving actual DELETE/concurrency qualification local-only. It does **not** mean hosted PostgreSQL validated the destructive rehearsal; that would require an independently authorized loopback-only synthetic server. Never loosen `purgeFrozenContentInDisposableTestDb` to accept Docker bridge, RFC1918 or arbitrary network addresses just to make CI pass.

## Verification

The local macOS PostgreSQL (actual 127.0.0.1) branch ran the full **7/7** content-retention E2E checks, including real SELECT/DELETE, race serialization and lock timeout. With supported Node 24.22.1 and pnpm 10.0.0, **API TypeScript check PASS** and a fresh disposable real-PostgreSQL full API suite **707/707 PASS** (87 files). Previous full 965/965 local API/DB/Probe/Web suite, builds, browser, loopback SMTP, restore and SIGKILL evidence was qualified on the parent commit; this patch changes no runtime implementation, only test selection by actual PostgreSQL socket. Hosted CI on the new commit is separately checked and must not be inferred from these Mac results. GitHub Actions previously had billing blocked runners; this run establishes runner access, not final production or SaaS release readiness.
