# Alert HTTP response-body cancellation deadlock — synthetic qualification

**Date:** 2026-11-02 Asia/Riyadh. Engineering-only private branch. No actual notification provider or paid network service used.

## Failure mode

The shared outbound webhook `post()` helper used for generic webhooks, Slack, Discord, Teams, and PagerDuty, and the `ntfy` delivery path, previously **awaited** `res.body?.cancel()` after receiving an HTTP response. In a compliant network response whose stream cancellation never resolves, the HTTP status is already available, but Montral cannot finish an accepted notification or classify a rejected HTTP status. For incident alerts this creates a stuck delivery claim and potentially ambiguous later recovery/retries.

The synthetic regression uses a mocked fetch transport and a `ReadableStream` whose `cancel()` is deliberately nonsettling. It checks four paths: custom webhook/ntfy, each with HTTP **200** and **502**. An independent 180-ms race must receive the real `accepted`/`rejected` outcome instead of `blocked-by-cancel`, while confirming cancellation was attempted. The first test-only commit is `e9f6eca845efeb5da5de94747d961bd129800d49`, and [GitHub app CI 41363703410](https://github.com/TheHalfMoon/Montral/actions/runs/41363703410) **confirmed RED**: exactly 4 new webhook/ntfy cases failed with `blocked-by-cancel`, while 788 API tests passed.

## Correction

Both sites initiate cancellation as best-effort **without awaiting it**, catch a rejected cancel promise, and immediately classify HTTP success/failure the same way as before. The response body is never parsed or saved. This does **not** change HTTP status treatment, outbound SSRF/address validation, provider payload generation, header isolation, delivery ledgers, or retry policy.

**Verified GREEN** on exact fixed PR head `682b0a3c887397e59fd2a7fe1d71320c6bb9d63c`: [app CI 41363826976](https://github.com/TheHalfMoon/Montral/actions/runs/41363826976) completed SUCCESS with **792/792 API**, 20 Probe, 124 Web, PostgreSQL restore/catalog negative control, Chromium journeys and synthetic SMTP; [source integrity 41363827014](https://github.com/TheHalfMoon/Montral/actions/runs/41363827014) SUCCESS on same head. PR #3 was then merged privately as `54b933b467b7e5da88610274783da35b8b648dbd`. These synthetic regressions are not a live-provider integration test, real external abuse-load test, provider replay certification, or production authorization; those gates stay **NO-GO**.
