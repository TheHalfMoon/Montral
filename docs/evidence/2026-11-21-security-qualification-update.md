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

## Codex Security Workbench scan status

The earlier local Standard scan remains preserved as incomplete and is not a clean-scan result:

- Its Workbench context reported `running`, phase `reporting`, and `reportAvailable: false`; it remained at zero of one report artifacts.
- Read-only diagnostics supplied for its recovery recorded SQLite integrity as OK, Workbench `completed_at` as null, a saved manifest that says completed, and zero recorded findings. Those facts do not amount to a completed scan.
- Its original `complete-scan` call timed out after 300 seconds. A supported same-scan rejoin did not return a continuation token. The scan was not retried, failed, or edited.
- These symptoms are consistent with [openai/codex#42122](https://github.com/openai/codex/issues/42122), which documents rollout-usage collection stalling before the Workbench completion commit. The exact local timeout cause remains unproven.
- Its recorded coverage was selective: 8 named source files from a 1,042-file inventory, no application execution, no independent reviewer and no live provider or production validation. Its empty findings document is not a zero-vulnerability conclusion.

A separate fresh, non-forked Standard scan was then completed in an isolated, clean worktree at exact `99556c862c7a68c3fd5b957023eae0d8ebd9a1a7`:

- Owning-thread readback confirmed Workbench status `complete`, reporting phase, all 3/3 report artifacts committed, a generated `report.md`, and `resultsRecoveryNeeded: false`. `scan-manifest.json`, `findings.json` and `threatmodel.md` were also confirmed present.
- Explicit coverage records show 7/7 review workstreams closed across 1,046 indexed files. The report states that this was not a line-by-line review of every file.
- No reportable findings were recorded by this source-only scan. It did not execute application code or tests, access external providers or production data, or provide an independent external assessment. Do not interpret its result as proof that the repository has zero vulnerabilities.

The fresh scan is usable as a completed, bounded source-review record with the limitations above. Keep the earlier scan preserved separately as incomplete; do not use it as release evidence or merge it with the fresh result.

## Release status

Community publication remains **HOLD**. Montral Cloud and Enterprise BYOC remain **NO-GO**. No release, deployment, production credential change, billing activation or external publication was performed. CI success, zero open alert snapshots or the completed bounded source scan do not replace owner/provider verification, qualified independent security assessment, legal/privacy approval or the owner's explicit `GREEN LIGHT MONTRAL`.
