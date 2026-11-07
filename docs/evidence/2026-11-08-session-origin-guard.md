# Cookie-session writes from other origins were accepted

## Failure mode
Authenticated `/api/*` routes accepted the better-auth session cookie on
POST/PUT/PATCH/DELETE without checking where the request came from. Only
`/api/auth/*` (better-auth `trustedOrigins`) validated Origin. SameSite=Lax
stops cross-site forms, but a sibling subdomain (for example a user-content
or status host under the same registrable domain) is *same-site*, so the
cookie is sent and a page there could create incidents, delete monitors or
inboxes, or change settings as the signed-in user. CORS does not help: a
simple `text/plain` form or `no-cors` request still reaches the handler.

## Change
`requireOrg` now refuses (403) an unsafe-method request authenticated by a
session cookie when its Origin is present and is neither `WEB_ORIGIN` nor
the request's own origin (including `Origin: null`), or, without Origin,
when `Sec-Fetch-Site` is `same-site` or `cross-site`. API keys and OAuth
tokens are not ambient credentials and are unaffected. Requests without
Origin or Sec-Fetch-Site (native app, scripts) are not browser forgeries
and still work. Reads are unchanged.

## Evidence and limits
`session-origin.e2e.test.ts` (PostgreSQL) signs up a real session, then
verifies 403 and no inserted incident for a sibling-subdomain origin, a
foreign origin, `null`, and same-site/cross-site fetch metadata, including
the webhook inbox delete route mounted by the edition; and 201/200 for the
web origin, same-origin fetch metadata, no-Origin clients and cross-origin
reads. The complete API suite and Chromium journey must pass in CI.
