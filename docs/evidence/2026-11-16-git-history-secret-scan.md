# Git-history source-secret check after archived baseline — 2026-11-16

**Status:** new zero-cost security CI control under exact-head qualification, not independent security approval, release or deployment authorization.

## Why a history check is needed

The current merged source-integrity workflow (PR #173) checks the **current working tree** with pinned Gitleaks v8.30.1. A malicious or accidental token introduced in an earlier PR commit and deleted in a later PR commit can be absent from the final checkout while still retrievable from public Git history.

On 2026-11-16, a **full, non-shallow checkout of main@fa6bce896d91ed7a01a9b703aa17abfa6e5e046b** had **352 reachable commits**. An offline Gitleaks v8.30.1 scan of the complete reachable Git history returned **65 historic pattern matches in 10 files introduced in six older commits**. The report was handled locally without printing any matched value and deleted after aggregation. Findings included test/example credentials and **42 matches in an archived source manifest** containing 638 SHA-256 file checksums. Two other findings were in archived vendor sample/test files; the historical vendor example contains a high-entropy-looking hexadecimal placeholder whose live status **cannot be verified from source alone**. Its historical presence must not be treated as a valid production credential or dismissed as proven safe; the owner/provider may need to investigate and rotate any credential actually used. See issue #169.

The archived source baseline was pinned to full commit **`dc02d027768c2ee9c9d1c05d98e1d1832cef36a4`**; in the complete repository there were **188 subsequent commits** up to `fa6bce8`. A separate Gitleaks Git-range scan of `dc02d027768c2ee9c9d1c05d98e1d1832cef36a4..HEAD` found **zero newly introduced secret patterns**. The historical 65 findings are **not approved, erased or counted clean** by the new gate; they are separately tracked, while the new gate prevents *new* history leaks after the archived boundary.

## CI engineering

- Extend the existing `.github/workflows/source-integrity.yml` job, retaining `permissions: contents: read`. Set `actions/checkout@v4` to **`fetch-depth: 0`**, so CI has all ancestor commits and does not silently scan a shallow snapshot.
- Reuse the already pinned, SHA-256-verified, locally executed Gitleaks v8.30.1 binary from PR #173.
- After the existing working-tree scanner, run the new **`node --test scripts/verify-secret-history.test.mjs`** and **`node scripts/verify-secret-history.mjs`**.
- Fail closed if Git history is shallow, the full historical baseline commit is missing or is not an ancestor of `HEAD`, Git operations fail, Gitleaks exits abnormally/times out, or report/status metadata is inconsistent.
- Run Gitleaks against **every reachable commit after the pinned archived source baseline** using `git --log-opts=<baseline>..HEAD`, rather than hiding historical detections with broad folder or pattern exclusions.
- Any new committed match makes CI fail, even if later removed from the final working tree. Log only count, commit prefix, file/line and rule; never matched content or raw reports. The raw scanner report lives in a temporary directory that is removed unconditionally.

## Local tests and adversarial proof

- **9/9 dependency-free Node unit tests passed**, covering no findings, new findings, malformed/missing JSON, incomplete metadata, mismatched exit codes, timeouts, and a pinned 40-character Git SHA.
- A truly complete `git rev-parse --is-shallow-repository=false` checkout passed the live historical scanner: `HISTORY_SECRET_SCAN_COUNTS commits_after_baseline=188 new_matches=0`.
- **Negative control against actual Git commits**: created a disposable local worktree and committed a synthetic fixture that matches an existing test-only generic token rule. The scanner examined **189 commits after the baseline**, detected **one newly committed match** and exited **1** (`HISTORY_SECRET_SCAN_BLOCKED`). The disposable checkout was removed, without pushing its synthetic commit to GitHub.
- The scan's raw findings were always deleted after aggregate inspection. No new production keys, customer data, external scanner API, payment provider, DNS or service deployment was involved.

## Limits / release

This protects the **post-baseline Git history reachable from checked-out `HEAD`** plus the separate current-tree scan. It does not clear the **65 previously observed historical matches**, scan other branches outside `HEAD`, enable native GitHub secret scanning, detect arbitrary unknown formats, or replace independent security auditing. Historic vendor example ownership/provider status remains a documented research item under issue #169. The Gitleaks version and SHA-256 are pinned in CI; future scanner-rule upgrades need refreshed evidence rather than accidental broad suppression.

Merge requires first-party technical review, **16/16 exact-head PR checks**, then **11/11 exact integrated-main push workflows**; historical pass results do not qualify a new head. Community publication remains **HOLD until explicit owner `GREEN LIGHT MONTRAL`**. Cloud/BYOC remain **NO-GO** pending legal/privacy, external security, provider, operations and real-device requirements.
