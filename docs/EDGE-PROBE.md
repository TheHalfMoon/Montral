# Montral Edge Probe (no production deployment yet)

Instead of running UptimeFlare's second scheduler / D1 monitor store, Montral ports its Cloudflare monitoring patterns into an **on-demand** HTTP probe that obeys the existing Montral scheduler's HMAC protocol and response contract.

Files:
- `apps/probe/src/edge.ts`: Cloudflare Worker fetch entrypoint
- `apps/probe/src/edge.test.ts`: signature/target/keyword/status tests
- `apps/probe/wrangler.edge.jsonc`: example fail-closed config
- `pnpm --filter @montral/probe build:edge`: bundle to untracked `apps/probe/dist/edge.mjs`

Deliberate restrictions (more restrictive than the Node probe):
- Only HTTPS requests to exact hostnames in `ALLOWED_HOSTS`, set privately in Worker variables. Default empty allowlist = 503 until configured.
- No IP literals, internal suffixes, unknown hosts or redirects. No arbitrary proxy/auth/cookie/host headers.
- Only HTTP checks, not TCP or WebSocket from this Edge Worker. Other types still use the existing Montral Node probe.
- HMAC timestamp/signature proof with `PROBE_SECRET` (at least 16 chars), matching Montral core protocol.
- At most 64 KiB signed requests / 128 KiB response inspection; status and keyword checks yield familiar Montral results.

The existing backend already supports remote regions through `PROBE_REGIONS` and `PROBE_SECRET` and exposes them in the Montral UI/MCP; the Edge Worker can be configured as a new remote region without changing the scheduler. Signed requests still carry arbitrary monitor headers for historical Node probe compatibility; the Edge worker refuses sensitive/unexpected headers.

**Security caveat:** Hostname allowlists are necessary but not sufficient against DNS rebinding, unexpected corporate routing or compromised infrastructure; never expose an Edge Worker to arbitrary user-supplied target hostnames or treat it as a general-purpose web proxy. Keep Worker private until external security qualification. Cloudflare runtime may have egress/TCP/response limits; validate against real Worker before enabling.

No Cloudflare credentials have been requested or changed and no Worker has been deployed.
