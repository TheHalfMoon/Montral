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
  slugs apart. Limits: 8 per client and slug and 20 per client per 15 min,
  100 per page per hour. Responses are `no-store`, `no-referrer`.
- Share links (`status_page_share_link`): 256-bit random token, only its
  SHA-256 stored, URL shown once, expiry 1 h to 1 year (default 7 days), at
  most 50 active per page (enforced inside the INSERT), revocable. Following
  `/api/public/status/_/access?t=…` sets the access cookie and `303`s to
  `/status/<slug>`, so the token leaves the address bar.
- Both paths end in one signed cookie per page (`montral_sa_<page id>`):
  HMAC-SHA256 with a key derived from `BETTER_AUTH_SECRET`, binding page id,
  access version, optional link id and expiry (at most 12 h); `HttpOnly`,
  `SameSite=Lax`, `Secure` on https. Each request checks signature, page,
  version and expiry; a link grant also checks its link is unrevoked and
  unexpired (revocation is immediate); a password grant only opens a page that
  is still password-protected.
- A new password or "sign everyone out" (`POST /status-pages/:id/access/revoke`)
  bumps `access_version`, invalidating every outside grant.
- Locked password pages answer `401 {locked: true}` without title or content;
  members-only pages stay indistinguishable from missing ones (404). The SSR
  page rewrites to an unlock form; its script lives in `src/inline/` so the
  script CSP hashes it.
- Mail: a password page's incident and maintenance content goes to
  subscribers whose recorded `access_version` equals the page's (they
  subscribed while they had access), and to verified workspace members.
  Rotating the password or signing everyone out stops mail to earlier
  subscribers until they subscribe again with access.

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
  cross-workspace 404s, and version-based subscriber mail.
- `qualify-browser.mjs` (real Chromium): an outsider sees the lock form
  without the title, a wrong password is refused, the right one unlocks the
  page, the access cookie is not readable by page script, and no CSP
  violation occurs on these pages.

## Limits
- A share link is a bearer URL: anyone it is forwarded to can use it until it
  expires or is revoked.
- Rate limits use the client address only behind a trusted proxy
  (`TRUST_PROXY`), as for sign-in; otherwise only the per-page limit applies.
