# Public-route Cloud availability and native-app copy audit (2026-11-16)

**Status:** source correction under GitHub PR qualification. This record is not release, legal, privacy, security or deployment approval.

## Finding

The earlier hosted policy/marketing corrections did not cover all shared Astro entry points. These routes continued to describe an active hosted service despite Montral being Web-first and Community self-hostable, with no public Cloud deployment:

- `/alternatives`: introductory FAQ advertised a hosted service.
- `/alternatives/:tool` and `/for/:segment`: reusable call-to-action text offered immediate hosted signup in English and Chinese.
- `/alternatives/uptime-kuma`: the page description advertised a hosted option without saying that Cloud was not public.
- `/changelog`: the introduction and edition panel presented the Cloud edition as a currently operating hosted service.
- `/docs/regions`: a hosted plan and already-provisioned probes were described as active. The Chinese text also invented a hard cap of ten regions for Community despite the API returning `maxPerMonitor: null` when no plan quota applies.
- `/docs/self-host`: the Chinese APNs documentation still referred to an official distributed Montral native app, contradicting the English correction and the current Web-first/PWA-only distribution.

This is inconsistent source copy, **not** evidence of customer signup, Cloud deployment or misuse.

## Engineering changes

- Correct the above routes in both English and Chinese to state that Community can be self-hosted and Cloud is **not publicly available**; future hosted plan and probe infrastructure is conditional, not launched.
- Keep the historical Cloud changelog entries as engineering history while clarifying that they are not evidence of a live hosted service.
- Remove the unsupported fixed Community region limit and match the actual API plan-quota behavior.
- Align the Chinese APNs warning with English: no official signed native app is shipped; a self-hosted operator must separately build and sign a compatible client.
- Add `prelaunch-route-claims.test.ts` to reject the stale claims.

## Qualification and release policy

Local static checks: `git diff --check` and `node --check` on the focused Vitest source passed. Full Astro builds, localization checks and exact-head CI must pass before merge, followed by integrated-main push qualification. The available Windows Node version is 24.19.0, below the project's supported 24.22.1 floor, so no complete local build or browser qualification is claimed. PR #163 separately verifies the rendered noindex behavior of hosted legal drafts.

No API, billing provider, credentials, database, customer data, commercial pricing, DNS, publication or deployment is changed. Community publication remains HOLD until explicit `GREEN LIGHT MONTRAL`; Cloud/BYOC remain NO-GO pending independent security, legal/privacy, provider and production infrastructure gates.
