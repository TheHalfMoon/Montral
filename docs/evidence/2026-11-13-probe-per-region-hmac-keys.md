# Optional per-region HMAC credential isolation (proposed)

**Status:** Proposed until the exact pull-request head passes all required hosted checks and is merged. No production probe, API, key, deployment, billing account or stored credential was changed.

## Motivation and scope

Montral formerly used one deployment-wide `PROBE_SECRET` for every on-demand probe. A compromise of one probe's signing secret could authenticate probes at all other regions using that same key. The new optional **scheduler-side private** environment variable `PROBE_SECRETS` maps configured region IDs to distinct HMAC signing keys. Each entry's value is the `PROBE_SECRET` configured privately on that region's own probe. The public `PROBE_REGIONS` remains a map of region IDs to endpoints/labels only; API/UI/MCP listings do not expose either signing key.

## Compatibility, security and rollout

- Backward-compatible: when `PROBE_SECRETS` is absent, all configured regions continue to use the legacy global `PROBE_SECRET`. A region with a dedicated entry exclusively uses that key, not the shared one. An omitted entry may still use `PROBE_SECRET` as a fallback. For full isolation, set every regional key and unset global `PROBE_SECRET`.
- No-key regions are not advertised or queried. If `PROBE_SECRETS` is present but invalid, **all remote regions** are disabled, even when the global key is configured. This prevents a malformed isolation config from silently downgrading to the shared key.
- The strict parser accepts only a JSON object of known configured region IDs and string keys with 16-4096 characters, no leading/trailing whitespace; unknown regions, wrong types, short/oversized keys, malformed JSON and arrays fail closed. Config error logs contain a fixed message and no raw key strings or user-provided region identifiers.
- Probe signature format, timestamp skew, request body, reply bounds, SSRF/egress restrictions and existing probe-side expiring previous-key rotation are unchanged. The API signs a specific region with its current key and **never** sends signatures with its previous key.
- Operators provision each probe and the API private map separately, test a signed request in every region, and rotate each key using the probe-side expiring-previous-key workflow. No automatic rotation, per-region operator registration, attestation or revocation API is claimed.
- A multi-region deployment that shares one runtime environment (for example multiple Vercel region functions in one project) does **not** gain isolation unless the probes are deployed with independently scoped keys/projects. It is a configuration capability, not evidence of installed isolated probes.

## Local validation on Windows, 2026-11-13

- `pnpm --filter @montral/api exec vitest run src/regions.test.ts src/probe-reply-privacy.test.ts src/guards/env-docs.test.ts src/guards/browser-runtime.test.ts`: **39/39 PASS**. These include new negative tests for invalid/unknown credentials, missing default, private key omission from public listing and signature isolation against a wrong regional/shared key.
- `pnpm --filter @montral/api exec vitest run src/regions-confirm.test.ts src/scheduler.test.ts src/http-request.test.ts src/json-assertion.test.ts src/probe-reply-privacy.test.ts`: **149/149 PASS**. Together with focused suite: 188/188 passed before the final whitespace-key negative case; the focused suite will be rerun after that change.
- `pnpm --filter @montral/api typecheck`: **PASS**.
- `git diff --check`: **PASS**.
- Source guards updated so server-side `PROBE_SECRETS` is recognized as sensitive and is passed from Docker privately, not bundled in browser-runner environment. Docker compose example is operator-owned and opt-in.
- Local Node runtime v24.19.0 is **below** repository-supported ^24.22.1; hosted supported-runtime checks, PostgreSQL suites, real browser and macOS qualification are authoritative.

## Remaining blockers

- Registration, automatic provisioning, key escrow/revocation API, cryptographic region identity attestation and independent penetration testing remain open.
- No user-visible service was deployed or published, no external provider test was authorized. Community publication remains HOLD. Cloud and Enterprise BYOC external gates remain NO-GO.
