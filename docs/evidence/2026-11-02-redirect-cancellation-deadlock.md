# Redirect-body cancellation must not stall monitored checks

**Date:** 2026-11-02 Asia/Riyadh. Private engineering only; no production deployment, paid provider, customer traffic or external network request.

## Failure mode

`guardedFetch` validates every HTTP redirect target to prevent redirects into private/metadata addresses, and manually fetches each hop to avoid DNS rebinding. After reading a 30x `Location`, it previously executed `await res.body?.cancel()` **before checking the next destination**. Cancellation is controlled by the response stream/transport; an uncooperative stream can return a never-settling cancellation promise. As a result, even a valid redirect can hang until an outer timeout, and the next hop cannot be validated or fetched.

The regression `netguard.test.ts` stubs the fetch function without any real network access, returning an HTTP 302 with a `ReadableStream` whose `cancel()` never resolves. It races the guarded fetch with a bounded synthetic timeout and requires the final HTTP 200 response and the second public hop, while confirming cancellation was requested. It would return `blocked-by-cancel` with the original blocking `await`. The test-only commit was `2983483`; hosted observation of RED should not be claimed unless its CI result is inspected.

## Repair

Cancellation is now initiated as **best-effort nonblocking cleanup**, with rejection consumed, so a stalled or rejecting `cancel()` cannot block the redirect loop. This preserves the existing behavior for no-follow requests, per-hop address and SSRF protections, maximum redirect count, credentials isolation between origins, and protected request bodies. No raw target or transport error is logged.

## Verification and limits

Verify the direct synthetic regression plus the full GitHub Actions app and source-integrity workflows on the final branch head. The real SMTP sink, local PostgreSQL backup/restore + destructive trigger negative control, and Chromium E2E are still run as part of the standard app CI. These checks do not qualify live Cloudflare outbound networking, hosted transport close behavior, long-running saturation load, or commercial release. Those external gates remain **NO-GO**.
