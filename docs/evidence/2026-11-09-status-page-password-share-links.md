# Password-protected status pages and share links

## Gap
Status pages were either public or visible to workspace members only. A team
could not give customers, partners or auditors access without workspace
accounts, and there was no way to expire or revoke such access.

## Design
- `status_page.visibility` gains `password` (migration
  `0045_status_page_password_links`; CHECK requires a hash for password
  pages). The password is stored as `pbkdf2-sha256$100000$salt$hash`
  (100k iterations: the WebCrypto cap on Workers) and is never returned:
  management responses carry `hasPassword` instead.
- `POST /api/public/status/_/unlock {slug, password}`: every failure (wrong
  password, unknown slug, public or members-only page, malformed body) is the
  same `401 {"error":"Incorrect password"}`; an unknown page still runs one
  PBKDF2 verification against a fixed hash, so neither body nor timing tells
  slugs apart. Only JSON from the site's own origin is accepted (a cross-site
  form cannot plant a grant). Limits: 8 per client and slug and 20 per client
  per 15 min (every attempt counts), and 100 *failed* unlocks per page per hour
  (successes never count, so visitors who know the password are not locked out
  by frequent legitimate use). Responses are `no-store`, `no-referrer`.
- Share links (`status_page_share_link`): 256-bit random token, only its
  SHA-256 stored, URL shown once, expiry 1 h to 1 year (default 7 days), at
  most 50 active per page (enforced by `montral_create_share_link`, which locks
  the page row before counting), revocable. Following
  `/api/public/status/_/access?t=…` sets the access cookie and `303`s to
  `/status/<slug>`, so the token leaves the address bar.
- Both paths end in one signed cookie per page (`montral_sa_<page id>`):
  HMAC-SHA256 with a key derived from `BETTER_AUTH_SECRET`, binding page id,
  access version, optional link id and expiry (at most 12 h); `HttpOnly`,
  `SameSite=Lax`, `Secure` on https. Each request checks signature, page,
  version and expiry; a link grant also checks its link is unrevoked and
  unexpired (revocation is immediate); a password grant only opens a page that
  is still password-protected.
- A new password, any visibility change, or "sign everyone out"
  (`POST /status-pages/:id/access/revoke`) bumps `access_version`, invalidating
  every outside grant (and making earlier subscribers non-current).
- Locked password pages answer `401 {locked: true}` without title or content;
  members-only pages stay indistinguishable from missing ones (404). The SSR
  page rewrites to an unlock form; its script lives in `src/inline/` so the
  script CSP hashes it.
- Mail: a password page's incident and maintenance content goes to
  subscribers whose recorded `access_version` equals the page's (they
  subscribed while they had access), and to verified workspace members.
  Rotating the password or signing everyone out stops mail to earlier
  subscribers until they subscribe again with access.

## Independent review
No authentication bypass was found. Fixed findings: returning a page to
password mode without a new password revived old unlock cookies and let
subscribers from a public interval receive mail (now any visibility change
bumps the version); every unlock attempt counted toward the per-page limit, so
anyone could lock visitors out (now only failures count); unlock accepted
cross-site form posts (now JSON from the own origin only); and the share-link
cap could be exceeded concurrently (now a row-locking database function).

## Evidence
- `status-access.test.ts` (unit): salted hashes, right/wrong/empty
  passwords, missing/malformed/downgraded hashes, 256-bit tokens stored as
  hashes, cookie attributes and 12 h bound, page/version/visibility binding,
  tampered payload, other secret, missing signature, expiry, link grants
  needing a live link.
- `status-password-links.e2e.test.ts` (PostgreSQL): creation validation, no
  hash in any management response, 401 + no content on five public routes,
  identical failures for five refusal kinds, unlock cookie attributes, page
  scoping, member bypass, password rotation and sign-everyone-out
  invalidation, members-only closing to password holders, per-client rate
  limit (9th attempt 429, even with the right password), share-link
  creation rules, token not stored or listed, 303 without the token,
  revocation and expiry ending both the cookie and the URL, malformed tokens,
  cross-workspace 404s, version-based subscriber mail, the visibility round
  trip, failure-only page limits (seeded budget: 100 refuses even the right
  password, 99 allows it; successes leave no count), 403 for text/plain and
  foreign-Origin unlocks without a cookie, and exactly 50 of 60 concurrent
  share-link creations succeeding.
- `qualify-browser.mjs` (real Chromium): an outsider sees the lock form
  without the title, a wrong password is refused, the right one unlocks the
  page, the access cookie is not readable by page script, and no CSP
  violation occurs on these pages.

## Limits
- A share link is a bearer URL: anyone it is forwarded to can use it until it
  expires or is revoked.
- Rate limits use the client address only behind a trusted proxy
  (`TRUST_PROXY`), as for sign-in; otherwise only the per-page limit applies.
