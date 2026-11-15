# Token-free push-device management in the web account screen

**Status:** implementation branch, hosted exact-head CI pending. No deployment or production-data access.

## Finding

The phones card added by #135 listed raw Apple Push Notification service (APNs) device tokens via `GET /api/push/devices` and removed a phone through `DELETE /api/push/devices/:token`. Even though it did not render the token as text, a browser would still receive the token in JSON and place it in an HTTP path. Access and reverse-proxy logs commonly record paths; HTTP privacy headers alone do not scrub them. This is a preventive privacy hardening, not a claim that a token leaked in production.

## Implementation

- Keep the existing registration, raw device listing and token-based deletion routes for the iOS client's established contract.
- Add `GET /api/push/devices/summaries`, returning only `id`, `platform`, `environment`, `locale`, `name` and `critical`. The API explicitly constructs this response; no `token` key is serialized.
- Add `DELETE /api/push/devices/by-id/:id` with UUID validation, existing per-user rate limiting, and a user-scoped SQL `DELETE WHERE user_id = ... AND id = ...`. A non-owner's ID and an absent row both respond 204, without revealing whether the row exists.
- Switch the browser account card to the summary endpoint and ID-based deletion. The web `PushDevice` type no longer has a token.
- A registration remains a token-based upsert because APNs requires the token to identify a phone. Server-side delivery still uses stored tokens.
- No migration, new dependency, external provider, or cloud charge.

## Focused regression

Real-PostgreSQL `apps/api/src/push.e2e.test.ts` checks that:
1. The legacy mobile listing still contains its token and token-based deletion still works.
2. The summary returns the same device metadata and does not serialize the token.
3. Invalid UUIDs are refused before SQL; a valid owner UUID deletes the row.
4. A second signed-in user cannot list or delete the first user's row by UUID.
5. API keys tied to the user also receive summaries without token and can perform owner-scoped deletion.

A cross-browser signed-in Playwright journey additionally registers a synthetic phone, intercepts the account dashboard's summaries response, verifies the token is absent, removes it by UUID, verifies the deletion URL excludes the token and checks the final server state. It runs in the existing Chromium/Firefox/WebKit/mobile matrix.

**Qualification required:** both PostgreSQL matrix legs, API and web TypeScript/build, browser journeys, and full repository CI on the final branch head. A passing synthetic test does not verify production proxy logs or any native APNs network transmission.

## Residual risk and limits

Legacy mobile endpoint calls still return and use device tokens, and deployments must avoid logging their paths/bodies. This change only prevents the newly added web account card from requesting or transmitting those tokens. The token remains stored server-side for APNs. Physical iOS and live APNs validation require external prerequisites. Publication remains HOLD until `GREEN LIGHT MONTRAL`.
