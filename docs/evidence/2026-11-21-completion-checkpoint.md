# Montral completion checkpoint — 2026-11-21

## Current main and required workflows

Fetched `origin/main` and confirmed exact `main@07abcfaf438731afbf4da679ef7e55e252b6514e`. All 12 required push workflows completed successfully on this exact SHA:

| Workflow | Run |
|---|---:|
| App CI | [44904039791](https://github.com/TheHalfMoon/Montral/actions/runs/44904039791) |
| Load qualification | [44904039637](https://github.com/TheHalfMoon/Montral/actions/runs/44904039637) |
| Browser checks | [44904039694](https://github.com/TheHalfMoon/Montral/actions/runs/44904039694) |
| Windows Docker safety | [44904039646](https://github.com/TheHalfMoon/Montral/actions/runs/44904039646) |
| Cross-browser/accessibility | [44904039770](https://github.com/TheHalfMoon/Montral/actions/runs/44904039770) |
| macOS PostgreSQL 18 | [44904039635](https://github.com/TheHalfMoon/Montral/actions/runs/44904039635) |
| Failover | [44904039645](https://github.com/TheHalfMoon/Montral/actions/runs/44904039645) |
| Upgrade/rollback/DR | [44904039642](https://github.com/TheHalfMoon/Montral/actions/runs/44904039642) |
| Terraform provider | [44904039543](https://github.com/TheHalfMoon/Montral/actions/runs/44904039543) |
| Source integrity | [44904039644](https://github.com/TheHalfMoon/Montral/actions/runs/44904039644) |
| Docker Compose | [44904039760](https://github.com/TheHalfMoon/Montral/actions/runs/44904039760) |
| CodeQL | [44904039633](https://github.com/TheHalfMoon/Montral/actions/runs/44904039633) |

These workflows qualify that commit only. They do not establish security clearance, native Safari or VoiceOver behavior, external provider correctness, or production readiness.

## GitHub security state

The latest verified GitHub snapshot reported zero open CodeQL, Dependabot, and secret-scanning alerts; the CodeQL history had 11 fixed and 14 dismissed findings. Dependabot vulnerability alerts/security updates, secret scanning/push protection, and private vulnerability reporting were enabled. Non-provider secret-pattern scanning and validity checks remained disabled. Counts are point-in-time tool records, not proof that the source is secure.

#183 is closed after source validation of the 25 CodeQL records (11 fixes and 14 evidence-backed false-positive dismissals). #169 remains open for historical vendor-example verification and broader release evidence. The GitHub advanced CodeQL workflow is preserved.

## Full-history secret-pattern review

Gitleaks 8.30.1 scanned the full reachable history: 65 pattern matches, across 6 commits and 10 files. Safe aggregate classification:

- 42 matches are in three source-manifest donor groups covering 638 file/checksum records; their structure identifies these as checksum-pattern matches.
- 10 are documentation curl authorization-header examples.
- 10 are synthetic test or upgrade fixtures.
- 2 are APNs test-only ephemeral key-generation code.
- 1 is an opaque 32-character hexadecimal `clients[0].key` in an archived `laravel-echo-server.json.example`. Whether it was used operationally, valid with a provider, or rotated is **unknown** and can only be established by the owner/provider. It was not tested.

All matches predate the archived baseline. The 228 commits after that baseline had zero new matches. The clean exact-main source archive passed the current scanner gate: 21 reviewed fixtures, zero unexpected, zero stale. Raw scanner output and matched values were not retained or printed. No credential was contacted, changed, revoked, or rotated.

## Open engineering and external gates

- #168 remains blocked: this Windows session has no physical Mac/Safari or iOS hardware. Playwright cross-browser CI does not substitute for native Safari, VoiceOver, or iOS Safari qualification.
- #158 engineering copy changes are present locally: the hosted-plan claim is corrected and draft terms/privacy pages remain marked appropriately. The static Astro build and regression tests passed in the prior work session. Qualified counsel and the owner must still approve legal/privacy facts and any production terms.
- `SECURITY.md` and `CONTRIBUTING.md` are now drafted locally to resolve existing public links to absent files; a regression test checks those links. They still need a reviewed PR and exact-head qualification.
- No independent external penetration test or complete line-by-line security audit is claimed. No release, public publication, deployment, billing activation, or production credential change occurred.

Community publication remains HOLD. Cloud and BYOC remain NO-GO. No owner `GREEN LIGHT MONTRAL` was given.
