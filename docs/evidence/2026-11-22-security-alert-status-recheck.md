# Security alert and historical secret-pattern recheck — 2026-11-22

## Scope and result

Read-only checks were made against public repository `TheHalfMoon/Montral` at `main@6b19bdf661caad4fa3b21de23ae9239c4e9ad078` on 2026-11-22. GitHub's open-alert endpoints returned:

| Alert source | Open records |
|---|---:|
| CodeQL code-scanning alerts | 0 |
| Dependabot alerts | 0 |
| Secret-scanning alerts | 0 |

Repository metadata reported Dependabot security updates, secret scanning and secret-scanning push protection enabled. `GET /repos/TheHalfMoon/Montral/vulnerability-alerts` returned HTTP 204, confirming Dependabot vulnerability alerts are enabled. The metadata response did not report Advanced Security as enabled; the existing advanced CodeQL workflow remains configured and the exact-main CodeQL run succeeded. The CodeQL workflow configuration was unchanged from the qualified predecessor SHA.

The metadata response did not expose a status for non-provider secret-pattern scanning or secret validity checks. Earlier evidence records those additional checks as disabled; no settings were changed in this recheck.

This is a point-in-time alert-state observation. Zero open records and successful workflows do not establish that Montral is secure. No alert contents were exported or altered, and no security setting was changed.

## Exact-main qualification

The repository's fail-closed `scripts/verify-main-workflows.py` passed for all 12 required push workflows on `6b19bdf661caad4fa3b21de23ae9239c4e9ad078`. The exact run IDs are recorded in [RELEASE-GATES.md](../RELEASE-GATES.md). PR #201 merged as `6b19bdf` after all 23 exact-head checks passed; this PR adds secret-free, append-only audit records for operator probe-validation attempts.

## Remaining historical secret concern

The full-history Gitleaks evidence remains 65 pattern matches across six old commits and ten files. The archived vendor-example match is byte-identical to a pinned upstream sample, establishing sample provenance only. It does not establish whether any deployment used the value, whether a credential was created, or whether it is valid or was rotated. No credential was tested, used, revoked or changed. The owner/provider verification in [issue #169](https://github.com/TheHalfMoon/Montral/issues/169) remains outstanding; keep that issue open.

The previously incomplete Codex Security Workbench scan remains preserved as incomplete. No fresh Workbench scan was run as part of this recheck. The separate bounded scan evidence is not a line-by-line or runtime assessment.

Community publication remains HOLD. Cloud and BYOC remain NO-GO. No release, deployment, production credential change or paid feature was authorized by this recheck.
