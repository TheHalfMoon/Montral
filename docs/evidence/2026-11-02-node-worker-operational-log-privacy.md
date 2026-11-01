# Node and Cloudflare operational exception-log privacy

**Date:** 2026-11-02 Asia/Riyadh. Private Montral source, synthetic-only, authorized Mac, zero paid services and no release. The related request/response logs and app HTTP error privacy checks existed; this closes separate *runtime* failures in scheduler, queue, database startup and mail verification.

## Problem (RED)

Some Node and Cloudflare runtime paths recorded raw `Error` objects or `.message` values from potentially untrusted DB / SMTP / probe or queue callers:
- Node SMTP `verify()` failure at startup printed a remote SMTP exception's message.
- Node database migration retries printed the database exception; final retry rethrew the original object.
- Node and Worker scheduled checks, maintenance, and check batches printed the raw exception. The Worker cron job rethrew the original exception into `waitUntil`, potentially exposing the error to the host platform.
- Node's optional web-build loading logged the dynamic import error and local directory.
- Local dev scheduler also forwarded raw exception objects.
- Node startup logged the configured public origin verbatim (which is not guaranteed to be a credential-free URL).

Three source-level guard regressions **RED / 3 failed** against prior commit `04310a8`, showing all three runtimes accepted the unsafe patterns. These are privacy risks even if request handlers correctly redact their own exceptions.

## Fix (GREEN)

All runtime diagnostic paths now emit **fixed event-specific text**; they never pass raw `Error` objects or `.message` to console methods. Failed Node DB startup gives one sanitized fatal error after the same bounded retries. Worker cron still attempts maintenance after scheduler failure and still rejects failed scheduled work, but with a new sanitized error; queue failure still requests retry with the same delay. Nodemailer verification still fails visibly to the operator, but without exposing the provider's greeting, host, account or credential data. Node startup reports only its listening port, not the unvalidated configured origin. No sender, billing or deployment was enabled.

A permanent `apps/api/src/guards/operational-log-privacy.test.ts` protects Node, Worker and local dev source against reintroducing direct raw exception console calls or the raw Worker cron rethrow. **GREEN / 3 passed.**

## Real Node runtime negative SMTP control

A new `scripts/qualify-smtp-error-log.mjs` starts the **actual built Node API** on `127.0.0.1` against a newly-created disposable local PostgreSQL database. A private loopback SMTP TCP peer deliberately sends a rejection containing a unique private fixture marker. The script verifies the Node process emits a generic `smtp: connection verification failed` diagnostic **without the marker**, then terminates the server and deletes its temporary test database. No external email provider or customer address is used, and no captured process output is copied to the test log. An explicitly named CI step exercises the same negative control after the existing local successful SMTP delivery test.

**Mac:** `SMTP_ERROR_LOG_PRIVACY_PASS` observed with Node 24.22.1. Follow-on package and GitHub-hosted exact-commit checks must be separately verified.

## Remaining external blockers

Production reverse-proxy/access logging, provider-side error monitoring, operator observability, hosted secret management and incident response, live SMTP deliverability, Cloudflare and managed PostgreSQL failure modes, compliance and commercial launch all remain **NO-GO**. This repair is an engineering safeguard, not live operator certification.

## Full supported-runtime local evidence

Authorized Mac, supported Node **v24.22.1**, fresh isolated local PostgreSQL database and bounded Vitest worker concurrency: complete package suite **1,041/1,041 PASSED** — API **782/782** across 100 files, PostgreSQL **115/115** across 10 files, Probe **20/20** across four files, Web **124/124** across 26 files. Monorepo TypeScript/Astro (one nonblocking React FormEvent hint), Node API/Edge Probe/Astro production builds all PASS. **638** pinned donor source hashes verified and active Montral brand guard PASS. The built production Node server's localhost malicious SMTP greeting **SMTP_ERROR_LOG_PRIVACY_PASS** also passed on this exact working tree. Hosted qualification must match the pushed SHA separately.
