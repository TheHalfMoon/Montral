# Telegram and Lark acknowledgement body-read deadline

**2026-11-02 Asia/Riyadh — Private engineering PR #4; no live provider, paid service or deployment.**

## Finding

The Telegram and Lark/Feishu senders require an application-level JSON acknowledgement after receiving HTTP 200. Both cap response body size at 64 KiB but called `readCapped(response, limit)` without its supported optional abort/deadline signal. Their outbound request used a network-level 10-second AbortSignal, but a noncompliant response stream that never delivers body bytes or terminates can still block the acknowledgement parser after the headers have arrived. In that state an alert delivery is stuck and cannot be correctly marked as failed. Treating HTTP 200 alone as success would be unsafe; preserving the provider acknowledgement checks is essential.

## Reproduction and repair

Two deterministic synthetic tests stub the outbound fetch with a response whose stream never produces data; the stream's `cancel()` also never settles. They verify that HTTP 200 **cannot** be misreported as accepted, and must be rejected on a bounded response-body read deadline. The test replaces `AbortSignal.timeout` with an actual native 30ms signal for fast fixture execution; a 180ms independent race detects the old deadlock. No external network or real bot credentials are used.

Both Telegram and Lark response parsers now pass `AbortSignal.timeout(SEND_TIMEOUT_MS)` to `readCapped`. This establishes a separate, finite body-read bound after response headers; the same helper already requests cancellation without awaiting a malicious stream. JSON size caps and strict Telegram `ok === true` / Lark zero-code acknowledgement requirements remain unchanged. The initial send timeout remains 10 seconds; the response-body read can require up to another 10 seconds, so this is **not** an end-to-end 10-second hard cap.

## Qualification and limitations

**Verified RED:** [app CI 41364679326](https://github.com/TheHalfMoon/Montral/actions/runs/41364679326) on test-only head `e1852e4cfade7c1848cf7bdf0707f9099036b211` failed exactly two new cases with `ack-read-stalled` while 792 other API tests passed. **Verified GREEN:** [app CI 41364754196](https://github.com/TheHalfMoon/Montral/actions/runs/41364754196) on exact fixed PR head `7a71183bcdc48e8d35e5df1ed8942630c63e7851` passed **794/794 API**, 20 Probe, 124 Web, database restore/negative control, Chromium and local SMTP; [source integrity CI 41364754158](https://github.com/TheHalfMoon/Montral/actions/runs/41364754158) passed on the same head. PR #4 merged privately as `7c5cc590957c10731bd0d597ce1102266880857f`. This does not validate live provider delivery, replay, consumer device receipt, managed egress or commercial launch; those gates remain **NO-GO**.
