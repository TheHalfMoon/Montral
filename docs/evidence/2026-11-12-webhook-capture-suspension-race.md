# Webhook capture versus operator suspension (2026-11-12)

## Problem
The public webhook receiver checked a workspace's suspension when it first resolved the inbox token, **before** streaming the request body. An operator could commit a suspension while an untrusted sender was still streaming. After the body finished, the historical and v2 PostgreSQL capture functions could still insert an event in a now-suspended workspace, bypassing the earlier API check.

## Change
- Both `montral_capture_hook_event` and `montral_capture_hook_event_v2` now, after locking and authenticating the inbox, take `FOR KEY SHARE` on the workspace's `organization` row. That conflicts with the operator's `FOR UPDATE` lock in its suspension transaction.
- They then read `workspace_suspension` in a separate fresh PostgreSQL statement. If suspended or the workspace is gone, return `false` (legacy) or `NULL` (v2), before any event insert or retention pruning.
- The linearization point is the organization row lock: an existing capture holding the lock commits before operator suspension; a capture that arrives after suspension commits must refuse. The check uses the workspace ID taken from the authenticated inbox row, never an untrusted body/header.
- The existing public handler maps a missing v2 result to generic HTTP 404 and refunds its reserved webhook-event meter charge at the original spend timestamp. No private suspension reason or note is returned. Early refused captures still return 403.
- Existing 7-argument legacy function signature is preserved. During a mixed-version rollout, ensure older replicas have been updated before relying on the new guarantee, since their edition migration may restore an older SQL function definition.

## Tests
- Added PostgreSQL integration that holds an operator-like organization `FOR UPDATE` and inserts a suspension in one transaction while launching a concurrent v2 capture; after commit the capture must return NULL and store no event.
- Exercises legacy capture against the suspended workspace (false), HTTP bearer receiver refusal (403), and no persisted events. Synthetic suspension, inbox and event data are removed in `finally` even on failures.
- Require local API TypeScript, test harness and migration integrity; exact-head CI PostgreSQL 17/18, macOS, failover and load before merging, then all main CI.

## Remaining
Previously claimed checks may already be in flight (bounded to at most one check per monitor), and up to 30s of public status response cache may remain. These are tracked separately. No deployment, billing provider, price, service activation or production data change.
