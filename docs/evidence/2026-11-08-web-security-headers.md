# Self-hosted web pages had no framing or CSP baseline

## Failure mode
The Node process served the Astro build (app, sign-in, password reset,
OAuth consent) with no `frame-ancestors`/`X-Frame-Options`, `nosniff`,
referrer or permissions policy. Any site could frame the signed-in app or
the OAuth consent screen and overlay it (clickjacking: "Delete monitor",
"Authorize agent"), and an injected `<base>` or `<object>` had no policy
restraint.

## Change
`applyWebSecurityHeaders` runs for every non-API request in `server.ts`:
`Content-Security-Policy: base-uri 'self'; object-src 'none';
form-action 'self'; frame-ancestors 'none'` plus `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin` and a restrictive `Permissions-Policy`.
Public status pages (`/status/*`, also locale-prefixed) keep
`frame-ancestors *` so operators can show them in their own dashboards.
A header a handler already set (for example a stricter referrer policy on
reset pages) is not overridden. No script/style policy is set: pages carry
inline scripts and optional fonts/analytics, and a script policy needs
hashing first. No page uses a native form that redirects off-origin
(GitHub sign-in is a script navigation), so `form-action 'self'` is safe.

## Evidence and limits
`web-security-headers.test.ts` checks the policy per path and asserts the
real headers on a live Node HTTP response, including no override of a
handler's value. API responses (Hono) are unchanged. The Cloudflare build
is out of scope. A script-src policy remains future work.
