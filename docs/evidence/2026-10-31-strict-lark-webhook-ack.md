# Strict Lark/Feishu webhook delivery acknowledgement — 2026-10-31

## Defect

The original `postLark` handler in `apps/api/src/alerts.ts` decoded the provider's JSON response with a catch-to-null, then defaulted a **missing application status to 0**. As a result, HTTP 200 with an empty body, invalid JSON, array, `null`, or a response without `code`/`StatusCode` was treated as a delivered alert, even though Lark/Feishu supplied **no affirmative acknowledgement**.

The same error formatter appended the provider's arbitrary `msg`/`StatusMessage` to its thrown error; those fields are untrusted and could echo sensitive webhook URLs or user content.

## Repair

- A delivery succeeds only when HTTP itself succeeds **and** the parsed body is a JSON object containing explicit numeric `code: 0` or `StatusCode: 0`, with no conflicting nonzero or invalid second status.
- No implicit success for missing, malformed, contradictory, or string status values.
- Provider nonzero numeric codes and HTTP status remain visible in a limited, safe error string; arbitrary provider message text is **not** copied into errors, delivery rows, or logs through this code path.
- The alert retry and status accounting mechanism is otherwise unchanged. These are application-level safe-acknowledgement rules, not a guarantee that a remote notification was received by a human.
- Synthetic tests add eight negative acknowledgement scenarios and an additional provider-text privacy regression; the existing success tests for both `code: 0` and `StatusCode: 0` remain.

## Qualification and limitation

Source and regression tests are committed in private `TheHalfMoon/Montral` via the connected GitHub app. **This exact revision has not been executed** in the project test runner because the authorized Mac Desktop Commander session reached its monthly usage cap, and GitHub-hosted Actions is blocked by an account payment/spending-limit error before assigning a runner.

The preceding month-end local qualification achieved 817+ passing tests on an earlier revision, but those counts do **not** qualify this code. Keep the new revision unqualified until TypeScript, all API/probe/web/real PostgreSQL suites, production builds, and synthetic Lark deliveries are rerun on the exact committed SHA.

Do not deploy or publish. No real Cloudflare/Lark account, external SMTP, merchant sandbox, or paid infrastructure was invoked. Other production release gates (DNS/egress, hosted CI, DR/PITR, security/privacy/legal and explicit founder publication approval) remain open.
