# Exact-main CI qualification checkpoint — 2026-11-16

This is a **dated engineering evidence checkpoint**, not authority to publish, tag, deploy, sign, charge users, enable hosted Cloud/BYOC or waive external safety gates.

## Latest confirmed fully qualified exact main at this checkpoint

**`main@fa6bce896d91ed7a01a9b703aa17abfa6e5e046b`** (merging #173, the SHA-256-pinned Gitleaks working-tree source-secret gate) had **all 11/11 exact-SHA GitHub Actions PUSH workflows completed successfully as of 2026-11-16 20:08 Asia/Riyadh**. This was verified with `gh run list -R TheHalfMoon/Montral --commit fa6bce896d91ed7a01a9b703aa17abfa6e5e046b --json databaseId,workflowName,status,conclusion,event`, filtering by `event == push`.

| Workflow | Run ID | Exact merged-main result |
|---|---|---|
| Montral app CI | [43907297764](https://github.com/TheHalfMoon/Montral/actions/runs/43907297764) | SUCCESS |
| Montral browser checks | [43907297847](https://github.com/TheHalfMoon/Montral/actions/runs/43907297847) | SUCCESS |
| Montral cross-browser and accessibility | [43907298004](https://github.com/TheHalfMoon/Montral/actions/runs/43907298004) | SUCCESS |
| Montral Docker Compose qualification | [43907297954](https://github.com/TheHalfMoon/Montral/actions/runs/43907297954) | SUCCESS |
| Montral failover qualification | [43907297901](https://github.com/TheHalfMoon/Montral/actions/runs/43907297901) | SUCCESS |
| Montral load qualification | [43907297831](https://github.com/TheHalfMoon/Montral/actions/runs/43907297831) | SUCCESS |
| Montral macOS PostgreSQL 18 qualification | [43907298033](https://github.com/TheHalfMoon/Montral/actions/runs/43907298033) | SUCCESS |
| Montral source integrity | [43907298007](https://github.com/TheHalfMoon/Montral/actions/runs/43907298007) | SUCCESS |
| Montral Terraform provider | [43907298006](https://github.com/TheHalfMoon/Montral/actions/runs/43907298006) | SUCCESS |
| Montral upgrade, rollback and disaster recovery | [43907297966](https://github.com/TheHalfMoon/Montral/actions/runs/43907297966) | SUCCESS |
| Windows Docker prerequisite safety | [43907297951](https://github.com/TheHalfMoon/Montral/actions/runs/43907297951) | SUCCESS |

The Windows workflow qualifies only prerequisites, not hands-on Windows Docker journeys; cross-browser CI runs hosted engines, not physical iOS Safari or VoiceOver. The old native Safari 8/8 landing result at `dc02d02` is historical and does not qualify revised landing files.

## Previously qualified exact main (historical, not latest)

**`main@4e378620a1035a9c1ddc455ceb4fbf13bebf8390`**, the merge commit for #174's fail-closed dependency audit-report consistency fix, also had **11/11 exact-SHA push workflows SUCCESS**, verified independently on 2026-11-16. It is superseded by `main@fa6bce8`; results do not transfer between commits.

| Historical workflow | Run ID | Result |
|---|---|---|
| Montral app CI | [43899010700](https://github.com/TheHalfMoon/Montral/actions/runs/43899010700) | SUCCESS |
| Montral browser checks | [43899010601](https://github.com/TheHalfMoon/Montral/actions/runs/43899010601) | SUCCESS |
| Montral cross-browser and accessibility | [43899010355](https://github.com/TheHalfMoon/Montral/actions/runs/43899010355) | SUCCESS |
| Montral Docker Compose qualification | [43899010589](https://github.com/TheHalfMoon/Montral/actions/runs/43899010589) | SUCCESS |
| Montral failover qualification | [43899010365](https://github.com/TheHalfMoon/Montral/actions/runs/43899010365) | SUCCESS |
| Montral load qualification | [43899010326](https://github.com/TheHalfMoon/Montral/actions/runs/43899010326) | SUCCESS |
| Montral macOS PostgreSQL 18 qualification | [43899010361](https://github.com/TheHalfMoon/Montral/actions/runs/43899010361) | SUCCESS |
| Montral source integrity | [43899010372](https://github.com/TheHalfMoon/Montral/actions/runs/43899010372) | SUCCESS |
| Montral Terraform provider | [43899010351](https://github.com/TheHalfMoon/Montral/actions/runs/43899010351) | SUCCESS |
| Montral upgrade, rollback and disaster recovery | [43899010354](https://github.com/TheHalfMoon/Montral/actions/runs/43899010354) | SUCCESS |
| Windows Docker prerequisite safety | [43899010388](https://github.com/TheHalfMoon/Montral/actions/runs/43899010388) | SUCCESS |

## Security controls and open gates

- **#170 merged:** scoped transitive esbuild development-server GHSA mitigation; locally patched `pnpm audit --prod --json` returned 0 findings. Not comprehensive vulnerability clearance.
- **#171 merged:** read-only high/critical production-lock dependency-advisory gate in source-integrity CI.
- **#174 merged:** contradictory positive vulnerability counts without advisory records are rejected (#172 resolved).
- **#173 merged:** official SHA-256-pinned Gitleaks v8.30.1 current-tree secret scanner with counted exact-line synthetic-fixture reviews; its exact merged-main source-integrity workflow passed. This scanner does not cover prior Git history.
- **#175 OPEN at this checkpoint:** full commit-history Gitleaks gate, requiring non-shallow checkout and baseline ancestry, scanning every subsequent reachable commit. Local complete-history Windows and exact-head physical Mac arm64 tests passed, including a live committed synthetic secret-pattern negative control. **16/16 exact-head hosted PR checks and then 11/11 exact merged-main push checks remain mandatory.** Evidence: [Git history scan](2026-11-16-git-history-secret-scan.md).
- **#169 OPEN:** native GitHub Dependabot/Code Scanning/secret-scanning alerts disabled/unavailable; full local 352-commit audit detected 65 historical Gitleaks pattern matches in six pre-baseline commits, predominantly test/doc/vendor examples and an old SHA-256 file-integrity manifest. These historical matches are **not approved, revoked, rotated or certified safe** by the proposed gate. An archived vendor-example hexadecimal value needs owner/provider verification if it was ever active. No matching secret values were printed or stored in this note.
- **#168 OPEN:** physical Safari automated landing verification after recent changes remains blocked by the owner-controlled Safari **Allow Remote Automation** setting; old 8/8 runs are historical only.
- **#158 OPEN:** hosted legal/privacy pages remain drafts; independent security/privacy/provider review and owner release approval have not occurred. Community publication **HOLD**. Cloud/BYOC **NO-GO**. External provider reconciliation, credentials, real billing and full device coverage cannot be inferred from synthetic CI.

No production deployment, paid service, merchant, DNS, publishable Docker image, npm release, tag, source-secret disclosure or owner release approval was performed. All subsequent SHA revisions require their own exact-SHA evidence.
