# Exact-main CI qualification checkpoint — 2026-11-16

This is a dated **engineering qualification checkpoint**, not authorization to publish, deploy, sign, tag, charge users, turn on external providers or mark Community/Cloud/BYOC publicly ready.

## Latest confirmed *fully qualified* integrated main at this checkpoint

**`main@4e378620a1035a9c1ddc455ceb4fbf13bebf8390`**, merge commit for security audit report-consistency fix #174, had **11/11 exact-SHA GitHub Actions PUSH workflows completed with success**. Results were retrieved by `gh run list -R TheHalfMoon/Montral --commit 4e378620a1035a9c1ddc455ceb4fbf13bebf8390 --json databaseId,workflowName,status,conclusion,event` and filtered to `push`.

| Workflow | Run ID | Exact commit result |
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

The Windows workflow tests **prerequisites**, not hands-on Windows Docker functional coverage; the cross-browser workflow runs hosted browser engines, not physical iOS Safari or VoiceOver. The old native Safari 8/8 landing result at `dc02d02` must not be carried forward to new landing revisions.

## Newer integrated main that is *not yet 11/11*

At **2026-11-16 20:02 Asia/Riyadh**, `main@fa6bce896d91ed7a01a9b703aa17abfa6e5e046b` (merge of #173's working-tree Gitleaks source-secret gate) had **10/11 exact-SHA push workflows completed successfully** and the macOS PostgreSQL 18 qualification workflow ([43907298033](https://github.com/TheHalfMoon/Montral/actions/runs/43907298033)) still running. Its source-integrity job passed but the overall exact merged commit does **not** inherit #174's complete qualification. Do not label this new SHA 11/11 until the final hosted macOS run completes successfully.

## Security controls and open gates

- **#170 merged:** scoped transitive esbuild development-server GHSA mitigation; local patched `pnpm audit --prod --json` 0 findings. This is a scoped lockfile advisory result, not whole-system vulnerability freedom.
- **#171 merged:** read-only production dependency-advisory high/critical blocking gate in existing source-integrity CI.
- **#174 merged:** fail-closed positive-vulnerability/empty-advisory report validation (#172 resolved). Full 11/11 exact-main push integration verified at `4e378620`.
- **#173 merged:** SHA-256-pinned Gitleaks v8.30.1 current-tree secret scanner with counted, exact-line synthetic-fixture approvals; its source-integrity step passed on `fa6bce8`. This scanner does not cover prior Git history.
- **#175 open at checkpoint:** full Git history Gitleaks gate on top of current-tree scanner, requiring non-shallow checkout, baseline ancestry, scan of every reachable subsequent commit, and denial of any new match. Local full 352-commit Git history audit and exact-head physical Mac ARM64 test passed, but **16/16 hosted PR checks and an 11/11 integrated-main push result remain required** before treating it as merged or qualified. Evidence: [git-history source secret scan](2026-11-16-git-history-secret-scan.md).
- **#169 remains OPEN:** native GitHub Dependabot/Code Scanning/secret-scanning alerts are unavailable or disabled; a 352-commit history scan identified 65 historical Gitleaks pattern matches in six pre-baseline commits, predominantly prior test/doc/vendor examples and a historical file-digest manifest. The 65 historic matches are **not approved, revoked or certified safe** by #175. A historical vendor-example hexadecimal value needs provider/owner investigation if it was ever active. No matched value was printed or written to this note.
- **#168 remains OPEN:** physical Safari automated verification of recent landing changes cannot create WebDriver session until the owner enables the native Safari **Allow Remote Automation** option; previous 8/8 testing applied to a **historical** landing.
- **#158 remains OPEN:** hosted/legal/privacy pages are drafts; independent security/privacy/provider review and owner sign-off for release have not occurred. Community public publication is **HOLD**; Cloud and BYOC **NO-GO**. Live billing, multi-region probe deployment, production operations, external provider reconciliations, secrets and full-platform real-device journeys cannot be inferred from synthetic tests.

No live external service, billable API, DNS, production customer data, hosted merchant account, tag or public release was changed in this checkpoint. All later SHAs require their **own exact-head/merged-main** evidence.
