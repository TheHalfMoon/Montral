# Security qualification update — 2026-11-21

This evidence updates the earlier `07abcfaf438731afbf4da679ef7e55e252b6514e` checkpoint after documentation-only PR #188 merged. The verified product-code baseline is `main@99556c862c7a68c3fd5b957023eae0d8ebd9a1a7`; this evidence document records scanner and CI results for that baseline, not release authorization.

## Exact-main workflows

All 12 required `push` workflows completed successfully on exact `main@99556c862c7a68c3fd5b957023eae0d8ebd9a1a7`:

| Workflow | Run |
|---|---:|
| Montral load qualification | [44925891646](https://github.com/TheHalfMoon/Montral/actions/runs/44925891646) |
| Montral macOS PostgreSQL 18 qualification | [44925891632](https://github.com/TheHalfMoon/Montral/actions/runs/44925891632) |
| Montral app CI | [44925891607](https://github.com/TheHalfMoon/Montral/actions/runs/44925891607) |
| Montral upgrade, rollback and disaster recovery | [44925891608](https://github.com/TheHalfMoon/Montral/actions/runs/44925891608) |
| Montral Docker Compose qualification | [44925891801](https://github.com/TheHalfMoon/Montral/actions/runs/44925891801) |
| Montral source integrity | [44925891624](https://github.com/TheHalfMoon/Montral/actions/runs/44925891624) |
| Windows Docker prerequisite safety | [44925891716](https://github.com/TheHalfMoon/Montral/actions/runs/44925891716) |
| Montral browser checks | [44925891692](https://github.com/TheHalfMoon/Montral/actions/runs/44925891692) |
| Montral Terraform provider | [44925891734](https://github.com/TheHalfMoon/Montral/actions/runs/44925891734) |
| Montral CodeQL code scanning | [44925891754](https://github.com/TheHalfMoon/Montral/actions/runs/44925891754) |
| Montral failover qualification | [44925891827](https://github.com/TheHalfMoon/Montral/actions/runs/44925891827) |
| Montral cross-browser and accessibility | [44925891689](https://github.com/TheHalfMoon/Montral/actions/runs/44925891689) |

The exact-SHA `push` records were read with `gh run list`. The repository's fail-closed `scripts/verify-main-workflows.py` passed: `12 exact-main push workflows successful` for this SHA. These runs qualify this SHA only.

## CodeQL triage and GitHub alert state

Issue [#183](https://github.com/TheHalfMoon/Montral/issues/183) is closed after the 25 earlier CodeQL records received source-based dispositions: 11 were fixed and 14 were individually dismissed as false positives with supporting evidence. The exact-main CodeQL workflow above succeeded. The latest explicit open-alert snapshot recorded on `99556c8` returned zero open CodeQL, Dependabot and secret-scanning alerts. Prior verification recorded Dependabot alerts and security updates, secret scanning and push protection as enabled. These are point-in-time alert and configuration facts, not proof that the repository has no vulnerabilities. The advanced CodeQL workflow remains configured; #188 did not change it. Detailed CodeQL evidence remains in [the triage record](2026-11-21-codeql-alert-triage.md).

## Historical Gitleaks findings

The most recent full-history review recorded 65 pattern matches across 6 commits and 10 files, all at or before archived baseline `dc02d027768c2ee9c9d1c05d98e1d1832cef36a4`. The safe aggregate classification is:

- 42 source-manifest checksum-pattern matches across three donor groups;
- 10 documentation authorization-header examples;
- 10 synthetic test or upgrade fixtures;
- 2 APNs test-only ephemeral key-generation code matches;
- 1 opaque 32-character hexadecimal value in `laravel-echo-server.json.example`, under `clients[0].key`.

Git history shows this file entered the repository in the archived vendor donor snapshot from Webhook.site commit `96b7b4275b4481eedd8a3f052aa44642eb3b4ae2`. A metadata-safe comparison against that upstream file found the archived example byte-for-byte identical, including the `clients[0].key` field; the matched value was never printed or retained. This establishes that the pattern came from the upstream sample. It does not show whether a deployment used that sample as an operational credential or whether any resulting credential was rotated. Only the credential owner/provider can establish those facts. No credential was tested, changed, revoked or rotated. The scanner's raw historical report was not retained.

On exact `main@99556c8`, source-integrity run [44925891624](https://github.com/TheHalfMoon/Montral/actions/runs/44925891624) reported 229 post-baseline commits and zero new historical matches. Its current-tree scan reported 21 reviewed fixtures, zero unexpected matches and zero stale approvals. This gate prevents new matches in its configured scope; it does not clear the historical vendor example or prove that it was never operational.

Issue [#169](https://github.com/TheHalfMoon/Montral/issues/169) remains open for owner/provider verification of that historical example and remaining independent release-security evidence. The issue's existing history review and the prior full-history findings are preserved.

## Incomplete local Codex Security scan

A separate local Codex Security Standard scan remains incomplete and is not release evidence:

- The Workbench context still reports `running`, phase `reporting`, and `reportAvailable: false`; it records a zero-of-one report-artifact phase and `resultsRecoveryNeeded: false`.
- Read-only diagnostics supplied for the recovery recorded SQLite integrity as OK, Workbench `completed_at` as null, and a saved manifest that says completed. The saved findings document contains zero recorded findings. Those facts do not amount to a completed Workbench scan.
- The original `complete-scan` call timed out after 300 seconds. A supported same-scan rejoin did not return a continuation token. No completion retry, SQLite mutation, lock removal or artifact rewrite was performed.
- These symptoms are consistent with [openai/codex#42122](https://github.com/openai/codex/issues/42122), which documents rollout-usage collection stalling before the Workbench completion commit. The local timeout's exact internal cause remains unproven.
- The scan's recorded coverage was selective: 8 named source files from a 1,042-file inventory, no application execution, no independent reviewer and no live provider or production validation. Its empty findings document is not a zero-vulnerability conclusion.

The original scan remains preserved as incomplete. Any future Codex Security scan must run in a fresh, non-forked task with a separate isolated worktree and an explicitly verified commit. Accept it only after Workbench reports completion, a report is available, and its coverage is recorded. Do not use the incomplete scan to satisfy release gates.

## Release status

Community publication remains **HOLD**. Montral Cloud and Enterprise BYOC remain **NO-GO**. No release, deployment, production credential change, billing activation or external publication was performed. CI success and zero open alert snapshots do not replace owner/provider verification, qualified independent security assessment, legal/privacy approval or the owner's explicit `GREEN LIGHT MONTRAL`.
