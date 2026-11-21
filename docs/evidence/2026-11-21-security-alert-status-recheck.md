# Security alert and historical secret-pattern recheck - 2026-11-21

## Scope and revision

Checked `TheHalfMoon/Montral` at exact `main@b80330189b3fcf772c07510fda3e6042d5b27a5b`. This was the documentation-only merge of PR #182; the qualified product revision remains `d36160b83c261839f8e0ff5e3b3cfcc2a39bf36d`.

All 12 exact-SHA push workflows passed on `b803301`:

| Workflow | Run |
|---|---:|
| Source integrity | [44885212114](https://github.com/TheHalfMoon/Montral/actions/runs/44885212114) |
| Windows Docker prerequisite safety | [44885212218](https://github.com/TheHalfMoon/Montral/actions/runs/44885212218) |
| Browser checks | [44885212267](https://github.com/TheHalfMoon/Montral/actions/runs/44885212267) |
| Terraform provider | [44885212260](https://github.com/TheHalfMoon/Montral/actions/runs/44885212260) |
| Upgrade, rollback, disaster recovery | [44885212127](https://github.com/TheHalfMoon/Montral/actions/runs/44885212127) |
| Cross-browser and accessibility | [44885212204](https://github.com/TheHalfMoon/Montral/actions/runs/44885212204) |
| Failover | [44885212117](https://github.com/TheHalfMoon/Montral/actions/runs/44885212117) |
| Docker Compose | [44885212319](https://github.com/TheHalfMoon/Montral/actions/runs/44885212319) |
| App CI | [44885212225](https://github.com/TheHalfMoon/Montral/actions/runs/44885212225) |
| macOS PostgreSQL 18 | [44885212135](https://github.com/TheHalfMoon/Montral/actions/runs/44885212135) |
| Load qualification | [44885212101](https://github.com/TheHalfMoon/Montral/actions/runs/44885212101) |
| CodeQL code scanning | [44885212172](https://github.com/TheHalfMoon/Montral/actions/runs/44885212172) |

## Native security settings and alert-read limits

The repository is public. Repository metadata reports Dependabot security updates enabled, secret scanning enabled, and secret scanning push protection enabled. `GET /repos/TheHalfMoon/Montral/vulnerability-alerts` returned HTTP 204, confirming Dependabot vulnerability alerts are enabled. Metadata reports secret scanning non-provider patterns and secret-scanning validity checks disabled.

The available reads of open CodeQL alerts, CodeQL analyses, Dependabot alerts, and secret-scanning alerts returned HTTP 404. These responses do not prove that any alert list is empty. Current open alert counts therefore remain unknown from this read path. The CodeQL workflow itself is active: `.github/workflows/codeql.yml` is unchanged, the exact-main CodeQL run above succeeded, and its logs confirm uploaded analyses for JavaScript/TypeScript, Python, Go, and Actions. Default setup remains `not-configured`, by design for the existing advanced workflow; no setup switch was made.

Issue #183 reports 25 open CodeQL alerts on this main revision: 19 high and 6 medium by scanner severity. Per-alert SARIF with paths and data-flow locations is not available in the workflow artifacts or current alert read path. No individual finding is confirmed, dismissed, or called a false positive in this note; per-alert validation remains pending SARIF.

## Historical secret-pattern recheck

The checkout was non-shallow and contained 388 reachable commits. Gitleaks 8.30.1 was downloaded from the official release, and the Windows archive SHA-256 matched the release digest `d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e`.

The full reachable history produced 65 pattern matches in 6 commits and 10 files. Rule counts were `generic-api-key` 51, `curl-auth-header` 10, `discord-api-token` 1, `private-key` 2, and `sentry-access-token` 1. All 65 matches are in commits at or before the archived baseline `dc02d027768c2ee9c9d1c05d98e1d1832cef36a4`; the 224 commits after that baseline produced zero matches. The history-gate tests passed 9/9.

The current-tree Gitleaks gate found 21 exact reviewed synthetic-fixture matches, with zero unexpected matches and zero stale approvals. Its decision tests passed 12/12. The full-history Gitleaks report was kept only in a temporary directory and deleted after aggregate review. No matched values or source snippets were printed or retained.

These Gitleaks findings are pattern matches, not proof that every match is a credential. The prior evidence documents examples and manifest checksums; an archived vendor-example hexadecimal value remains unverified with its owner/provider. Its status must not be assumed live or safe. No credential was changed, revoked, or rotated.

## Release status

Issue #169 remains open pending native alert visibility and owner/provider verification of the historical vendor example. Issue #183 remains open pending individual SARIF-based CodeQL triage. CI success and enabled settings are not proof of security or zero alerts. Community publication remains HOLD; Cloud and BYOC remain NO-GO. No release, deployment, billing, or production-credential change was performed.

## Follow-up recheck after #186 — `main@98239eafb6ba29e7ed73e224e4e5dc281e2c16d2`

The earlier API 404s and SARIF unavailability above are historical observations from `b803301`. On `98239eafb6ba29e7ed73e224e4e5dc281e2c16d2`, the CodeQL workflow [44899983350](https://github.com/TheHalfMoon/Montral/actions/runs/44899983350) succeeded, and all 12/12 exact-SHA push workflows passed; the fail-closed verifier confirmed the exact `push` run records. See the per-workflow run table in [release gates](../RELEASE-GATES.md).

At base `50ebcd65f5b34bef07b03126f60f71ea647c8e16`, the GitHub alert API returned 25 open findings. After #186 merged and the exact-main scan completed, alerts #1, #12, and #15–#23 were marked fixed (11 total). The other 14 (#2–#11, #13–#14, #24–#25) were individually dismissed as false positives with source-based comments. The resulting open CodeQL alert API returned zero; dismissed and fixed states were verified separately. The exact-main SARIF analysis IDs were JavaScript/TypeScript `2220619218`, Actions `2220615884`, Go `2220616536`, and Python `2220616974`; counts were 14, 0, 0, and 0 results respectively. Full per-alert reasoning is in [CodeQL alert triage](2026-11-21-codeql-alert-triage.md).

Dependabot alert and secret-scanning alert API reads now succeed and each returned zero open alerts. Dependabot vulnerability alerts and security updates remain enabled, as do secret scanning and push protection; non-provider secret patterns remain disabled. These are alert-system snapshots only. The historical full-history Gitleaks record is unchanged: 65 matches in 6 commits and 10 files at/before the baseline; the archived vendor example still awaits owner/provider verification, so #169 remains open. No production credential was rotated. No independent external security review or penetration test was completed. Community publication remains HOLD; Cloud and BYOC remain NO-GO.
