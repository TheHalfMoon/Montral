# Remote regional probe reply and capability stream deadlines

**Date:** 2026-11-02 Asia/Riyadh. Authorized Mac (Node 24.22.1), private Montral source, synthetic fetch streams only. No regional deployment, credentials, payment providers, external SMTP or customer data.

## RED — authenticated regional checks could remain pending

Regional monitor requests send signed request bodies to configured probes and inspect remote JSON results. The 16-KiB response size cap existed, but the reply reader did not independently enforce the fetch AbortSignal timeout. A synthetic upstream that returned the response headers and a few bytes but never closed its stream held the regional check indefinitely. A separate HTTP error response (503) awaited a never-settling `res.body.cancel()`, likewise blocking the region's `unreachable` classification. The API must treat unreachable regions as inconclusive, not as target failures.

Capability discovery before sending HTTP request bodies or advanced methods had the same two hazards: it used a 5-second fetch signal with `readCapped` but no body-read deadline, and awaited cancellation of unsuccessful capability replies. This could hold an advanced check pending without ever reaching the probe.

Four synthetic mounted regressions initially **failed** against the old source with a `still-stalled` watchdog:
1. Signed probe HTTP 503 with a body whose `cancel()` never resolves.
2. HTTP 200 reply with partial sublimit JSON, never-ending body, and mocked short fetch timeout.
3. Capability-check HTTP 503 with nonsettling cancel.
4. Capability-check HTTP 200 partial JSON that ignores timeout while the actual signed body must not be sent.

## GREEN — signal applies to the body too, cancellation is best effort

- The signed regional probe fetch shares its `input.timeoutMs + 8000` AbortSignal with the 16-KiB JSON reply reader. The reader races the signal against every `reader.read()`, so an idle or byte-drip stream cannot reset the budget. On abort, return the generic `Probe did not answer in time` region-unreachable diagnostic, never a false target outage.
- HTTP error responses initiate nonblocking stream cancellation; a remote 503 promptly returns `Probe answered 503`.
- Capability discovery shares its original 5-second timeout with `readCapped`; its unsuccessful HTTP response also initiates nonblocking cancellation. Advanced methods/request bodies are still withheld until explicit capability advertisement, never sent after a stalled or failed health check.
- `readCapped` now accepts an *optional* AbortSignal; legacy callers' semantics remain unchanged. An independent nonsettling-cancel timeout regression guards this optional deadline.
- Preserve existing 16-KiB strict cap, Unicode JSON decoding, error/secret redaction, permitted probe URL configuration, authenticated signatures, existing offline/inconclusive classification, normal region results and backward-compatible capability checks.

**RED 4 blocking cases → GREEN 25/25 focused remote-probe/netguard tests**; the original successful small reply, oversize reply, and suppressed-provider-secret regressions remain green. No live regional credentials were used.

## Unresolved gates

Live Cloudflare multi-region DNS/egress, cross-region probe consistency, network load, reverse proxy/ingress and managed infrastructure remain unqualified. This is code-and-synthetic-only hardening, not a commercial release authorization; Montral remains **NO-GO**.

## Supported Node and PostgreSQL full qualification

Authorized Mac Node **v24.22.1**, independently created disposable local PostgreSQL database and bounded Vitest concurrency (API maxWorkers=2, DB maxWorkers=1): **1,029/1,029 package tests PASSED** — API **770/770** across 97 files; PostgreSQL **115/115** across 10 files; Probe **20/20** across 4 files; Web **124/124** across 26 files. Monorepo TypeScript and Astro typechecks, Node API bundle, Edge Probe bundle, Astro Web build, **638/638** donor source hashes and active Montral branding scan all passed. Exactly matched GitHub-hosted workflow status must be assessed independently before claiming hosted qualification.
