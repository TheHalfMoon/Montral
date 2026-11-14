# Montral Edge Probe (no production deployment yet)

Montral provides an **on-demand** HTTP edge probe that obeys the existing Montral scheduler's HMAC protocol and response contract, without introducing a second scheduler or monitor store.

Files:
- `apps/probe/src/edge.ts`: Cloudflare Worker fetch entrypoint
- `apps/probe/src/edge.test.ts`: signature/target/keyword/status tests
- `apps/probe/wrangler.edge.jsonc`: example fail-closed config
- `pnpm --filter @montral/probe build:edge`: bundle to untracked `apps/probe/dist/edge.mjs`

Deliberate restrictions (more restrictive than the Node probe):
- Only HTTPS requests to exact hostnames in `ALLOWED_HOSTS`, set privately in Worker variables. Nonstandard HTTPS ports are denied. Default empty allowlist = 503 until configured.
- No IP literals, malformed DNS names, internal suffixes, unknown hosts or redirects. Hop-by-hop, client-identity proxy, Montral signature, arbitrary auth/cookie/host and content-length override headers are denied.
- Only HTTP checks, not TCP or WebSocket from this Edge Worker. Other types still use the existing Montral Node probe.
- HMAC timestamp/signature proof with `PROBE_SECRET` (at least 16 chars), matching Montral core protocol.
- Optional **per-region signing key isolation** (proposed, pending exact-head CI): keep `PROBE_REGIONS` public and use a private API-side `PROBE_SECRETS` JSON map of region ID to dedicated key. Every region's probe uses its own `PROBE_SECRET`. Invalid overrides fail closed rather than falling back to the legacy key, and unkeyed regions stay disabled. See [probe setup](../apps/probe/README.md#separate-signing-keys-per-probe-region-opt-in). This is not automatic secret distribution or an operator registration API.
- Optional **probe-only** staged key rotation: set `PROBE_PREVIOUS_SECRET` together with a valid UTC `PROBE_PREVIOUS_SECRET_EXPIRES_AT` on **every** probe before changing the API `PROBE_SECRET`. The old signature is refused after the expiration even if the key was left configured; missing or malformed expiration fails closed. Never set the previous key on the API. See [probe rotation sequence](../apps/probe/README.md#staged-signing-key-rotation). A shared key remains shared across regions; this is not per-probe credential isolation or a production deployment authorization.
- At most 64 KiB signed requests / 128 KiB response inspection; status and keyword checks yield familiar Montral results.
- Incoming signed envelopes have one 10-second total upload deadline, enforced before signature verification. Oversized input returns the existing JSON 413; an incomplete upload returns JSON 408. Refusal never waits for stream cancellation. Chunk arrival does not renew the deadline, and outgoing keyword/status semantics are unchanged.

The existing backend already supports remote regions through `PROBE_REGIONS` and `PROBE_SECRET` and exposes them in the Montral UI/MCP; the Edge Worker can be configured as a new remote region without changing the scheduler. Signed requests still carry arbitrary monitor headers for historical Node probe compatibility; the Edge worker refuses sensitive/unexpected headers.

**Security caveat:** Hostname allowlists are necessary but not sufficient against DNS rebinding, unexpected corporate routing or compromised infrastructure; never expose an Edge Worker to arbitrary user-supplied target hostnames or treat it as a general-purpose web proxy. Keep Worker private until external security qualification. Cloudflare runtime may have egress/TCP/response limits; validate against real Worker before enabling.

No Cloudflare credentials have been requested or changed and no Worker has been deployed.

## Multi-region confirmation and probe failures

How a monitor that checks from several regions (`regions`, `minRegionsFailing`) decides a run, in `apps/api/src/probes.ts`:

1. Every listed region is asked at once. A region that cannot be asked (probe down, timing out, answering nonsense or
   over 16 KiB, not configured, or drained by an operator) does not vote. It is never counted as a failed check.
2. The run fails when at least `minRegionsFailing` of the regions that answered failed, or a strict majority of them
   when it is 0. The bar is capped by the regions that answered, so a broken probe cannot hide a real outage.
3. **New:** when that capped verdict rests on a single failing region only because the other regions could not vote,
   and the monitor asked for more than one region to agree, the deployment checks the target itself as one more vote.
   If it passes, the run passes (the failing region and the local result are both recorded, and the note says "not
   confirmed from this location"); if it fails, the run fails ("confirmed from this location"); if the deployment
   cannot check either, the region's verdict stands. A monitor that lists `auto` already has that vote. Two or more
   agreeing regions still alert as before.
4. If no region answered at all, the check runs from the deployment itself.

The local check costs no extra credit: it stands in for a region that was charged but could not vote. `failureThreshold`
(consecutive failed runs) applies on top of the run's verdict, so a flapping probe has to fail several runs in a row.

The hosted plan's `regions` limit is enforced when a monitor is created, changed or imported, and also at run time: a
monitor saved under a larger plan (before a downgrade) is checked, and charged, only from the first regions its current
plan allows; its stored list is kept for an upgrade. A metered deployment that cannot read the plan skips multi-region
checks for that round (fail closed); single-region monitors and heartbeats still run. Each skip counts on the monitor's
deferral streak: a single blip marks nothing, but after the same number of intervals as a deferred browser check the
monitor is marked unchecked (shown on the monitor page); its next recorded run clears it. Self-hosted Community has no plan
and is unaffected.

Operators see each region's last answer and can drain a region: [OPERATOR.md, "Probe regions"](OPERATOR.md#probe-regions).

## Workerd qualification (local, not deployed)

The Montral Worker handler and the existing scheduler regional-probe client passed **5 new tests inside real local Cloudflare `workerd`** via Miniflare. These tests use a fake outbound fetch to avoid external traffic. The complete evidence, security restrictions, compatibility-date pin, and limitations are in [2026-10-30 workerd qualification](evidence/2026-10-30-edge-workerd-qualification.md).

Re-run:
```sh
pnpm --filter @montral/api exec vitest run src/edge-cloudflare.workers.test.ts
pnpm --filter @montral/probe test
pnpm --filter @montral/probe build:edge
```

The example `wrangler.edge.jsonc` uses compatibility date `2026-10-13`, the newest supported date in the **pinned** local Miniflare runtime. Do not claim Cloudflare production egress, DNS, quota, pricing or cross-region reliability without a separately authorized deployment.
