# Telegram Bot API application acknowledgement — 2026-10-31

## Scope and motivation

Private Montral repository, zero-cost engineering, synthetic mail/alert fixtures only. No live Telegram Bot API request, hosted deployment, paid infrastructure, real merchant or customer data.

Before this change, Telegram alert delivery called the generic `post()`, which only checked the HTTP response status. That was sufficient for transports that acknowledge by HTTP status alone but did not validate Telegram's JSON `ok` field. A proxy can produce a successful HTTP status with an HTML, empty or malformed body; an API-specific rejection can also return `ok:false`. In either case the old code could incorrectly mark an alert as `sent`.

## Code change

- `apps/api/src/alerts.ts` now sends Telegram messages using `postTelegram`, retaining the existing SSRF-protected outbound `send()` route.
- The response is read through `readCapped` at **64 KiB**, JSON decoded and checked for a non-array object whose `ok` property is strictly the boolean `true`, **and** HTTP status must indicate success.
- Missing/invalid/malformed responses, string `"true"`, explicit `ok:false`, empty bodies and HTTP failures fail closed and propagate to the existing alert delivery retry/ledger machinery. Only safe integer API error codes (100–599) are included in diagnostic text; untrusted `description`, chat IDs and bot tokens are not copied into these exception messages.
- An existing project-name alert test helper that fakes Telegram now returns `{ok:true,result:{message_id:101}}` instead of the Lark-only `{code:0}`, so it models the correct Telegram provider contract.
- This check confirms **provider acknowledgement**, not that a human received or read an alert. Ambiguous post-acceptance network failures retain the existing retry/idempotence trade-off.

## Regression tests committed

Ten synthetic Telegram test cases were added to `apps/api/src/alerts.test.ts`: one valid acknowledgement, eight invalid/contradictory acknowledgements (empty, invalid JSON, null, array, missing status, string status, explicit rejection, HTTP failure despite `ok:true`) and a privacy case where provider-supplied `description` contains a synthetic credential.

**Qualification status: not runtime-tested on this exact revision.** The authorized Mac control had already reached its monthly usage cap. GitHub-hosted Actions is blocked before allocating a runner by an account payment/spending-limit annotation ([run 41206285444](https://github.com/TheHalfMoon/Montral/actions/runs/41206285444)). Changes were saved via the connected GitHub app, source and test file content can be re-read, but TypeScript, unit tests, database E2E, production builds and provider behavior were **not executed** in this wave. Do not count these cases as passing tests until run against the exact commit.

## Outstanding release work

Green hosted CI and exact-SHA local qualification, Cloudflare cross-region probe controls, external email delivery and abuse testing, managed PostgreSQL PITR/failover, merchant sandbox callbacks, security/privacy/accessibility reviews and explicit authorization to publish remain open. **No release or paid service activation is approved.**
