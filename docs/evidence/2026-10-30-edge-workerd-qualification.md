# Montral Edge Probe — local workerd qualification

**2026-10-30.** Private source at `TheHalfMoon/Montral`, based on `0432860454e298eeb015311e2a3a1469ce2f74e0`. This is **local Cloudflare-runtime emulation**, not a real Cloudflare deployment or evidence of network egress from a Cloudflare region.

## Scope and reproducibility

Run `pnpm --filter @montral/api exec vitest run src/edge-cloudflare.workers.test.ts` after `pnpm install --frozen-lockfile`. The test uses the already-declared `miniflare` developer dependency and the real local `workerd` runtime, bundles `apps/probe/src/edge.ts` together with its HMAC and request validation functions using `esbuild`, and **injects a deterministic fake outbound fetch**. No remote network calls or Cloudflare account are needed.

The pinned Miniflare workerd binary currently supports Cloudflare compatibility dates up to **2026-10-13**. The preview Edge Worker configuration has been reduced from `2026-10-30` to `2026-10-13` to match the tested toolchain. This does not qualify newer runtime behavior.

## Passed cases

1. Worker GET capability response has the expected region and scheduler's `http-request-body-v1` protocol.
2. The scheduler's request-signing protocol executes a signed HTTPS GET inside workerd and returns the expected status/latency format.
3. Failed HTTP status and missing response keywords return monitor-failure outcomes, not silent success.
4. Bad HMAC signatures, wrong secrets and timestamp skew beyond 60 seconds are refused with HTTP 401.
5. Private IP/localhost, unallowlisted hostnames, nonstandard HTTPS ports, and spoofed proxy/client headers are rejected.
6. The **actual regional scheduling client** (`apps/api/src/probes.ts` `configureProbes` + `runInRegion`) connects to the local Worker through a synthetic fetch bridge, negotiates capabilities, signs POST including a request body, and receives an `ok=true` result. It caches capabilities for a second request and correctly classifies refused targets as **unreachable** rather than an outage alert.

**Final results:** 5/5 workerd-specific tests passed. Complete suites: 549/549 API (real isolated PostgreSQL), 122/122 web after a non-deploying Cloudflare-target build, and 20/20 probe. All monorepo typechecks, Node API/Node web/Cloudflare-target web/Edge Worker builds, Node+PostgreSQL smoke and real Chromium browser journey passed. Total: 691 tests.

## Security improvements

The Edge Worker now rejects nonstandard HTTPS ports, port-literal abuse, malformed DNS names, and unexpected hop-by-hop or origin-identity headers (`x-forwarded-for`, `cf-connecting-ip`, `transfer-encoding`, `connection`, `content-length`, `forwarded`, Montral signature/timestamp forwarding). The probe's scheduler HMAC is still mandatory, and the fetcher is still redirect-manual.

## Toolchain caveat

The Mac uses Node v26.0.0, outside this repository's declared >=26.12.1 compatibility range. Passing checks are not certification on a supported Node version. CI should eventually run the pinned Node 24.22.1 or an equivalent supported version.

## What this does NOT prove

- No actual Cloudflare Worker deployment, custom domain, region, egress DNS, quota/rate behavior or pricing was tested.
- The outbound fetch is **mocked**; it does not validate Cloudflare's public-internet/TLS/port/DNS policy, nor prevent DNS rebinding of an allowlisted hostname. Operator-host allowlists are a necessary but insufficient SSRF defense.
- No operational 24/7 metrics or genuine cross-region check success was measured.
- `workers_dev=false` remains in the example config; production release requires user-selected domain/route and explicitly approved deployment credentials.
- GitHub Actions on this private repo are blocked before runner assignment (0 steps), so the evidence remains local, not hosted CI.

**No publishing, payments, external customer traffic or paid resources.**
