# Members-only status pages

## Gap
Every status page was public. The access hook (`Entitlements.statusPageAccess`)
existed, but no edition implemented it, so a team could not keep an internal
status page off the internet.

## Change
- `status_page.visibility` (`public` default, or `members`), migration
  `0044_status_page_visibility` with a CHECK constraint; editable through
  `POST/PATCH /api/status-pages` and a "Who can see this page" control.
- `statusAccess`, which already guards every `/api/public/status/:slug/*`
  route (page, summary, badge, incidents, RSS, ICS, llms.txt, maintenance,
  subscribe), now enforces it in core: a members-only page needs a browser
  session of a current member of the page's workspace. Anyone else, including
  API keys and OAuth agents, gets the same `404` body as a missing page. An
  edition policy still applies on top. Restricted responses are always
  `private, no-store` with `Vary: Cookie, Authorization`, bypass the in-memory
  status caches, and carry `noindex`. The SSR page forwards the visitor's cookie
  and marks itself private when the API answer is private.
- Subscriber mail: incident notifications (`subscribersFor`, monitor and
  manual-incident paths) and maintenance reminders send a members-only page's
  content only to confirmed subscribers whose address is a verified member of
  the workspace, compared case-insensitively. Existing outside subscribers are
  kept (the page can be made public again) but receive nothing while private.
- The editor marks private pages and warns that embeds and the image badge
  stop working.

## Evidence
`status-visibility.e2e.test.ts` (PostgreSQL): for all nine slug routes,
anonymous and non-member sessions get `404` + `private, no-store` with no page
content, members get `200` + `private, no-store` + `Vary: Cookie`; subscribe
and API-key requests get `404`; invalid visibility is `400`; switching back to
public restores anonymous access and public caching. Subscriber selection is
checked for both notification paths, including unverified members.

## Limits
- A refused request is a `404` with `private, no-store`, while a missing slug on
  some routes is a `404` with a short public cache lifetime, so the headers can
  tell "exists but private" from "never existed". Slug availability is already
  visible when creating a page.
- Responses that a CDN cached while the page was public can be served until
  their lifetime ends (at most 5 minutes for ICS/llms.txt, 30-60 s for the
  rest) after switching to members-only.
- Password-protected or link-shared pages are not implemented.
