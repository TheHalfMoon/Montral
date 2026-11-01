# Sandbox checkout plan selection: strict body cap and slow-sender deadline

**Date:** 2026-11-01 (Asia/Riyadh). **Environment:** authorized Mac, private Montral GitHub, synthetic-only provider stubs and disposable local PostgreSQL; supported Node v24.22.1. No actual Lemon Squeezy connection, charges, customer data or live payments.

## RED — overly permissive authenticated checkout input

The optional manager-only test-mode `POST /api/billing/checkout` route parsed the complete `c.req.json()` without a byte or total-read budget even though the endpoint only accepts `{"plan":"pro"}` or `{"plan":"business"}`. An authenticated client could supply unbounded JSON, and a low-rate body could hold a server request open without ever reaching plan validation. A real PostgreSQL/Hono regression with an **8-KiB synthetic JSON** body and forged `Content-Length: 5` returned **400**, showing the oversized payload had been parsed rather than rejected early. The expected behavior was an early HTTP **413** before token creation, intent reservation, or provider fetch.

## Correction

- Reuse the existing **byte-exact raw streaming reader** with a strict **2-KiB plan-body cap**, independent of Content-Length. Existing signed merchant callbacks retain their separate **64-KiB** cap and byte-exact HMAC.
- Use the reader's **single 10-second total wall-clock deadline** across all chunks, including slow uploads. Map elapsed deadline to **HTTP 408**. Reject oversize with **HTTP 413** before JSON parsing and before any minting of checkout intent.
- Initiate body-stream cancellation but do not await malicious never-settling cancellation. Size and timeout refusals set `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`. Parse only valid fatal UTF-8 JSON and preserve the strict Zod plan schema.
- Preserve manager-only auth, sandbox-only configuration, atomic PostgreSQL checkout-intent reservation, one pending checkout per workspace, callback HMAC, replay protection and disabled-by-default production billing. No credential, service activation or provider call was added.

## Local RED/GREEN evidence

- RED: PostgreSQL mounted request with forged short Content-Length and an 8-KiB body was **400** instead of the required **413**.
- GREEN: the same authenticated request returns **413** with no-store/no-referrer; the synthetic provider-fetch spy has **0 calls** and PostgreSQL has **0** new checkout intents for that organization.
- GREEN: a direct one-byte streaming regression with a 30-ms injected reader deadline rejects even when `cancel()` never settles.
- GREEN: a mounted manager Checkout request with a never-ending valid-prefix body returns **408** after the real **10-second** timeout with no-store/no-referrer/nosniff, no provider calls and zero checkout intents.
- The original checkout concurrency, single-pending-intent rules, signed-test-subscription behavior, normal small requests and disabled checkout remain unchanged. **Focused billing unit + real PostgreSQL tests: 23/23 PASS**.

## Qualification limits

This fixes local request parsing/availability, not actual hosted ingress/socket limits, real merchant test-store flows, funds, refunds, chargebacks, cloud failover or legal/policy review. Live billing stays disabled, private repository, release **NO-GO**. Full local package suite and exact-SHA hosted CI are separate qualifications; add only observed results to this document.

## Supported-runtime complete local qualification

On a **fresh disposable PostgreSQL database** with Node **24.22.1**, pnpm **10.0.0** and resource-bounded Vitest workers (API 2, PostgreSQL 1), all **1,015/1,015** package tests passed: API **756/756** across 97 files; PostgreSQL **115/115** across 10 files; Probe **20/20**; built Astro Web **124/124**. All monorepo TypeScript/Astro checks, Node API bundle, Edge Probe build and Astro Web production build passed. All **638** pinned donor source hashes and Montral active-branding scan passed. No production merchant/provider was contacted, and hosted CI for the exact committed SHA remains an independent requirement.
